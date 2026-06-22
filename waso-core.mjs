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

import { encodeGraph, decodeGraph } from "./waso-heap.mjs";

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
// Wire format — identity-preserving, cycle-safe graph encoding (waso-heap.mjs).
// All values reachable from the continuation are encoded into one shared table,
// so object identity and cycles survive the round trip; a subgraph larger than
// HANDLE_THRESHOLD becomes a §5 handle into the source tier's heap (tier-local,
// not shipped). See probe-heap.mjs for the failure modes this replaces, and
// waso-fetch.mjs for dereferencing a handle on the other tier.
// ---------------------------------------------------------------------------

export function serializeContinuation(cont, sourceTier) {
  const roots = [];                          // all values, flattened; graph dedupes shared refs
  const frames = cont.frames.map((f) => {
    const env = f.env || [];
    const l0 = roots.length; for (const x of f.locals) roots.push(x);
    const s0 = roots.length; for (const x of f.stack) roots.push(x);
    const e0 = roots.length; for (const x of env) roots.push(x);      // closure env travels too
    return { fn: f.fn, ip: f.ip, nl: f.locals.length, ns: f.stack.length, ne: env.length, l0, s0, e0, handlers: (f.handlers || []).map((h) => ({ ip: h.ip, sp: h.sp })) };
  });
  let pending = null;
  if (cont.pending && cont.pending.name !== undefined) {        // resource boundary
    const a0 = roots.length; for (const x of cont.pending.args) roots.push(x);
    pending = { name: cont.pending.name, a0, argc: cont.pending.args.length };
  } else if (cont.pending && "await" in cont.pending) {         // await boundary
    const w0 = roots.length; roots.push(cont.pending.await);
    pending = { awaitRoot: w0 };
  }
  return { frames, pending, graph: encodeGraph(roots, { tier: sourceTier, threshold: HANDLE_THRESHOLD }) };
}

export function deserializeContinuation(wire) {
  const vals = decodeGraph(wire.graph);      // rebuilds the graph (identity + cycles restored)
  const frames = wire.frames.map((f) => ({
    fn: f.fn, ip: f.ip,
    locals: vals.slice(f.l0, f.l0 + f.nl),
    stack: vals.slice(f.s0, f.s0 + f.ns),
    env: vals.slice(f.e0, f.e0 + f.ne),
    handlers: (f.handlers || []).map((h) => ({ ip: h.ip, sp: h.sp })),
  }));
  let pending = null;
  if (wire.pending && wire.pending.name !== undefined)
    pending = { name: wire.pending.name, args: vals.slice(wire.pending.a0, wire.pending.a0 + wire.pending.argc) };
  else if (wire.pending && wire.pending.awaitRoot !== undefined)
    pending = { await: vals[wire.pending.awaitRoot] };
  return { frames, pending };
}

export function contBytes(wire) { return Buffer.byteLength(JSON.stringify(wire)); }

// Accessors so callers don't reach into the wire's internal shape.
export function pendingName(wire) { return wire.pending && wire.pending.name; }
export function wireHandles(wire) { return wire.graph.objs.filter((o) => o.k === "H").map((o) => o.h); }

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

// Returned by host.deref when a remote handle isn't resident: the interpreter
// turns it into a suspension (a deref-miss is an await on the fetch). The host
// fetches it (async), caches it, and re-runs — so the deref ops below are
// written to touch the stack only AFTER the deref succeeds (re-runnable).
export class Miss {
  constructor(handle) { this.handle = handle; }
}

// Thrown out of run() when a Waso `throw` unwinds past all frames (uncaught).
export class WasoUncaught { constructor(value) { this.value = value; } }

// A first-class closure: a code pointer (fn name) + a captured environment. The
// env is plain data, so a closure — and a continuation holding one — serializes
// through the graph codec (code travels by reference, env by value).
export function isClosure(x) { return x !== null && typeof x === "object" && x.__waso_closure__ === true; }

// Wrap a payload as a genuine async value: `await` of it suspends to the host
// (which resolves `payload`). Plain values awaited inline (identity).
export function awaitable(payload) { return { __waso_async__: true, payload }; }

function binop(op, a, b) {
  switch (op) {
    case "+": return (typeof a === "string" || typeof b === "string") ? String(a) + String(b) : a + b;
    case "-": return a - b; case "*": return a * b; case "/": return a / b; case "%": return a % b; case "**": return a ** b;
    case "<": return a < b; case "<=": return a <= b; case ">": return a > b; case ">=": return a >= b;
    case "===": return a === b; case "!==": return a !== b;
    case "==": return a == b; case "!=": return a != b;
    case "in": return a in b;
    case "&": return a & b; case "|": return a | b; case "^": return a ^ b;
    case "<<": return a << b; case ">>": return a >> b; case ">>>": return a >>> b;
    default: throw new Error("bad binop " + op);
  }
}

