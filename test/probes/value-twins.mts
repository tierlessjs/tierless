// PROBE: value twins and shipped closures hold their invariants over random graphs.
//
// A shipped sync closure's caps may carry a stamped instance as a COPY (graph.mts value
// twin) only when a copy is complete: nothing in it is behavior or another tier's. The
// encoder decides by its rule; the decoder re-checks the slot graph (§7). Hundreds of seeded
// graphs — plain data, stamped instances, functions, foreign handles, accessors, compiled
// stubs with caps of their own, oversized strings — are shipped from a "browser" tier to a
// "server" tier and back, and these must hold every time:
//   I1  no handle, and no function but a runnable compiled stub, is reachable inside a copy
//   I2  a copy has its class's prototype
//   I3  a copy's data equals the original's
//   I4  the engine's choice matches an independent rule: an instance copies iff it holds
//       no behavior (function, accessor, foreign handle) and fits the threshold
//   I5  going home, every copy and every shipped closure is the original object again
//   I6  outside a shipped closure's caps, instances never copy (ownership stands)
//   I7  a copy whose closure the far tier can't run is demoted to a handle there
import { encodeWireBinary, decodeWireBinary } from "tierless/wire";
import { makeTier } from "tierless/heap";
import { isHandle, shareClass, twinOf, type Handle } from "tierless/graph";
import { ownedUnit } from "tierless";
import { makeCheck } from "../lib/check.mts";

const { check, ok } = makeCheck();
const rng = (seed: number): (() => number) => { let s = (seed >>> 0) || 1; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; };

class A { constructor(f: Record<string, unknown> = {}) { Object.assign(this, f); } }
class B { constructor(f: Record<string, unknown> = {}) { Object.assign(this, f); } }
class U { }                                                            // unregistered: never a copy
shareClass("vt:A", A); shareClass("vt:B", B);
const CLS = new Map<object, string>([[A.prototype, "vt:A"], [B.prototype, "vt:B"]]);

interface Stub { (): unknown; __tierless_program: string; __tierless_sync: true; __tierless_caps: () => unknown }
const mkStub = (program: string, caps: unknown): Stub => Object.assign(() => caps, { __tierless_program: program, __tierless_sync: true as const, __tierless_caps: () => caps });
const isStub = (v: unknown): v is Stub => typeof v === "function" && (v as Stub).__tierless_sync === true;
// the server runs "P" but not "Q"
const programs = (name: string) => (name === "P" ? (caps: unknown) => caps : undefined);

function makeGraph(rnd: () => number): { caps: Record<string, unknown>; outside: unknown } {
  const rint = (n: number): number => Math.floor(rnd() * n);
  const value = (depth: number): unknown => {
    const c = rint(depth > 3 ? 6 : 16);
    switch (c) {
      case 0: return rint(1000); case 1: return "s" + rint(50); case 2: return rnd() < 0.5; case 3: return null; case 4: return undefined; case 5: return rnd();
      case 6: case 7: { const o: Record<string, unknown> = {}; for (let i = rint(4); i >= 0; i--) o["k" + i] = value(depth + 1); return o; }
      case 8: { const a: unknown[] = []; for (let i = rint(4); i >= 0; i--) a.push(value(depth + 1)); return a; }
      case 9: { const m = new Map<unknown, unknown>(); for (let i = rint(3); i >= 0; i--) m.set("m" + i, value(depth + 1)); return m; }
      case 10: case 11: { const f: Record<string, unknown> = {}; for (let i = rint(4); i >= 0; i--) f["p" + i] = value(depth + 1); return rnd() < 0.5 ? new A(f) : new B(f); }
      case 12: return rnd() < 0.5 ? (): number => 1 : new U();            // behavior / an unregistered class
      case 13: return { __tierless_handle__: true, owner: "elsewhere", id: "x" + rint(9), kind: "object" } as Handle;
      case 14: return mkStub(rnd() < 0.7 ? "P" : "Q", value(depth + 1));
      default: { if (rnd() < 0.2) return "x".repeat(300 + rint(600)); const o: Record<string, unknown> = {}; Object.defineProperty(o, "acc", { get: () => 1, enumerable: true }); return rnd() < 0.5 ? o : new A({ held: o }); }
    }
  };
  const caps: Record<string, unknown> = {}; for (let i = rint(4); i >= 0; i--) caps["c" + i] = value(1);
  return { caps, outside: value(1) };
}

