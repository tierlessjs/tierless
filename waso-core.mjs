// Waso — shared core (IR, interpreter, wire format)
//
// Used by both the single-process spike (waso-spike.mjs) and the two-process
// version (waso-2p-client.mjs / waso-2p-server.mjs) so the mechanism can't
// drift between them. See waso-spike.mjs's header for the design-doc mapping.

// ---------------------------------------------------------------------------
// IR  (WASM-shaped: a stack machine with explicit, numbered locals)
// ---------------------------------------------------------------------------
//
// The program is the hand-lowered form of this "ordinary TypeScript":
//
//   function render(minAge) {
//     const rows = db.query("people");        // server resource
//     const matched = [];
//     for (const row of rows) {
//       if (row.age >= minAge) matched.push(row.name + " (" + row.age + ")");
//     }
//     DOM.renderList(matched);                 // client resource
//     return matched.length;
//   }
//
// Locals: 0=minAge, 1=rows, 2=matched, 3=i, 4=row

export const L = { minAge: 0, rows: 1, matched: 2, i: 3, row: 4 };

// Labeled assembly form: jump targets are label strings, resolved to indices.
function assemble(asm) {
  const labels = {};
  const code = [];
  for (const line of asm) {
    if (typeof line === "string") { labels[line] = code.length; continue; }
    code.push(line.slice());
  }
  for (const ins of code) {
    if ((ins[0] === "JMP" || ins[0] === "JMPF") && typeof ins[1] === "string") {
      if (!(ins[1] in labels)) throw new Error("unknown label " + ins[1]);
      ins[1] = labels[ins[1]];
    }
  }
  return code;
}

export const PROGRAM = {
  render: {
    nlocals: 5,
    code: assemble([
      ["PUSH", "people"],
      ["RES", "db.query", 1],
      ["STORE", L.rows],
      ["NEWARR"],
      ["STORE", L.matched],
      ["PUSH", 0],
      ["STORE", L.i],
      "loop",
      ["LOAD", L.i],
      ["LOAD", L.rows],
      ["GETPROP", "length"],
      ["BIN", "<"],
      ["JMPF", "end"],
      ["LOAD", L.rows],
      ["LOAD", L.i],
      ["INDEX"],
      ["STORE", L.row],
      ["LOAD", L.row],
      ["GETPROP", "age"],
      ["LOAD", L.minAge],
      ["BIN", ">="],
      ["JMPF", "cont"],
      ["LOAD", L.matched],
      ["LOAD", L.row], ["GETPROP", "name"],
      ["PUSH", " ("], ["BIN", "+"],
      ["LOAD", L.row], ["GETPROP", "age"], ["BIN", "+"],
      ["PUSH", ")"], ["BIN", "+"],
      ["ARRPUSH"],
      "cont",
      ["LOAD", L.i], ["PUSH", 1], ["BIN", "+"], ["STORE", L.i],
      ["JMP", "loop"],
      "end",
      ["LOAD", L.matched],
      ["RES", "DOM.renderList", 1],
      ["POP"],
      ["LOAD", L.matched],
      ["GETPROP", "length"],
      ["RET"],
    ]),
  },
};

// ---------------------------------------------------------------------------
// Tiers — each an isolated runtime instance: own heap, own import set.
// ---------------------------------------------------------------------------

export const HANDLE_THRESHOLD = 64 * 1024; // locals larger than this -> §5 handle

export class Tier {
  constructor(id, resources) {
    this.id = id;
    this.resources = resources;      // { name: (args) => value }
    this.heap = new Map();           // id -> object that lives on this tier
    this.nextHeapId = 1;
  }
  has(name) { return name in this.resources; }
  heapPut(obj) { const id = `${this.id}#${this.nextHeapId++}`; this.heap.set(id, obj); return id; }
  heapGet(id) { return this.heap.get(id); }
}

export function isHandle(x) {
  return x !== null && typeof x === "object" && x.__waso_handle__ === true;
}

// ---------------------------------------------------------------------------
// Wire format. Two things JSON gets wrong that only bite across a real
// serialization boundary, both handled explicitly here:
//   - `undefined` array elements silently become `null` through JSON. We tag
//     them so a padded-but-unset local survives the round trip as undefined.
//   - large objects must NOT be copied into the bytes; they become §5 handles
//     into the source tier's heap and stay put.
// ---------------------------------------------------------------------------

const UNDEF = { __waso_undef__: true };

function encodeValue(v, sourceTier) {
  if (v === undefined) return UNDEF;
  if (v === null || typeof v !== "object") return v;        // primitive
  if (isHandle(v)) return v;                                // already a handle
  const bytes = Buffer.byteLength(JSON.stringify(v));
  if (bytes > HANDLE_THRESHOLD) {
    const id = sourceTier.heapPut(v);                       // stays on this tier
    return { __waso_handle__: true, owner: sourceTier.id, id,
             kind: Array.isArray(v) ? "array" : "object",
             length: Array.isArray(v) ? v.length : undefined, bytes };
  }
  return v;                                                 // small enough: copy
}

function decodeValue(v) {
  if (v !== null && typeof v === "object" && v.__waso_undef__ === true) return undefined;
  return v; // handles stay handles; the interpreter derefs them on access
}

