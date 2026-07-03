// Thorough testing for the binary wire codec (src/wire-binary.mjs). A hand-rolled
// deserializer that reads bytes from the OTHER tier (§7 trust boundary) needs more than a
// happy-path probe, so this is four passes:
//   1. property-based round-trip — thousands of random object graphs (sharing, cycles, all
//      value types) must decode back IDENTICALLY (identity + cycles preserved);
//   2. differential vs the JSON wire — both codecs must decode json-safe graphs the same;
//   3. boundaries — varint/float edge values, empties, big tables (multi-byte indices),
//      unicode; plus NaN/±Inf/-0 which binary preserves and JSON cannot;
//   4. decode robustness — truncated, corrupted, and hostile bytes must fail CLEANLY (no
//      hang, no OOB read, no prototype pollution).
import { encodeWireBinary, decodeWireBinary } from "tierless/wire";
import { encodeWire, decodeWire, makeTier } from "tierless/heap";
import { isHandle, decodeGraph } from "tierless/graph";
import { ContentStore, newPeerView } from "tierless/content";
import type { DeltaFrame, DeltaRequest } from "tierless/delta";

type Cont = { stack: DeltaFrame[]; request: DeltaRequest | null };

let pass = true;
const check = (name: string, cond: boolean, extra: unknown = ""): void => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); pass = pass && cond; };
const rng = (seed: number): (() => number) => { let s = (seed >>> 0) || 1; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; };
console.log("Probe: binary wire codec — property round-trips, differential, boundaries, robustness\n");

// --- a seeded random-graph generator (sharing, cycles, every value type) ----------------
const STRPOOL = ["", "a", "id", "title", "author", "x", "δσ", "🦄✓", "k k", "q\"q", "l\nb", "123", "-1", "a".repeat(40), "dup", "dup"];
function makeGraph(rnd: () => number, jsonSafe = false): { frames: DeltaFrame[]; request: DeltaRequest | null } {
  const pool: unknown[] = [], rint = (n: number): number => Math.floor(rnd() * n), pick = <T,>(a: T[]): T => a[rint(a.length)];
  function leaf(): unknown {
    let c = rint(12); if (jsonSafe && c === 9) c = 8;                 // skip the JSON-lossy specials when json-safe
    switch (c) {
      case 0: return rint(256) - 128;
      case 1: { const m = rint(0x7fffffff); return rnd() < 0.5 && m !== 0 ? -m : m; }  // never -0 here
      case 2: return rnd() * 2e6 - 1e6;
      case 3: return pick(STRPOOL);
      case 4: return true; case 5: return false; case 6: return null; case 7: return undefined;
      case 8: return BigInt(rint(0x7fffffff)) * (rnd() < 0.3 ? 1000000000000n : 1n) * (rnd() < 0.5 ? -1n : 1n);
      case 9: return pick([NaN, Infinity, -Infinity, -0]);
      case 10: return pick([Symbol.iterator, Symbol.asyncIterator, Symbol.for("reg" + rint(3))]);
      default: return pick([0.1, Math.PI, 5e-324, 1e308]);
    }
  }
  function node(d: number): unknown {
    if (d <= 0 || rnd() < 0.4) return leaf();
    if (pool.length && rnd() < 0.3) return pick(pool);                // reuse -> DAG sharing / cycles
    const kind = rint(4);
    if (kind === 0) { const a: unknown[] = []; pool.push(a); const n = rint(5); for (let i = 0; i < n; i++) a.push(node(d - 1)); return a; }
    if (kind === 1) { const o: Record<string | symbol, unknown> = {}; pool.push(o); const n = rint(5); for (let i = 0; i < n; i++) { const key = pick(STRPOOL); if (key !== "__proto__") o[key] = node(d - 1); } if (rnd() < 0.15) o[Symbol("s" + rint(3))] = node(d - 1); return o; }
    if (kind === 2) { const m = new Map<unknown, unknown>(); pool.push(m); const n = rint(4); for (let i = 0; i < n; i++) m.set(rnd() < 0.5 ? pick(STRPOOL) : node(d - 1), node(d - 1)); return m; }
    const s = new Set<unknown>(); pool.push(s); const n = rint(4); for (let i = 0; i < n; i++) s.add(node(d - 1)); return s;
  }
  const frames: DeltaFrame[] = []; const nf = 1 + rint(2);
  for (let fi = 0; fi < nf; fi++) { const fr: DeltaFrame = { fn: "F" + fi, pc: rint(20), args: [] }; const nl = rint(4); for (let i = 0; i < nl; i++) fr["loc" + i] = node(4); frames.push(fr); }
  const request = rnd() < 0.6 ? { op: "resource", tier: pick(["server", "browser"]), name: "api.x", args: Array.from({ length: rint(3) }, () => node(4)) } : null;
  return { frames, request };
}

