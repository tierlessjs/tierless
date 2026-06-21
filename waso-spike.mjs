// Waso — minimal spike (design doc §11)
//
// Goal: prove the ONE core claim — a continuation captured at a resource
// boundary can be serialized *small*, while the data needed to reconstruct
// the computation stays tier-local. We oscillate a single program between a
// "server" tier (has db.query) and a "client" tier (has DOM.renderList),
// migrating the live continuation across a real wire format (JSON -> bytes),
// and we measure the continuation size against shipping the full result set.
//
// This is deliberately NOT the framework: no TS frontend, no WASM, no tests.
// It is the smallest thing that answers open question #1 ("does the
// continuation actually stay small on real code?"). Run: node waso-spike.mjs
//
// The mechanism follows the doc:
//  - §4.3 resources are imports; a call site to a resource you don't have
//    locally is the migration point (compile-time visible, runtime decision).
//  - §4.4 a migrated continuation ships the resume point + live locals +
//    frame info, and NOT the code or the heap (both tiers run the same module).
//  - §5 heaps are tier-local; locals above a size threshold become opaque
//    handles into the owning tier's heap instead of being copied.

// ---------------------------------------------------------------------------
// 1. The IR  (WASM-shaped: a stack machine with explicit, numbered locals)
// ---------------------------------------------------------------------------
//
// Each function is { nlocals, code }. Instructions are tuples. Resource calls
// (RES) are the only instructions that can suspend/migrate.
//
// The program below is the hand-lowered form of this "ordinary TypeScript":
//
//   function render(minAge) {
//     const rows = db.query("people");        // server resource
//     const matched = [];
//     for (const row of rows) {
//       if (row.age >= minAge) {
//         matched.push(row.name + " (" + row.age + ")");
//       }
//     }
//     DOM.renderList(matched);                 // client resource
//     return matched.length;
//   }
//
// Locals: 0=minAge, 1=rows, 2=matched, 3=i, 4=row

const L = { minAge: 0, rows: 1, matched: 2, i: 3, row: 4 };

const PROGRAM = { render: { nlocals: 5, code: null /* filled in below */ } };

// We write the function in a small labeled assembly form (jump targets are
// label names, resolved to indices) rather than hand-counting offsets.
function assemble(asm) {
  const labels = {};
  const code = [];
  for (const line of asm) {
    if (typeof line === "string") { labels[line] = code.length; continue; }
    code.push(line);
  }
  // resolve JMP/JMPF string targets to indices
  for (const ins of code) {
    if ((ins[0] === "JMP" || ins[0] === "JMPF") && typeof ins[1] === "string") {
      if (!(ins[1] in labels)) throw new Error("unknown label " + ins[1]);
      ins[1] = labels[ins[1]];
    }
  }
  return code;
}

PROGRAM.render.code = assemble([
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
]);

// ---------------------------------------------------------------------------
// 2. Tiers — each is an isolated runtime instance: its own heap and its own
//    import (capability) set. (§4.1 "same module both sides; tiers differ only
//    in which imports are wired up." §7 "client physically cannot call what it
//    isn't given.")
// ---------------------------------------------------------------------------

const HANDLE_THRESHOLD = 64 * 1024; // locals larger than this become §5 handles

class Tier {
  constructor(id, resources) {
    this.id = id;
    this.resources = resources;      // { name: (args)=>value }
    this.heap = new Map();           // id -> object that lives on this tier
    this.nextHeapId = 1;
  }
  has(resourceName) { return resourceName in this.resources; }
  heapPut(obj) { const id = `${this.id}#${this.nextHeapId++}`; this.heap.set(id, obj); return id; }
  heapGet(id) { return this.heap.get(id); }
}

function isHandle(x) { return x !== null && typeof x === "object" && x.__waso_handle__ === true; }

// ---------------------------------------------------------------------------
// 3. Wire format — serialize a continuation to bytes. Large local values are
//    swapped for handles into the *source* tier's heap (so the bytes that
//    cross never contain them). This is the whole point of the measurement.
// ---------------------------------------------------------------------------