// Produce the plain wire object (handles substituted). Caller turns it into
// bytes (for framing/measurement) with JSON.stringify.
export function serializeContinuation(cont, sourceTier) {
  const frames = cont.frames.map((f) => ({
    fn: f.fn,
    ip: f.ip,
    locals: f.locals.map((x) => encodeValue(x, sourceTier)),
    stack: f.stack.map((x) => encodeValue(x, sourceTier)),
  }));
  const pending = cont.pending && {
    name: cont.pending.name,
    args: cont.pending.args.map((x) => encodeValue(x, sourceTier)),
  };
  return { frames, pending };
}

export function deserializeContinuation(wire) {
  const frames = wire.frames.map((f) => ({
    fn: f.fn,
    ip: f.ip,
    locals: f.locals.map(decodeValue),
    stack: f.stack.map(decodeValue),
  }));
  const pending = wire.pending && {
    name: wire.pending.name,
    args: wire.pending.args.map(decodeValue),
  };
  return { frames, pending };
}

export function contBytes(wire) { return Buffer.byteLength(JSON.stringify(wire)); }

// ---------------------------------------------------------------------------
// Interpreter. Runs frames on a tier until it returns or hits a resource it
// doesn't have locally (suspend -> migrate). §3 lazy placement falls out for
// free: we only leave the current tier when forced.
//
// `host.deref(handle)` resolves a §5 handle (locally, or by fetching from the
// owning tier). Injected so single-process and cross-process share this code.
// ---------------------------------------------------------------------------

export class Suspend {
  constructor(frames, pending) { this.frames = frames; this.pending = pending; }
}

function binop(op, a, b) {
  switch (op) {
    case "+": return (typeof a === "string" || typeof b === "string") ? String(a) + String(b) : a + b;
    case "-": return a - b; case "*": return a * b; case "/": return a / b; case "%": return a % b;
    case "<": return a < b; case "<=": return a <= b; case ">": return a > b; case ">=": return a >= b;
    case "===": return a === b; case "!==": return a !== b;
    default: throw new Error("bad binop " + op);
  }
}

export function run(tier, frames, host) {
  const d = (x) => (isHandle(x) ? host.deref(x) : x);
  while (true) {
    const f = frames[frames.length - 1];
    const ins = PROGRAM[f.fn].code[f.ip];
    switch (ins[0]) {
      case "PUSH":   f.stack.push(ins[1]); f.ip++; break;
      case "LOAD":   f.stack.push(f.locals[ins[1]]); f.ip++; break;
      case "STORE":  f.locals[ins[1]] = f.stack.pop(); f.ip++; break;
      case "POP":    f.stack.pop(); f.ip++; break;
      case "NEWARR": f.stack.push([]); f.ip++; break;
      case "ARRPUSH": { const v = f.stack.pop(); const a = d(f.stack.pop()); a.push(v); f.ip++; break; }
      case "NEWOBJ": f.stack.push({}); f.ip++; break;
      case "SETPROP": { const v = f.stack.pop(); const o = d(f.stack.pop()); o[ins[1]] = v; f.stack.push(o); f.ip++; break; }
      case "GETPROP": { const o = d(f.stack.pop()); f.stack.push(o[ins[1]]); f.ip++; break; }
      case "INDEX":  { const i = f.stack.pop(); const a = d(f.stack.pop()); f.stack.push(a[i]); f.ip++; break; }
      case "BIN":    { const b = f.stack.pop(); const a = f.stack.pop(); f.stack.push(binop(ins[1], a, b)); f.ip++; break; }
      case "JMP":    f.ip = ins[1]; break;
      case "JMPF":   { const c = f.stack.pop(); f.ip = c ? f.ip + 1 : ins[1]; break; }
      case "RET":    return { type: "done", value: f.stack.pop() };
      case "RES": {
        const argc = ins[2];
        const args = [];
        for (let k = 0; k < argc; k++) args.unshift(f.stack.pop());
        if (tier.has(ins[1])) { f.stack.push(tier.resources[ins[1]](args)); f.ip++; break; }
        f.ip++; // resume point is AFTER this RES; pending resource runs on arrival
        throw new Suspend(frames, { name: ins[1], args });
      }
      default: throw new Error("bad op " + ins[0]);
    }
  }
}

export function padLocals(args, n) {
  const a = args.slice();
  while (a.length < n) a.push(undefined);
  return a;
}

export function initialFrames(entry, args) {
  return [{ fn: entry, ip: 0, locals: padLocals(args, PROGRAM[entry].nlocals), stack: [] }];
}

// ---------------------------------------------------------------------------
// Shared helpers for the demo.
// ---------------------------------------------------------------------------

export function makeDataset(n) {
  const people = new Array(n);
  // A chunky bio field stands in for "the data needed to reconstruct the result
  // is large" — the megabytes that should NOT cross when we migrate.
  const filler = "x".repeat(100);
  for (let i = 0; i < n; i++) people[i] = { name: "Person " + i, age: i % 100, bio: filler };
  return people;
}

export const fmt = (b) =>
  b >= 1e6 ? (b / 1e6).toFixed(2) + " MB" :
  b >= 1e3 ? (b / 1e3).toFixed(1) + " KB" : b + " B";