// identity-aware structural equality: walks a/b in lockstep, mapping a-objects to b-objects,
// so it asserts both VALUE equality and that sharing/cycles are reproduced (a node seen twice
// in `a` must be the same node twice in `b`).
function structEq(a: unknown, b: unknown, map: Map<unknown, unknown>): boolean {
  if (typeof a === "number" || typeof b === "number") return typeof a === typeof b && Object.is(a, b);
  if (typeof a === "bigint" || typeof b === "bigint") return a === b;
  if (typeof a === "symbol" || typeof b === "symbol") {
    if (typeof a !== "symbol" || typeof b !== "symbol") return false;
    const ka = Symbol.keyFor(a), kb = Symbol.keyFor(b);
    if (ka !== undefined || kb !== undefined) return ka === kb;       // registered
    return a === b || a.description === b.description;                // well-known (===) or unique (by description)
  }
  if (a === undefined || b === undefined || a === null || b === null) return a === b;
  if (typeof a !== "object" || typeof b !== "object") return a === b;
  if (map.has(a)) return map.get(a) === b;
  if ([...map.values()].includes(b)) return false;
  map.set(a, b);
  if (isHandle(a) || isHandle(b)) return isHandle(a) && isHandle(b) && a.owner === b.owner && String(a.id) === String(b.id);
  const am = a instanceof Map, as = a instanceof Set, aa = Array.isArray(a);
  if (am || b instanceof Map) { if (!am || !(b instanceof Map) || a.size !== b.size) return false; const ea = [...a], eb = [...b]; for (let i = 0; i < ea.length; i++) if (!structEq(ea[i][0], eb[i][0], map) || !structEq(ea[i][1], eb[i][1], map)) return false; return true; }
  if (as || b instanceof Set) { if (!as || !(b instanceof Set) || a.size !== b.size) return false; const ea = [...a], eb = [...b]; for (let i = 0; i < ea.length; i++) if (!structEq(ea[i], eb[i], map)) return false; return true; }
  if (aa || Array.isArray(b)) { if (!aa || !Array.isArray(b) || a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (!structEq(a[i], b[i], map)) return false; return true; }
  const ka = Object.getOwnPropertyNames(a), kb = Object.getOwnPropertyNames(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) { if (!Object.prototype.hasOwnProperty.call(b, k)) return false; const da = Object.getOwnPropertyDescriptor(a, k)!, db = Object.getOwnPropertyDescriptor(b, k)!; if (!!da.enumerable !== !!db.enumerable || !structEq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], map)) return false; }
  const sa = Object.getOwnPropertySymbols(a), sb = Object.getOwnPropertySymbols(b);
  if (sa.length !== sb.length) return false;
  const used = new Set<symbol>();
  for (const sk of sa) { let m = false; for (const tk of sb) { if (used.has(tk)) continue; if (sk.description === tk.description && structEq((a as Record<symbol, unknown>)[sk], (b as Record<symbol, unknown>)[tk], map)) { used.add(tk); m = true; break; } } if (!m) return false; }
  return true;
}
const sameContinuation = (x: Cont, y: Cont): boolean => { const map = new Map<unknown, unknown>(); if (x.stack.length !== y.stack.length) return false; for (let i = 0; i < x.stack.length; i++) if (!structEq(x.stack[i], y.stack[i], map)) return false; if ((x.request === null) !== (y.request === null)) return false; if (x.request) { if (x.request.name !== y.request!.name || x.request.tier !== y.request!.tier) return false; if (!structEq(x.request.args, y.request!.args, map)) return false; } return true; };

// === 1) property-based round-trip ===
let propFail = -1;
for (let i = 0; i < 2000 && propFail < 0; i++) {
  const { frames, request } = makeGraph(rng(0x1234 + i));
  let back; try { back = decodeWireBinary(encodeWireBinary(frames, request, {})); } catch (e) { console.log("    threw at iter " + i + ": " + (e as Error).message); propFail = i; break; }
  if (!sameContinuation({ stack: frames, request }, back)) propFail = i;
}
check("property round-trip: 2000 random graphs (sharing/cycles/all types) decode identically", propFail < 0, propFail < 0 ? "" : "first failure at iter " + propFail);

// === 2) differential vs the JSON wire (json-safe graphs) ===
let diffFail = -1;
for (let i = 0; i < 1200 && diffFail < 0; i++) {
  const { frames, request } = makeGraph(rng(0x9abc + i), true);
  const j = decodeWire(encodeWire(frames, request, {})), b = decodeWireBinary(encodeWireBinary(frames, request, {}));
  if (!sameContinuation(j, b)) diffFail = i;
}
check("differential: binary decodes identically to the JSON wire (1200 json-safe graphs)", diffFail < 0, diffFail < 0 ? "" : "first divergence at iter " + diffFail);