function encodeValue(v, sourceTier) {
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

function serializeContinuation(cont, sourceTier) {
  const frames = cont.frames.map((f) => ({
    fn: f.fn,
    ip: f.ip,
    locals: f.locals.map((x) => encodeValue(x, sourceTier)),
    stack: f.stack.map((x) => encodeValue(x, sourceTier)),
  }));
  const pending = {
    name: cont.pending.name,
    args: cont.pending.args.map((x) => encodeValue(x, sourceTier)),
  };
  return Buffer.from(JSON.stringify({ frames, pending }), "utf8");
}

function deserializeContinuation(buf) {
  const o = JSON.parse(buf.toString("utf8"));
  // handles arrive as plain objects already tagged __waso_handle__ — keep them.
  return o;
}

// ---------------------------------------------------------------------------
// 4. The interpreter. Runs frames on a given tier until it returns or hits a
//    resource it doesn't have locally (suspend -> migrate). §3 lazy placement
//    falls out for free: we only ever leave the current tier when *forced*.
// ---------------------------------------------------------------------------

class Suspend {
  constructor(frames, pending) { this.frames = frames; this.pending = pending; }
}

let FETCH_BYTES = 0; // §5 on-demand handle fetches (chattiness made measurable)

function deref(tier, allTiers, x) {
  if (!isHandle(x)) return x;
  const owner = allTiers[x.owner];
  const obj = owner.heapGet(x.id);
  FETCH_BYTES += x.bytes;            // we "fetched" it across the wire
  return obj;
}

function run(tier, allTiers, frames) {
  while (true) {
    const f = frames[frames.length - 1];
    const ins = PROGRAM[f.fn].code[f.ip];
    const op = ins[0];
    switch (op) {
      case "PUSH":   f.stack.push(ins[1]); f.ip++; break;
      case "LOAD":   f.stack.push(f.locals[ins[1]]); f.ip++; break;
      case "STORE":  f.locals[ins[1]] = f.stack.pop(); f.ip++; break;
      case "POP":    f.stack.pop(); f.ip++; break;
      case "NEWARR": f.stack.push([]); f.ip++; break;
      case "ARRPUSH": { const v = f.stack.pop(); const a = deref(tier, allTiers, f.stack.pop()); a.push(v); f.ip++; break; }
      case "GETPROP": { const o = deref(tier, allTiers, f.stack.pop()); f.stack.push(o[ins[1]]); f.ip++; break; }
      case "INDEX":  { const i = f.stack.pop(); const a = deref(tier, allTiers, f.stack.pop()); f.stack.push(a[i]); f.ip++; break; }
      case "BIN":    { const b = f.stack.pop(); const a = f.stack.pop(); f.stack.push(binop(ins[1], a, b)); f.ip++; break; }
      case "JMP":    f.ip = ins[1]; break;
      case "JMPF":   { const c = f.stack.pop(); f.ip = c ? f.ip + 1 : ins[1]; break; }
      case "RET":    return { type: "done", value: f.stack.pop() };
      case "RES": {
        const argc = ins[2];
        const args = [];
        for (let k = 0; k < argc; k++) args.unshift(f.stack.pop());
        if (tier.has(ins[1])) {
          f.stack.push(tier.resources[ins[1]](args));
          f.ip++;
          break;
        }
        // Not local -> capture continuation. Resume point is AFTER this RES;
        // the pending resource (name+args) is run on arrival, result pushed.
        f.ip++;
        throw new Suspend(frames, { name: ins[1], args });
      }
      default: throw new Error("bad op " + op);
    }
  }
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

// ---------------------------------------------------------------------------
// 5. The oscillator: drive the program, migrating whenever it suspends. Each
//    migration goes through the real wire format so the measured bytes are the
//    bytes that would actually cross a socket.
// ---------------------------------------------------------------------------

function oscillate(entry, args, startTier, allTiers) {
  const migrations = [];
  let current = startTier;
  let frames = [{ fn: entry, ip: 0, locals: padLocals(args, PROGRAM[entry].nlocals), stack: [] }];
  let pending = null;

  while (true) {
    try {
      // If resuming from a migration, run the pending resource here first.
      if (pending) {
        const top = frames[frames.length - 1];
        top.stack.push(current.resources[pending.name](pending.args));
        pending = null;
      }
      const result = run(current, allTiers, frames);
      return { value: result.value, migrations };
    } catch (e) {
      if (!(e instanceof Suspend)) throw e;
      // Find the tier that has the needed resource (§4.3 runtime decision).
      const target = Object.values(allTiers).find((t) => t.id !== current.id && t.has(e.pending.name));
      if (!target) throw new Error("no tier provides resource " + e.pending.name);

      const cont = { frames: e.frames, pending: e.pending };
      const buf = serializeContinuation(cont, current);     // <-- the wire
      migrations.push({ from: current.id, to: target.id, resource: e.pending.name, bytes: buf.length });

      const wire = deserializeContinuation(buf);
      frames = wire.frames;
      pending = wire.pending;
      current = target;
    }
  }
}

function padLocals(args, n) { const a = args.slice(); while (a.length < n) a.push(undefined); return a; }

// ---------------------------------------------------------------------------
// 6. Set up the two tiers, generate a large dataset on the server, run it,
//    and report the numbers.
// ---------------------------------------------------------------------------

function makeDataset(n) {
  const people = new Array(n);
  // A chunky bio field stands in for "data needed to reconstruct the result is
  // large" — the megabytes that should NOT cross when we migrate.
  const filler = "x".repeat(100);
  for (let i = 0; i < n; i++) {
    people[i] = { name: "Person " + i, age: i % 100, bio: filler };
  }
  return people;
}

const N = 100_000;
const PEOPLE = makeDataset(N);
const rendered = [];

const server = new Tier("server", {
  "db.query": ([table]) => { if (table !== "people") throw new Error("no table " + table); return PEOPLE; },
});
const client = new Tier("client", {
  "DOM.renderList": ([items]) => { for (const it of items) rendered.push(it); return items.length; },
});
const allTiers = { server, client };

// Cold start on the CLIENT (a user just clicked something). The program will
// be forced to the server by db.query, do all the filtering where the data is,
// then be forced back to the client by DOM.renderList.
const minAge = 99; // selective: keeps ~1% of rows
const { value, migrations } = oscillate("render", [minAge], client, allTiers);

// --- measurements ---
const fullResultBytes = Buffer.byteLength(JSON.stringify(PEOPLE));
const totalCrossed = migrations.reduce((s, m) => s + m.bytes, 0);

const fmt = (b) => b >= 1e6 ? (b / 1e6).toFixed(2) + " MB"
                 : b >= 1e3 ? (b / 1e3).toFixed(1) + " KB"
                 : b + " B";

console.log("Waso spike — continuation size vs. shipping the result set\n");
console.log(`Program: render(minAge=${minAge})  cold-started on the CLIENT tier`);
console.log(`Dataset: ${N.toLocaleString()} rows on the server`);
console.log(`Full result set (if shipped to the client): ${fmt(fullResultBytes)}\n`);

console.log("Migrations (each continuation went through JSON->bytes->JSON):");
for (const m of migrations) {
  console.log(`  ${m.from.padEnd(6)} -> ${m.to.padEnd(6)}  forced by ${m.resource.padEnd(14)}  continuation = ${fmt(m.bytes)}`);
}
console.log("");

const serverToClient = migrations.find((m) => m.from === "server" && m.to === "client");
console.log(`Key claim (§11): the server->client continuation carries the live`);
console.log(`stack, not the heap. The ${N.toLocaleString()}-row array stays server-side as a`);
console.log(`§5 handle; only the ${value} matched strings travel.`);
console.log(`  continuation crossing the wire : ${fmt(serverToClient.bytes)}`);
console.log(`  full result set, had we shipped : ${fmt(fullResultBytes)}`);
console.log(`  ratio                          : ${(fullResultBytes / serverToClient.bytes).toFixed(0)}x smaller`);
console.log("");
console.log(`Total bytes that crossed the wire (both migrations): ${fmt(totalCrossed)}`);
console.log(`On-demand handle fetches (§5 chattiness):           ${fmt(FETCH_BYTES)}`);
console.log("");

// --- correctness check ---
const expected = PEOPLE.filter((p) => p.age >= minAge).map((p) => `${p.name} (${p.age})`);
const ok = value === expected.length &&
           rendered.length === expected.length &&
           rendered[0] === expected[0] &&
           rendered[rendered.length - 1] === expected[expected.length - 1];
console.log(`Correctness: render returned ${value}; DOM received ${rendered.length} items; ` +
            `matches plain JS result? ${ok ? "YES" : "NO"}`);
console.log(`Sample rendered: ${rendered.slice(0, 3).join(", ")} ...`);
if (!ok) { process.exitCode = 1; }
