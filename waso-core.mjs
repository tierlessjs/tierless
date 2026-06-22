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

import { encodeGraph, decodeGraph, GLOBALS, CTORS } from "./waso-heap.mjs";

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
    let gb; if (f.gb) { gb = roots.length; roots.push(f.gb); }        // generator boundary: ship the genObj by ref (identity-shared with the `it` local)
    return { fn: f.fn, ip: f.ip, nl: f.locals.length, ns: f.stack.length, ne: env.length, l0, s0, e0, gb, mode: f.mode, handlers: (f.handlers || []).map((h) => ({ ip: h.ip, sp: h.sp })) };
  });
  let pending = null;
  if (cont.pending && cont.pending.name !== undefined) {        // resource boundary
    const a0 = roots.length; for (const x of cont.pending.args) roots.push(x);
    pending = { name: cont.pending.name, a0, argc: cont.pending.args.length };
  } else if (cont.pending && "await" in cont.pending) {         // await boundary
    const w0 = roots.length; roots.push(cont.pending.await);
    pending = { awaitRoot: w0 };
  } else if (cont.pending && "awaitAll" in cont.pending) {       // Promise.all boundary (concurrent)
    const p0 = roots.length; for (const x of cont.pending.awaitAll) roots.push(x);
    const r0 = roots.length; for (const x of cont.pending.result) roots.push(x);
    pending = { awaitAllP: p0, awaitAllN: cont.pending.awaitAll.length, awaitAllR: r0, awaitAllRN: cont.pending.result.length, pendingIdx: cont.pending.pendingIdx };
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
    ...(f.gb !== undefined ? { gb: vals[f.gb], mode: f.mode } : {}),  // restore generator boundary (same genObj instance as `it`)
  }));
  let pending = null;
  if (wire.pending && wire.pending.name !== undefined)
    pending = { name: wire.pending.name, args: vals.slice(wire.pending.a0, wire.pending.a0 + wire.pending.argc) };
  else if (wire.pending && wire.pending.awaitRoot !== undefined)
    pending = { await: vals[wire.pending.awaitRoot] };
  else if (wire.pending && wire.pending.awaitAllP !== undefined)
    pending = { awaitAll: vals.slice(wire.pending.awaitAllP, wire.pending.awaitAllP + wire.pending.awaitAllN), result: vals.slice(wire.pending.awaitAllR, wire.pending.awaitAllR + wire.pending.awaitAllRN), pendingIdx: wire.pending.pendingIdx };
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

// A `yield` suspends ONLY the generator's own frame stack (a local, bounded
// suspension), unwinding out of the sub-run() that drives the generator — not the
// whole interpreter. Distinct from Suspend (which migrates the entire program).
export class Yielded { constructor(value) { this.value = value; } }