// === 3) boundaries ===
const rt1 = (v: unknown): unknown => decodeWireBinary(encodeWireBinary([{ fn: "F", pc: 0, v, args: [] }], null, {})).stack[0].v;
let intsOk = true; for (const n of [0, 1, -1, 127, 128, -128, 255, 256, 16383, 16384, 2 ** 20, 2 ** 28, 2 ** 31 - 1, -(2 ** 31 - 1), 2 ** 31, 2 ** 40, 2 ** 52, 2 ** 53 - 1, 2 ** 53, -(2 ** 53)]) intsOk = intsOk && Object.is(rt1(n), n);
check("integer boundaries round-trip exactly (incl. the int/float threshold at 2^31)", intsOk);
let fOk = true; for (const f of [0.1, -0.1, Math.PI, 1e308, 5e-324, Number.MAX_VALUE, Number.MIN_VALUE, -1.5]) fOk = fOk && Object.is(rt1(f), f);
check("float boundaries round-trip exactly", fOk);
let specialOk = true; for (const sp of [NaN, Infinity, -Infinity, -0]) specialOk = specialOk && Object.is(rt1(sp), sp);
check("binary preserves NaN / ±Infinity / -0 exactly (which the JSON wire turns to null/0)", specialOk);
// DeltaFrame's index signature types extra fields unknown; these fixtures need several fields at once, so cast once for deep access.
const eb = decodeWireBinary(encodeWireBinary([{ fn: "F", pc: 0, o: {}, a: [], m: new Map(), s: new Set(), str: "", args: [] }], null, {})).stack[0] as any;
check("empty object / array / map / set / string round-trip", Object.keys(eb.o).length === 0 && eb.a.length === 0 && eb.m.size === 0 && eb.s.size === 0 && eb.str === "");
const many: Record<string, string> = {}; for (let i = 0; i < 400; i++) many["field_" + i] = "value_" + i;        // 400 distinct keys+values -> string table > 127
const list = Array.from({ length: 400 }, (_, i) => ({ n: i }));                            // 400 objs -> ref ids > 127
const lb = decodeWireBinary(encodeWireBinary([{ fn: "F", pc: 0, many, list, args: [] }], null, {})).stack[0] as any;   // see note above
check("large string/shape/obj tables (>127 entries, multi-byte varint indices) round-trip", lb.many.field_399 === "value_399" && lb.list.length === 400 && lb.list[399].n === 399);
const ub = decodeWireBinary(encodeWireBinary([{ fn: "F", pc: 0, s: "héllo 🦄   \n \"q\"", long: "x".repeat(5000), args: [] }], null, {})).stack[0] as any;   // see note above
check("unicode, NUL, control chars, and a 5 KB string round-trip", ub.s === "héllo 🦄   \n \"q\"" && ub.long.length === 5000);

// === 4) decode robustness against truncated / corrupted / hostile bytes ===
const valid = encodeWireBinary([{ fn: "F", pc: 0, x: { a: 1, b: [1, 2, 3], c: "s" }, args: [] }], { op: "resource", tier: "server", name: "api.x", args: [{ k: 1 }] }, {});
let truncThrew = 0; for (let len = 0; len < valid.length; len++) { try { decodeWireBinary(valid.subarray(0, len)); } catch (e) { if (e instanceof Error) truncThrew++; } }
check("every truncation of a valid wire throws cleanly (no OOB read)", truncThrew === valid.length);
const g = rng(0xdead); let garbageOk = 0; const G = 1500;
for (let i = 0; i < G; i++) { const n = Math.floor(g() * 80), b = new Uint8Array(n); for (let k = 0; k < n; k++) b[k] = Math.floor(g() * 256); if (g() < 0.5 && n >= 4) b.set([83, 77, 87, 49], 0); try { decodeWireBinary(b); garbageOk++; } catch (e) { if (e instanceof Error) garbageOk++; } }
check("random/garbage buffers always terminate (throw or return) — never hang or corrupt", garbageOk === G, `(${G} buffers, half with valid magic)`);
let corruptOk = 0; const cn = Math.min(valid.length, 256); for (let i = 0; i < cn; i++) { const b = valid.slice(); b[i] ^= 0xff; try { decodeWireBinary(b); corruptOk++; } catch (e) { if (e instanceof Error) corruptOk++; } }
check("single-byte corruptions of a valid wire always terminate cleanly", corruptOk === cn);
let badMagic = false; try { decodeWireBinary(new Uint8Array([1, 2, 3, 4, 5, 6])); } catch { badMagic = true; }
check("a bad magic number is rejected", badMagic);