// the independent rule (I4): behavior or another tier's object anywhere inside, or over the threshold
const holdsBehavior = (root: object): boolean => {
  const seen = new Set<unknown>(), work: unknown[] = [root];
  while (work.length) {
    const x = work.pop();
    if (typeof x === "function") { if (isStub(x)) { work.push(x.__tierless_caps()); continue; } return true; }
    if (x === null || typeof x !== "object" || seen.has(x)) continue;
    seen.add(x);
    if (isHandle(x)) return true;
    const p = Object.getPrototypeOf(x);
    if (!(p === Object.prototype || p === null || Array.isArray(x) || x instanceof Map || CLS.has(p))) return true;
    if (x instanceof Map) { for (const [, v] of x) work.push(v); continue; }
    for (const k of Object.getOwnPropertyNames(x)) { const d = Object.getOwnPropertyDescriptor(x, k)!; if (!("value" in d)) return true; work.push(d.value); }
  }
  return false;
};
const sizeOf = (root: unknown): number => {   // graph.mts approxExceeds's accounting, independently
  let total = 0; const seen = new Set<unknown>(), work = [root];
  while (work.length) {
    const x = work.pop();
    if (x === null || typeof x !== "object") { total += typeof x === "string" ? x.length : 8; continue; }
    if (seen.has(x)) continue; seen.add(x); total += 16;
    if (Array.isArray(x)) work.push(...x); else if (x instanceof Map) { total += 16 * x.size; for (const [k, v] of x) { work.push(k); work.push(v); } } else for (const k of Object.keys(x)) { total += k.length; work.push((x as Record<string, unknown>)[k]); }
  }
  return total;
};
// the instances the rule is asked about directly: the closure's own caps members (deeper
// ones sit inside containers with rules of their own — a plain object holding a function
// excises whole, so an instance inside it is a member handle, not a copy); and whether a
// stub the far tier can't run ("Q") sits anywhere inside
const instances = (T: Stub): Map<object, { runnable: boolean }> => {
  const out = new Map<object, { runnable: boolean }>();
  const holdsQ = (root: unknown): boolean => reach(root).some((y) => isStub(y) && !programs(y.__tierless_program));
  for (const x of Object.values(T.__tierless_caps() as Record<string, unknown>)) if (x !== null && typeof x === "object" && CLS.has(Object.getPrototypeOf(x))) out.set(x, { runnable: !holdsQ(x) });
  return out;
};
// data equality of a copy against its original: own data props, deep; stubs by program; no functions/handles expected in a copy
const dataEq = (a: unknown, b: unknown, seen = new Map<unknown, unknown>()): boolean => {
  if (typeof a === "function" || typeof b === "function") return isStub(a) && isStub(b) && a.__tierless_program === b.__tierless_program;
  if (a === null || typeof a !== "object" || b === null || typeof b !== "object") return Object.is(a, b);
  if (seen.has(a)) return seen.get(a) === b; seen.set(a, b);
  if (isHandle(a) || isHandle(b)) return isHandle(a) && isHandle(b) && a.owner === b.owner && a.id === b.id;
  if (a instanceof Map) { if (!(b instanceof Map) || a.size !== b.size) return false; for (const [k, v] of a) if (!dataEq(v, b.get(k), seen)) return false; return true; }
  const ka = Object.getOwnPropertyNames(a).filter((k) => "value" in Object.getOwnPropertyDescriptor(a, k)!), kb = Object.getOwnPropertyNames(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => dataEq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], seen));
};
// walk a decoded graph: every object with a home (copy) and everything reachable
const reach = (root: unknown): unknown[] => {
  const seen = new Set<unknown>(), out: unknown[] = [], work = [root];
  while (work.length) {
    const x = work.pop();
    if (x === null || (typeof x !== "object" && typeof x !== "function") || seen.has(x)) continue;
    seen.add(x); out.push(x);
    if (typeof x === "function") { if (isStub(x)) work.push(x.__tierless_caps()); continue; }
    if (isHandle(x)) continue;
    if (x instanceof Map) { for (const [, v] of x) work.push(v); continue; }
    for (const k of Object.getOwnPropertyNames(x)) { const d = Object.getOwnPropertyDescriptor(x, k)!; if ("value" in d) work.push(d.value); }
  }
  return out;
};