// A generator object: an iterator wrapping its own paused frame stack. Because the
// frames are ordinary continuation frames, a half-consumed generator is itself
// serializable/migratable (frame-stack codec) — native JS generators are not.
export function isGenerator(x) { return x !== null && typeof x === "object" && x.__gen__ === true; }

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
      if (cur.gb) cur.gb.done = true;                         // exception propagating past a generator boundary -> that generator is done
      frames.pop();
      if (frames.length === 0) throw new WasoUncaught(v);
    }
  };
  // Splice a generator's frames onto the MAIN stack, beneath a boundary frame, and
  // let the main loop drive it. YIELD unwinds to the boundary; RET past it completes
  // the generator; a Suspend (await INSIDE the generator) captures the whole
  // flattened stack — so mid-generator host suspension migrates like anything else.
  const spliceGen = (g, sendVal, mode) => {
    const consumer = frames[frames.length - 1];
    if (g.done) { if (mode === "obj") consumer.stack.push({ value: undefined, done: true }); else { consumer.stack.push(undefined); consumer.stack.push(true); } return; }
    if (g.started) g.frames[g.frames.length - 1].stack.push(sendVal); else g.started = true; // resume value of the paused yield
    frames.push({ gb: g, mode, fn: null, ip: 0, locals: [], stack: [], env: [], handlers: [] }); // boundary
    for (const fr of g.frames) frames.push(fr);
    g.frames = null;                                          // now live on the main stack (YIELD saves them back)
  };
  const makeGen = (callee, args) => ({ __gen__: true, frames: [{ fn: callee.fn, ip: 0, locals: args, stack: [], env: callee.env, handlers: [] }], done: false, started: false });
  // Unwind a generator's own frames to its nearest handler, seeding the thrown
  // value (for .throw()/.return() injection). Returns false if nothing caught it.
  const unwindToHandler = (gframes, v) => {
    while (gframes.length) { const cur = gframes[gframes.length - 1]; if (cur.handlers && cur.handlers.length) { const h = cur.handlers.pop(); cur.stack.length = h.sp; cur.stack.push(v); cur.ip = h.ip; return true; } gframes.pop(); }
    return false;
  };
  // Drive a generator's own frame stack to the next yield (a recursive run on its
  // frames; YIELD unwinds back here) or to completion (RET past its base frame).
  const genAdvance = (g, sendVal) => {
    if (g.done) return { value: undefined, done: true };
    if (g.started) g.frames[g.frames.length - 1].stack.push(sendVal); // resume: the sent value IS the yield expression's value
    g.started = true;
    try { const r = run(tier, g.frames, host); g.done = true; return { value: r.value, done: true }; }
    catch (e) {
      if (e instanceof Yielded) return { value: e.value, done: false };
      // A genuine async resource / remote-handle deref awaited INSIDE a generator
      // suspends to the host mid-iteration. Resuming that needs the generator's
      // inner frames composed with the outer continuation (one flattened stack) —
      // the documented frontier. Fail loudly instead of corrupting the outer
      // continuation. (Local awaits of plain/resolved values resolve inline and
      // never reach here; an outer continuation that merely HOLDS a paused
      // generator migrates fine — see probe-frontend §J.)
      if (e instanceof Suspend) { g.done = true; throw new WasoUncaught("waso: cannot suspend to the host (await of a genuine async resource / remote handle) INSIDE a generator mid-iteration — resolve it outside the generator"); }
      throw e;
    }
  };
  // it.return(v): complete the generator, running any active finally blocks. Inject
  // a sentinel that the finally machinery propagates back out (carrying v); a finally
  // that itself returns/throws overrides (real JS semantics).
  const genReturn = (g, v) => {
    if (g.done || !g.started) { g.done = true; return { value: v, done: true }; }
    if (!unwindToHandler(g.frames, { __genret__: v })) { g.done = true; return { value: v, done: true }; } // no finally -> just complete
    try { const r = run(tier, g.frames, host); g.done = true; return { value: r.value, done: true }; } // finally ran and fell through / overrode
    catch (e) {
      g.done = true;
      if (e instanceof Yielded) { g.done = false; return { value: e.value, done: false }; }              // finally yielded
      if (e instanceof WasoUncaught && e.value && e.value.__genret__ !== undefined) return { value: e.value.__genret__, done: true };
      throw e;                                                                                            // finally threw -> propagate to caller
    }
  };
  // it.throw(e): inject e at the suspension point. Caught by a try/catch in the
  // generator -> it may yield again; otherwise propagates to the caller.
  const genThrow = (g, e) => {
    if (!g.started || g.done) { g.done = true; throw new WasoUncaught(e); }
    if (!unwindToHandler(g.frames, e)) { g.done = true; throw new WasoUncaught(e); } // uncaught in generator -> caller
    try { const r = run(tier, g.frames, host); g.done = true; return { value: r.value, done: true }; }
    catch (err) { if (err instanceof Yielded) return { value: err.value, done: false }; g.done = true; throw err; }
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
      case "ARGUMENTS": f.stack.push(Array.prototype.slice.call(f.locals)); f.ip++; break;                          // `arguments`: snapshot the passed args (strict)
      case "GLOBAL": f.stack.push(GLOBALS[ins[1]]); f.ip++; break;                                                // host stdlib global (Math/JSON/Object/...)
      case "CALLG": { const argc = ins[2]; const args = []; for (let k = 0; k < argc; k++) args.unshift(f.stack.pop()); f.stack.push(GLOBALS[ins[1]](...args)); f.ip++; break; } // parseInt/Number/... bare call
      case "CTORG": { const argc = ins[2]; const args = []; for (let k = 0; k < argc; k++) args.unshift(f.stack.pop()); f.stack.push(new CTORS[ins[1]](...args)); f.ip++; break; } // new Map/Set/Date/...
      case "CLSGET": f.stack.push(tier.statics && tier.statics.get(ins[1])); f.ip++; break;                       // class-object registry (per tier)
      case "CLSPUT": (tier.statics || (tier.statics = new Map())).set(ins[1], f.stack[f.stack.length - 1]); f.ip++; break; // peek + cache, leave on stack
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
      case "INDEX":  { const a = d(f.stack[f.stack.length - 2]); const i = f.stack[f.stack.length - 1]; f.stack.length -= 2; const acc = a != null && a.__accessors__ && a.__accessors__[i]; if (acc && acc.get) { f.ip++; frames.push({ fn: acc.get.fn, ip: 0, locals: [], stack: [], env: acc.get.env, handlers: [] }); break; } f.stack.push(a[i]); f.ip++; break; } // computed access fires a getter
      case "SETINDEX": { const a = d(f.stack[f.stack.length - 3]); const i = f.stack[f.stack.length - 2]; const v = f.stack[f.stack.length - 1]; f.stack.length -= 3; const acc = a != null && a.__accessors__ && a.__accessors__[i]; if (acc && acc.set) { f.ip++; frames.push({ fn: acc.set.fn, ip: 0, locals: [v], stack: [], env: acc.set.env, handlers: [] }); break; } a[i] = v; f.ip++; break; }
      case "SETHIDDEN": { const o = f.stack[f.stack.length - 2]; const v = f.stack[f.stack.length - 1]; f.stack.length -= 2; Object.defineProperty(o, ins[1], { value: v, writable: true, enumerable: false, configurable: true }); f.stack.push(o); f.ip++; break; } // non-enumerable own prop (instance method/tag)
      case "BIN":    { const b = f.stack.pop(); const a = f.stack.pop(); f.stack.push(binop(ins[1], a, b)); f.ip++; break; }
      case "JMP":    f.ip = ins[1]; break;
      case "JMPF":   { const c = f.stack.pop(); f.ip = c ? f.ip + 1 : ins[1]; break; }
      case "LOADENV": f.stack.push(f.env[ins[1]]); f.ip++; break;
      case "MAKECLOSURE": {                                   // ["MAKECLOSURE", fn, [["L"|"E", idx]...], isGenerator?]
        const env = ins[2].map(([kind, i]) => (kind === "L" ? f.locals[i] : f.env[i]));
        f.stack.push({ __waso_closure__: true, fn: ins[1], env, gen: !!ins[3] });
        f.ip++; break;
      }
      case "CALLV": {                                          // call a closure value: ["CALLV", argc]
        const argc = ins[1];
        const args = [];
        for (let k = 0; k < argc; k++) args.unshift(f.stack.pop());
        const callee = f.stack.pop();
        if (!isClosure(callee)) throw new Error("CALLV on non-closure");
        f.ip++; // caller resumes after the CALLV
        if (callee.gen) { f.stack.push(makeGen(callee, args)); break; } // a generator call yields an iterator, doesn't run the body
        frames.push({ fn: callee.fn, ip: 0, locals: args, stack: [], env: callee.env, handlers: [] }); // no padding: a missing param LOADs as undefined; rest gathering needs exact args
        break;
      }
      case "CALLVS": {                                         // call a closure with a spread args array: ["CALLVS"]
        const argsArr = f.stack.pop();
        const callee = f.stack.pop();
        if (!isClosure(callee)) throw new Error("CALLVS on non-closure");
        f.ip++;
        if (callee.gen) { f.stack.push(makeGen(callee, argsArr.slice())); break; }
        frames.push({ fn: callee.fn, ip: 0, locals: argsArr.slice(), stack: [], env: callee.env, handlers: [] });
        break;
      }
      case "GATHERREST": { const r = ins[1]; const rest = f.locals.slice(r); f.locals.length = r; f.locals[r] = rest; f.ip++; break; } // rest param: gather extra args into an array
      case "APPENDALL": { const src = f.stack.pop(); const tgt = f.stack[f.stack.length - 1]; if (isGenerator(src)) { while (true) { const r = genAdvance(src, undefined); if (r.done) break; tgt.push(r.value); } } else for (const e of src) tgt.push(e); f.ip++; break; } // array/generator spread
      case "ASSIGNALL": { const src = f.stack.pop(); Object.assign(f.stack[f.stack.length - 1], src); f.ip++; break; }                         // object spread
      case "CALLM": {                                          // call a host method: ["CALLM", name, argc] (stdlib intrinsics)
        const argc = ins[2];
        const args = [];
        for (let k = 0; k < argc; k++) args.unshift(f.stack.pop());
        const o = d(f.stack.pop());
        f.stack.push(o[ins[1]](...args));
        f.ip++; break;
      }
      case "CALLMS": { const argsArr = f.stack.pop(); const o = d(f.stack.pop()); f.stack.push(o[ins[1]](...argsArr)); f.ip++; break; } // host method, spread args
      case "CALLMETHOD": case "CALLMETHODS": {                   // obj.m(args): dispatch user-closure method vs host method
        let args; if (ins[0] === "CALLMETHODS") args = f.stack.pop().slice(); else { args = []; for (let k = 0; k < ins[2]; k++) args.unshift(f.stack.pop()); }
        const o = d(f.stack.pop()); const m = o[ins[1]]; f.ip++;
        if (isClosure(m)) { if (m.gen) { f.stack.push(makeGen(m, args)); break; } frames.push({ fn: m.fn, ip: 0, locals: args, stack: [], env: m.env, handlers: [] }); break; } // user method (closure captures this)
        f.stack.push(m.apply(o, args)); break;                  // host method (Map.set, Set.add, ...)
      }
      case "PUSHTRY": (f.handlers || (f.handlers = [])).push({ ip: ins[1], sp: f.stack.length }); f.ip++; break;
      case "POPTRY":  f.handlers.pop(); f.ip++; break;
      case "RET": {
        const v = f.stack.pop();
        frames.pop();
        if (frames.length === 0) return { type: "done", value: v };
        const below = frames[frames.length - 1];
        if (below.gb) { const g = below.gb; g.done = true; frames.pop(); const c = frames[frames.length - 1]; if (below.mode === "obj") c.stack.push({ value: v, done: true }); else { c.stack.push(v); c.stack.push(true); } break; } // generator ran to completion
        below.stack.push(v);                                 // return into the caller
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
      case "YIELD": {                                           // pause the generator
        const v = f.stack.pop(); f.ip++;
        let bi = -1; for (let k = frames.length - 1; k >= 0; k--) if (frames[k].gb) { bi = k; break; }
        if (bi < 0) throw new Yielded(v);                      // recursive driver (genReturn/genThrow/genAdvance) — caught there
        const b = frames[bi]; b.gb.frames = frames.slice(bi + 1); frames.length = bi; // splice path: save frames, hand value to the consumer
        const c = frames[frames.length - 1];
        if (b.mode === "obj") c.stack.push({ value: v, done: false }); else { c.stack.push(v); c.stack.push(false); }
        break;
      }
      case "ITER": {                                            // normalize for-of source: array / generator / our iterator / host-iterable (Map/Set/string)
        const v = d(f.stack.pop());
        if (Array.isArray(v)) f.stack.push({ __it__: "arr", a: v, i: 0 });
        else if (v !== null && (isGenerator(v) || (typeof v === "object" && v.__it__))) f.stack.push(v);
        else if (v !== null && v !== undefined && typeof v[Symbol.iterator] === "function") f.stack.push({ __it__: "arr", a: Array.from(v), i: 0 }); // Map/Set/string -> drain to array
        else f.stack.push(v);
        f.ip++; break;
      }
      case "ITERNEXT": {                                        // -> push value, then done (bool)
        const it = f.stack.pop(); f.ip++;
        if (it && it.__it__ === "arr") { if (it.i < it.a.length) { f.stack.push(it.a[it.i++]); f.stack.push(false); } else { f.stack.push(undefined); f.stack.push(true); } break; }
        if (isGenerator(it)) { spliceGen(it, undefined, "pair"); break; } // drive the generator on the main stack
        throw new Error("not iterable");
      }
      case "GENNEXT": {                                         // it.next(sendVal) -> { value, done } (or an ordinary .next() method call)
        const sendVal = f.stack.pop(); const o = d(f.stack.pop()); f.ip++;
        if (o && o.__it__ === "arr") { f.stack.push(o.i < o.a.length ? { value: o.a[o.i++], done: false } : { value: undefined, done: true }); break; } // array iterator ignores the sent value
        if (isGenerator(o)) { spliceGen(o, sendVal, "obj"); break; } // drive the generator on the main stack
        const m = o && o.next;
        if (isClosure(m)) { frames.push({ fn: m.fn, ip: 0, locals: [sendVal], stack: [], env: m.env, handlers: [] }); break; } // user iterator object
        f.stack.push(o.next(sendVal)); break;                   // host method
      }
      case "GENRET": {                                          // it.return(v) -> { value, done:true }, running finallys
        const v = f.stack.pop(); const o = d(f.stack.pop()); f.ip++;
        if (isGenerator(o)) { let r; try { r = genReturn(o, v); } catch (e) { if (e instanceof WasoUncaught) { doThrow(e.value); break; } throw e; } f.stack.push({ value: r.value, done: r.done }); break; }
        const m = o && o.return; if (isClosure(m)) { frames.push({ fn: m.fn, ip: 0, locals: [v], stack: [], env: m.env, handlers: [] }); break; }
        f.stack.push(o && o.return ? o.return(v) : { value: v, done: true }); break;
      }
      case "GENTHROW": {                                        // it.throw(e) -> caught in gen (may yield) or propagates to caller
        const e = f.stack.pop(); const o = d(f.stack.pop()); f.ip++;
        if (isGenerator(o)) { let r; try { r = genThrow(o, e); } catch (ex) { if (ex instanceof WasoUncaught) { doThrow(ex.value); break; } throw ex; } f.stack.push({ value: r.value, done: r.done }); break; }
        const m = o && o.throw; if (isClosure(m)) { frames.push({ fn: m.fn, ip: 0, locals: [e], stack: [], env: m.env, handlers: [] }); break; }
        if (o && o.throw) { f.stack.push(o.throw(e)); break; } doThrow(e); break;
      }
      case "AWAITALL": {                                        // Promise.all: resolve every element CONCURRENTLY (one suspension)
        const xs = f.stack[f.stack.length - 1];
        let rejected = null; for (const x of xs) if (x !== null && typeof x === "object" && x.__waso_reject__) { rejected = x; break; }
        if (rejected) { f.stack.pop(); doThrow(rejected.value); break; }   // Promise.all rejects on the first rejection
        f.stack.pop();
        const result = new Array(xs.length); const payloads = [], pendingIdx = [];
        for (let i = 0; i < xs.length; i++) { const x = xs[i]; if (x !== null && typeof x === "object" && x.__waso_async__) { pendingIdx.push(i); payloads.push(x.payload); } else result[i] = x; }
        if (!pendingIdx.length) { f.stack.push(result); f.ip++; break; } // all immediate -> no suspension
        f.ip++; throw new Suspend(frames, { awaitAll: payloads, result, pendingIdx });
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