// prototype-pollution resistance. (a) Our codec strips a "__proto__" data key on encode, so
// a round-trip never pollutes and the key is dropped — not silently turned into a prototype.
const evil = {}; Object.defineProperty(evil, "__proto__", { value: { polluted: true }, enumerable: true, writable: true, configurable: true });
const decoded = (decodeWireBinary(encodeWireBinary([{ fn: "F", pc: 0, payload: evil, args: [] }], null, {})).stack[0] as any).payload;   // see note above
check("our encode strips a __proto__ data key: no pollution, prototype stays Object.prototype, key dropped",
  ({} as Record<string, unknown>).polluted === undefined && Object.getPrototypeOf(decoded) === Object.prototype && !("polluted" in decoded) && Object.getOwnPropertyDescriptor(decoded, "__proto__") === undefined);
// (b) and the decoder defends a HOSTILE graph (own __proto__ key, as JSON.parse — not the literal setter) from polluting.
const hostile = { roots: [{ k: "r", id: 0 }], objs: [{ k: "o", f: JSON.parse('{"__proto__":{"k":"r","id":1}}') }, { k: "o", f: JSON.parse('{"polluted":{"k":"p","v":true}}') }] };
const out = decodeGraph(hostile)[0] as any;   // decodeGraph is generic (unknown[] out); see wire-content.mts for the same pattern
check("decodeGraph defends a hostile __proto__ key (no global or per-object prototype pollution)",
  ({} as Record<string, unknown>).polluted === undefined && out.polluted === undefined && Object.getPrototypeOf(out) === Object.prototype);

// a §5 handle still excises + round-trips through the binary wire
const hb = decodeWireBinary(encodeWireBinary([{ fn: "F", pc: 0, big: { blob: "x".repeat(20000) }, args: [] }], null, { tier: makeTier("server"), threshold: 8192 })).stack[0];
check("§5 handle excision survives the binary wire", isHandle(hb.big));

// === 5) content-addressing: a registered immutable subgraph round-trips cold (inline + cache) and
// warm (hash leaf), over random graphs, and a content wire's truncations all fail cleanly. ===
let contentFail = -1;
for (let i = 0; i < 800 && contentFail < 0; i++) {
  const rnd = rng(0x5e7 + i);
  const { frames } = makeGraph(rnd);
  const config = makeGraph(rnd).frames[0];                          // a random object, treated as immutable
  const prod = new ContentStore(), recv = new ContentStore(), peer = newPeerView();
  const hash = prod.register(config);
  frames[0].config = config; if (rnd() < 0.5) frames[0].alsoConfig = config;   // referenced once or twice
  try {
    const cold = decodeWireBinary(encodeWireBinary(frames, null, { content: { store: prod, peer } }), { content: { store: recv } }); // inline + cache
    const warm = decodeWireBinary(encodeWireBinary(frames, null, { content: { store: prod, peer } }), { content: { store: recv } }); // hash leaf
    const ok = sameContinuation({ stack: frames, request: null }, cold)
      && sameContinuation({ stack: frames, request: null }, warm)
      && recv.get(hash) === cold.stack[0].config                    // cached on the cold hop
      && warm.stack[0].config === recv.get(hash);                   // warm hop resolves the hash to that cached instance
    if (!ok) contentFail = i;
  } catch (e) { console.log("    content threw at iter " + i + ": " + (e as Error).message); contentFail = i; break; }
}
check("content-addressing round-trips through the binary wire (cold inline+cache, warm by hash; 800 graphs)", contentFail < 0, contentFail < 0 ? "" : "first failure at iter " + contentFail);
const cprod = new ContentStore(); const cfg = { schema: "s", fields: [1, 2, 3, 4] }; cprod.register(cfg);
const cwire = encodeWireBinary([{ fn: "F", pc: 0, cfg, args: [] }], null, { content: { store: cprod, peer: newPeerView() } });
let cTrunc = 0; for (let len = 0; len < cwire.length; len++) { try { decodeWireBinary(cwire.subarray(0, len), { content: { store: new ContentStore() } }); } catch (e) { if (e instanceof Error) cTrunc++; } }
check("every truncation of a content wire throws cleanly (the new tags stay bounds-checked)", cTrunc === cwire.length);
let stackSafe = false; const evilCah = new Uint8Array(64); evilCah.set([83, 77, 87, 49], 0); for (let k = 4; k < 64; k++) evilCah[k] = 8;  // a chain of content-cache wrappers (tag 8)
try { decodeWireBinary(evilCah, { content: { store: new ContentStore() } }); } catch (e) { stackSafe = e instanceof RangeError; }
check("a hostile chain of content-cache wrappers fails cleanly, not by stack overflow", stackSafe);

console.log(`\n${pass ? "PASS" : "FAIL"} — binary wire codec: property round-trips, differential vs JSON, boundaries, and decode robustness all hold`);
process.exit(pass ? 0 : 1);