export function run(tier, frames, host) {
  const d = (x) => {
    if (!isHandle(x)) return x;
    const r = host.deref(x);
    if (r instanceof Miss) throw new Suspend(frames, { fetch: r.handle }); // deref-miss -> suspend
    return r;
  };
  const doThrow = (v) => {                                    // unwind frames to the nearest handler
    while (true) {
      const cur = frames[frames.length - 1];
      if (cur.handlers && cur.handlers.length) { const h = cur.handlers.pop(); cur.stack.length = h.sp; cur.stack.push(v); cur.ip = h.ip; return; }
      frames.pop();
      if (frames.length === 0) throw new WasoUncaught(v);
    }
  };
  while (true) {
    const f = frames[frames.length - 1];
    const ins = PROGRAM[f.fn].code[f.ip];
    switch (ins[0]) {
      case "PUSH":   f.stack.push(ins[1]); f.ip++; break;
      case "LOAD":   f.stack.push(f.locals[ins[1]]); f.ip++; break;
      case "STORE":  f.locals[ins[1]] = f.stack.pop(); f.ip++; break;
      case "POP":    f.stack.pop(); f.ip++; break;
      case "DUP":    f.stack.push(f.stack[f.stack.length - 1]); f.ip++; break;
      case "NOT":    f.stack.push(!f.stack.pop()); f.ip++; break;
      case "TYPEOF": f.stack.push(typeof f.stack.pop()); f.ip++; break;
      case "BITNOT": f.stack.push(~f.stack.pop()); f.ip++; break;
      case "TOBIG":  f.stack.push(BigInt(f.stack.pop())); f.ip++; break;     // BigInt(x)
      case "INC":    { const v = f.stack.pop(); f.stack.push(typeof v === "bigint" ? v + 1n : v + 1); f.ip++; break; } // ++ (type-aware: 1n for bigint)
      case "DEC":    { const v = f.stack.pop(); f.stack.push(typeof v === "bigint" ? v - 1n : v - 1); f.ip++; break; }
      case "ISA": { const o = d(f.stack.pop()); f.stack.push(!!(o && typeof o === "object" && Array.isArray(o.__class__) && o.__class__.includes(ins[1]))); f.ip++; break; } // instanceof

      case "ISNULLISH": { const v = f.stack.pop(); f.stack.push(v === null || v === undefined); f.ip++; break; }
      case "KEYS":   f.stack.push(Object.keys(d(f.stack.pop()))); f.ip++; break;            // for-in
      case "DELPROP": { const o = d(f.stack.pop()); f.stack.push(delete o[ins[1]]); f.ip++; break; }
      case "DELINDEX": { const k = f.stack.pop(); const o = d(f.stack.pop()); f.stack.push(delete o[k]); f.ip++; break; }
      case "NEWARR": f.stack.push([]); f.ip++; break;
      // deref ops peek-then-deref so a deref-miss leaves the stack/ip untouched (re-runnable)
      case "ARRPUSH": { const a = d(f.stack[f.stack.length - 2]); const v = f.stack[f.stack.length - 1]; f.stack.length -= 2; a.push(v); f.ip++; break; }
      case "NEWOBJ": f.stack.push({}); f.ip++; break;
      case "SETPROP": { const o = d(f.stack[f.stack.length - 2]); const v = f.stack[f.stack.length - 1]; f.stack.length -= 2; o[ins[1]] = v; f.stack.push(o); f.ip++; break; }
      case "GETPROP": { const o = d(f.stack[f.stack.length - 1]); f.stack.pop(); f.stack.push(o[ins[1]]); f.ip++; break; }
      case "GETPROPA": {                                       // accessor-aware read: call the getter as a frame, else plain
        const o = d(f.stack[f.stack.length - 1]);
        const acc = o != null && o.__accessors__ && o.__accessors__[ins[1]];
        f.stack.pop(); f.ip++;
        if (acc && acc.get) { frames.push({ fn: acc.get.fn, ip: 0, locals: [], stack: [], env: acc.get.env, handlers: [] }); break; } // getter RET lands the value on this frame
        f.stack.push(o[ins[1]]); break;
      }
      case "SETPROPA": {                                       // accessor-aware write: call the setter(v) as a frame, else plain
        const v = f.stack[f.stack.length - 1]; const o = d(f.stack[f.stack.length - 2]);
        const acc = o != null && o.__accessors__ && o.__accessors__[ins[1]];
        f.stack.length -= 2; f.ip++;
        if (acc && acc.set) { frames.push({ fn: acc.set.fn, ip: 0, locals: [v], stack: [], env: acc.set.env, handlers: [] }); break; } // setter RETs undefined into this frame (the SETPROP value contract)
        o[ins[1]] = v; f.stack.push(o); break;
      }
      case "INDEX":  { const a = d(f.stack[f.stack.length - 2]); const i = f.stack[f.stack.length - 1]; f.stack.length -= 2; f.stack.push(a[i]); f.ip++; break; }
      case "SETINDEX": { const a = d(f.stack[f.stack.length - 3]); const i = f.stack[f.stack.length - 2]; const v = f.stack[f.stack.length - 1]; f.stack.length -= 3; a[i] = v; f.ip++; break; }
      case "BIN":    { const b = f.stack.pop(); const a = f.stack.pop(); f.stack.push(binop(ins[1], a, b)); f.ip++; break; }
      case "JMP":    f.ip = ins[1]; break;
      case "JMPF":   { const c = f.stack.pop(); f.ip = c ? f.ip + 1 : ins[1]; break; }
      case "LOADENV": f.stack.push(f.env[ins[1]]); f.ip++; break;
      case "MAKECLOSURE": {                                   // ["MAKECLOSURE", fn, [["L"|"E", idx]...]]
        const env = ins[2].map(([kind, i]) => (kind === "L" ? f.locals[i] : f.env[i]));
        f.stack.push({ __waso_closure__: true, fn: ins[1], env });
        f.ip++; break;
      }
      case "CALLV": {                                          // call a closure value: ["CALLV", argc]
        const argc = ins[1];
        const args = [];
        for (let k = 0; k < argc; k++) args.unshift(f.stack.pop());
        const callee = f.stack.pop();
        if (!isClosure(callee)) throw new Error("CALLV on non-closure");
        f.ip++; // caller resumes after the CALLV
        frames.push({ fn: callee.fn, ip: 0, locals: args, stack: [], env: callee.env, handlers: [] }); // no padding: a missing param LOADs as undefined; rest gathering needs exact args
        break;
      }
      case "CALLVS": {                                         // call a closure with a spread args array: ["CALLVS"]
        const argsArr = f.stack.pop();
        const callee = f.stack.pop();
        if (!isClosure(callee)) throw new Error("CALLVS on non-closure");
        f.ip++;
        frames.push({ fn: callee.fn, ip: 0, locals: argsArr.slice(), stack: [], env: callee.env, handlers: [] });
        break;
      }
      case "GATHERREST": { const r = ins[1]; const rest = f.locals.slice(r); f.locals.length = r; f.locals[r] = rest; f.ip++; break; } // rest param: gather extra args into an array
      case "APPENDALL": { const src = f.stack.pop(); const tgt = f.stack[f.stack.length - 1]; for (const e of src) tgt.push(e); f.ip++; break; } // array spread
      case "ASSIGNALL": { const src = f.stack.pop(); Object.assign(f.stack[f.stack.length - 1], src); f.ip++; break; }                         // object spread
      case "CALLM": {                                          // call a host method: ["CALLM", name, argc] (stdlib intrinsics)
        const argc = ins[2];
        const args = [];
        for (let k = 0; k < argc; k++) args.unshift(f.stack.pop());
        const o = d(f.stack.pop());
        f.stack.push(o[ins[1]](...args));
        f.ip++; break;
      }
      case "PUSHTRY": (f.handlers || (f.handlers = [])).push({ ip: ins[1], sp: f.stack.length }); f.ip++; break;
      case "POPTRY":  f.handlers.pop(); f.ip++; break;
      case "RET": {
        const v = f.stack.pop();
        frames.pop();
        if (frames.length === 0) return { type: "done", value: v };
        frames[frames.length - 1].stack.push(v);             // return into the caller
        break;
      }
      case "RES": {
        const argc = ins[2];
        const args = [];
        for (let k = 0; k < argc; k++) args.unshift(f.stack.pop());
        if (tier.has(ins[1])) { f.stack.push(tier.resources[ins[1]](args)); f.ip++; break; }
        f.ip++; // resume point is AFTER this RES; pending resource runs on arrival
        throw new Suspend(frames, { name: ins[1], args });
      }
      case "AWAIT": {
        // `await` is a suspension point. A plain value resolves to itself (no
        // host round-trip) — so async between user functions, Promise.resolve,
        // and Promise.all of resolved values are free; only a genuine async
        // value (marked __waso_async__) suspends to the host, and a rejected
        // promise throws via the exception machinery.
        const v = f.stack[f.stack.length - 1];
        if (v !== null && typeof v === "object" && v.__waso_reject__) { f.stack.pop(); doThrow(v.value); break; }
        if (v !== null && typeof v === "object" && v.__waso_async__) { f.stack.pop(); f.ip++; throw new Suspend(frames, { await: v.payload }); }
        f.ip++; break; // plain value: identity
      }
      case "MKREJECT": { f.stack.push({ __waso_reject__: true, value: f.stack.pop() }); f.ip++; break; } // Promise.reject(e)
      case "THROW": { doThrow(f.stack.pop()); break; }
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
  return [{ fn: entry, ip: 0, locals: args.slice(), stack: [], env: [], handlers: [] }];
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