const ROUNDS = Number(process.env.ROUNDS || 400), ONLY = Number(process.env.SEED || 0);
const describe = (v: unknown, depth = 0, seen = new Set<unknown>()): string => {   // a compact picture of a graph, for a failing seed
  if (typeof v === "function") return isStub(v) ? `stub(${v.__tierless_program})${depth < 6 ? describe(v.__tierless_caps(), depth + 1, seen) : ""}` : "fn";
  if (v === null || typeof v !== "object") return typeof v === "string" && v.length > 20 ? `str(${v.length})` : JSON.stringify(v) ?? "undefined";
  if (seen.has(v)) return "<cycle>"; seen.add(v);
  if (isHandle(v)) return `H(${v.owner}${v.path ? "." + v.path.join(".") : ""}${v.view ? " view" : ""}${v.cls ? " " + v.cls : ""})`;
  const p = Object.getPrototypeOf(v), tag = p === A.prototype ? "A" : p === B.prototype ? "B" : p === U.prototype ? "U" : Array.isArray(v) ? "" : v instanceof Map ? "Map" : "";
  const copy = twinOf(v) ? "copy:" : "";
  if (v instanceof Map) return `${copy}Map{${[...v].map(([k, x]) => `${String(k)}:${describe(x, depth + 1, seen)}`).join(",")}}`;
  const keys = Object.getOwnPropertyNames(v).filter((k) => k !== "f");
  const body = keys.map((k) => { const d = Object.getOwnPropertyDescriptor(v, k)!; return `${k}:${"value" in d ? describe(d.value, depth + 1, seen) : "<accessor>"}`; }).join(",");
  return Array.isArray(v) ? `${copy}[${body}]` : `${copy}${tag}{${body}}`;
};
let fails: string[] = [], copies = 0, kept = 0, demoted = 0;
for (let seed = ONLY || 1; seed <= (ONLY || ROUNDS) && fails.length < 6; seed++) {
  const rnd = rng(seed * 7919);
  const threshold = [256, 1024, 8192][Math.floor(rnd() * 3)];
  const { caps, outside } = makeGraph(rnd);
  const T = mkStub("P", caps);
  const browser = makeTier("browser"), server = makeTier("server");
  const bytes = encodeWireBinary([{ fn: "F", pc: 0, args: [T], outside }], null, { tier: browser, excise: ownedUnit, threshold });
  const far = decodeWireBinary(bytes, { tier: server, programs }).stack[0] as unknown as { args: unknown[]; outside: unknown };
  const want = instances(T);
  const seenHome = new Set<object>();
  for (const x of reach(far.args[0])) {
    const h = typeof x === "object" && x !== null ? twinOf(x) : undefined;
    if (!h) continue;
    const orig = browser.heapGet(h.id) as object;
    seenHome.add(orig);
    copies++;
    // I1 — nothing inside a copy but data and runnable stubs
    for (const y of reach(x)) {
      if (isHandle(y)) { fails.push(`seed ${seed}: handle inside a copy`); if (ONLY) console.log("  copy:", describe(x), "\n  original:", describe(orig)); break; }
      if (typeof y === "function" && (!isStub(y) || !programs(y.__tierless_program))) { fails.push(`seed ${seed}: behavior inside a copy`); break; }
    }
    // I2, I3
    if (Object.getPrototypeOf(x) !== Object.getPrototypeOf(orig)) fails.push(`seed ${seed}: copy lost its class`);
    if (!dataEq(orig, x)) fails.push(`seed ${seed}: copy's data differs`);
    // I4 — copying was the rule's answer
    if (holdsBehavior(orig) || sizeOf(orig) > threshold) fails.push(`seed ${seed}: copied an instance the rule keeps home (behavior ${holdsBehavior(orig)}, size ${sizeOf(orig)} > ${threshold})`);
  }
  // I4 (other direction) and I7 — every instance the rule would copy was copied, unless its closure can't run over there
  for (const [orig, { runnable }] of want) {
    const should = !holdsBehavior(orig) && sizeOf(orig) <= threshold;
    if (should && runnable && !seenHome.has(orig)) { fails.push(`seed ${seed}: a caps member the rule copies didn't arrive as a copy`); if (ONLY) console.log("  original:", describe(orig), "\n  far caps:", describe((far.args[0] as Stub).__tierless_caps())); }
    if (!should && runnable) { if (seenHome.has(orig)) fails.push(`seed ${seed}: copied an owned instance`); else kept++; }
    if (!runnable) { if (seenHome.has(orig)) fails.push(`seed ${seed}: copied an instance whose closure can't run there`); else demoted++; }
  }
  // I6 — outside a shipped closure's caps, no copies (a closure met out there carries its own)
  {
    const seen = new Set<unknown>(), work = [far.outside]; let bad = false;
    while (work.length && !bad) { const x = work.pop(); if (x === null || typeof x !== "object" || seen.has(x)) continue; seen.add(x); if (twinOf(x)) { bad = true; break; } if (isHandle(x)) continue; if (x instanceof Map) { for (const [, v] of x) work.push(v); continue; } for (const k of Object.getOwnPropertyNames(x)) { const d = Object.getOwnPropertyDescriptor(x, k)!; if ("value" in d) work.push(d.value); } }
    if (bad) fails.push(`seed ${seed}: a copy outside a closure's caps`);
  }
  // I5 — home again: identity
  const back = decodeWireBinary(encodeWireBinary([far as never], null, { tier: server, excise: ownedUnit, threshold }), { tier: browser, programs }).stack[0] as unknown as { args: unknown[] };
  if (back.args[0] !== T) fails.push(`seed ${seed}: the shipped closure didn't come home as itself`);
  for (const orig of seenHome) if (!reach(back.args[0]).includes(orig)) fails.push(`seed ${seed}: a copy didn't come home as its original`);
}
check(`${ROUNDS} random graphs: ${copies} copies made, ${kept} kept home by the rule, ${demoted} demoted for an unrunnable closure — every invariant held`, fails.length === 0, fails.slice(0, 4).join("; "));
console.log(`\n${ok() ? "PASS" : "FAIL"} — value twins: a copy is complete and comes home as the original, or it never left`);
process.exit(ok() ? 0 : 1);
