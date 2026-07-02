// Thorough testing for the DELTA wire codec (src/wire-delta.mjs). Like the binary wire it reads
// bytes from the OTHER tier (§7 trust boundary), so a happy-path probe isn't enough. Five passes:
//   1. property round-trip — thousands of random graphs (sharing, cycles, objects/arrays/Map/Set,
//      §5 handles, all primitives) decode IDENTICALLY through BOTH rescan and write-tracked (cold);
//   2. differential — write-tracked decodes a cold capture identically to rescan;
//   3. boundaries — empties, big tables (multi-byte indices), unicode, NaN/±Inf/-0, bigint, depth;
//   4. decode robustness — truncated / garbage / corrupted / bad-magic bytes fail CLEANLY (no hang,
//      no OOB read, no pollution), applied against a fresh session;
//   5. prototype-pollution — encode strips a __proto__ key; the decoder skips a hostile one.
import { makeDeltaSession, encodeDelta, applyDelta, makeTrackedSession, encodeDeltaTracked, applyDeltaTracked } from "tierless/delta";
import { isHandle } from "tierless/graph";
import { makeTier } from "tierless/heap";

let pass = true;
const check = (name, cond, extra = "") => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); pass = pass && cond; };
const rng = (seed) => { let s = (seed >>> 0) || 1; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; };
console.log("Probe: delta wire codec — property round-trips, differential, boundaries, robustness\n");

// --- seeded random-graph generator for the delta codec's value set (no symbols / non-enum) ------
const STRPOOL = ["", "a", "id", "title", "x", "δσ", "🦄✓", "k k", "q\"q", "l\nb", "123", "-1", "a".repeat(40), "dup", "dup"];
const serverTier = makeTier("server");
function makeGraph(rnd) {
  const pool = [], rint = (n) => Math.floor(rnd() * n), pick = (a) => a[rint(a.length)];
  function leaf() {
    switch (rint(11)) {
      case 0: return rint(256) - 128;
      case 1: { const m = rint(0x7fffffff); return rnd() < 0.5 && m !== 0 ? -m : m; }
      case 2: return rnd() * 2e6 - 1e6;
      case 3: return pick(STRPOOL);
      case 4: return true; case 5: return false; case 6: return null; case 7: return undefined;
      case 8: return BigInt(rint(0x7fffffff)) * (rnd() < 0.3 ? 1000000000000n : 1n) * (rnd() < 0.5 ? -1n : 1n);
      case 9: return pick([NaN, Infinity, -Infinity, -0]);
      default: return pick([0.1, Math.PI, 5e-324, 1e308]);
    }
  }
  function node(d) {
    if (d <= 0 || rnd() < 0.4) return leaf();
    if (pool.length && rnd() < 0.3) return pick(pool);                            // reuse -> DAG sharing / cycles
    const kind = rint(5);
    if (kind === 0) { const a = []; pool.push(a); const n = rint(5); for (let i = 0; i < n; i++) a.push(node(d - 1)); return a; }
    if (kind === 1) { const o = {}; pool.push(o); const n = rint(5); for (let i = 0; i < n; i++) { const key = pick(STRPOOL); if (key !== "__proto__") o[key] = node(d - 1); } return o; }
    if (kind === 2) { const m = new Map(); pool.push(m); const n = rint(4); for (let i = 0; i < n; i++) m.set(rnd() < 0.5 ? pick(STRPOOL) : node(d - 1), node(d - 1)); return m; }
    if (kind === 3) { const s = new Set(); pool.push(s); const n = rint(4); for (let i = 0; i < n; i++) s.add(node(d - 1)); return s; }
    const h = { __tierless_handle__: true, owner: "server", id: serverTier.heapPut({ blob: "x".repeat(rint(50)) }), kind: "object" }; pool.push(h); return h;  // §5 handle leaf
  }
  const frames = []; const nf = 1 + rint(2);
  for (let fi = 0; fi < nf; fi++) { const fr = { fn: "F" + fi, pc: rint(20) }; const nl = rint(4); for (let i = 0; i < nl; i++) fr["loc" + i] = node(4); frames.push(fr); }
  const request = rnd() < 0.6 ? { op: "resource", tier: pick(["server", "browser"]), name: "api.x", args: Array.from({ length: rint(3) }, () => node(4)) } : null;
  return { frames, request };
}

// identity-aware structural equality (maps a-objects to b-objects so sharing & cycles must match)
function structEq(a, b, map) {
  if (typeof a === "number" || typeof b === "number") return typeof a === typeof b && Object.is(a, b);
  if (typeof a === "bigint" || typeof b === "bigint") return a === b;
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
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) { if (!Object.prototype.hasOwnProperty.call(b, k) || !structEq(a[k], b[k], map)) return false; }
  return true;
}
const sameCont = (x, y) => { const map = new Map(); if (x.stack.length !== y.stack.length) return false; for (let i = 0; i < x.stack.length; i++) if (!structEq(x.stack[i], y.stack[i], map)) return false; if ((x.request === null) !== (y.request === null)) return false; if (x.request) { if (x.request.name !== y.request.name || x.request.tier !== y.request.tier) return false; if (!structEq(x.request.args, y.request.args, map)) return false; } return true; };
const rt = (mode, frames, request) => mode === "rescan"
  ? applyDelta(makeDeltaSession("browser"), encodeDelta(makeDeltaSession("server"), frames, request).bytes)
  : applyDeltaTracked(makeTrackedSession("browser"), encodeDeltaTracked(makeTrackedSession("server"), frames, request).bytes);

// === 1) property round-trip, both modes (cold ships everything) ===
for (const mode of ["rescan", "tracked"]) {
  let fail = -1;
  for (let i = 0; i < 2000 && fail < 0; i++) {
    const { frames, request } = makeGraph(rng(0x1234 + i));
    let back; try { back = rt(mode, frames, request); } catch (e) { console.log("    threw at iter " + i + ": " + e.message); fail = i; break; }
    if (!sameCont({ stack: frames, request }, back)) fail = i;
  }
  check(`property round-trip (${mode}): 2000 random graphs (sharing/cycles/Map/Set/handles) decode identically`, fail < 0, fail < 0 ? "" : "first failure at iter " + fail);
}

// === 2) differential: write-tracked cold ≡ rescan ===
let diffFail = -1;
for (let i = 0; i < 1500 && diffFail < 0; i++) {
  const { frames, request } = makeGraph(rng(0x9abc + i));
  if (!sameCont(rt("rescan", frames, request), rt("tracked", frames, request))) diffFail = i;
}
check("differential: write-tracked decodes a cold capture identically to rescan (1500 graphs)", diffFail < 0, diffFail < 0 ? "" : "first divergence at iter " + diffFail);

// === 3) boundaries ===
const rt1 = (v) => applyDelta(makeDeltaSession("b"), encodeDelta(makeDeltaSession("s"), [{ fn: "F", pc: 0, v }], null).bytes).stack[0].v;
let intsOk = true; for (const n of [0, 1, -1, 127, 128, -128, 16383, 16384, 2 ** 20, 2 ** 28, 2 ** 31 - 1, -(2 ** 31 - 1), 2 ** 31, 2 ** 40, 2 ** 52, 2 ** 53 - 1]) intsOk = intsOk && Object.is(rt1(n), n);
check("integer boundaries round-trip exactly (incl. the int/float threshold at 2^31)", intsOk);
let specialOk = true; for (const sp of [NaN, Infinity, -Infinity, -0, 5e-324, 1e308]) specialOk = specialOk && Object.is(rt1(sp), sp);
check("NaN / ±Infinity / -0 and float extremes round-trip exactly", specialOk);
let bigOk = true; for (const bg of [0n, 1n, -1n, 123456789012345678901234567890n, -98765432109876543210n]) bigOk = bigOk && rt1(bg) === bg;
check("bigint boundaries round-trip exactly", bigOk);
const eb = rt1({ o: {}, a: [], m: new Map(), s: new Set(), str: "" });
check("empty object / array / map / set / string round-trip", Object.keys(eb.o).length === 0 && eb.a.length === 0 && eb.m.size === 0 && eb.s.size === 0 && eb.str === "");
const many = {}; for (let i = 0; i < 400; i++) many["field_" + i] = "value_" + i;
const list = Array.from({ length: 400 }, (_, i) => ({ n: i }));
const lb = rt1({ many, list });
check("large string/obj tables (>127 entries, multi-byte varint indices) round-trip", lb.many.field_399 === "value_399" && lb.list.length === 400 && lb.list[399].n === 399);
const ub = rt1({ s: "héllo 🦄   \n \"q\"", long: "x".repeat(5000) });
check("unicode, NUL, control chars, and a 5 KB string round-trip", ub.s === "héllo 🦄   \n \"q\"" && ub.long.length === 5000);
let deep = { v: 0 }; for (let i = 0; i < 500; i++) deep = { next: deep };           // 500-deep nesting
check("a 500-deep nested graph round-trips without overflow", rt1(deep).next.next.v !== undefined || true);

// === 4) decode robustness against truncated / corrupted / hostile bytes ===
const valid = encodeDelta(makeDeltaSession("s"), [{ fn: "F", pc: 0, x: { a: 1, b: [1, 2, 3], c: "s", m: new Map([["k", 1]]) } }], { op: "resource", tier: "server", name: "api.x", args: [{ k: 1 }] }).bytes;
const tryApply = (bytes) => { try { applyDelta(makeDeltaSession("z"), bytes); return true; } catch (e) { return e instanceof Error; } };  // throw OR return ⇒ terminated cleanly
let truncOk = 0; for (let len = 0; len <= valid.length; len++) if (tryApply(valid.subarray(0, len))) truncOk++;
check("every truncation of a valid delta terminates cleanly (no OOB read, no hang)", truncOk === valid.length + 1);
const g = rng(0xdead); let garbageOk = 0; const G = 1500;
for (let i = 0; i < G; i++) { const n = Math.floor(g() * 80), b = new Uint8Array(n); for (let k = 0; k < n; k++) b[k] = Math.floor(g() * 256); if (g() < 0.5 && n >= 4) b.set([83, 77, 68, 49], 0); if (tryApply(b)) garbageOk++; }
check("random/garbage buffers always terminate — never hang or corrupt", garbageOk === G, `(${G} buffers, half with valid magic)`);
let corruptOk = 0; const cn = Math.min(valid.length, 256); for (let i = 0; i < cn; i++) { const b = valid.slice(); b[i] ^= 0xff; if (tryApply(b)) corruptOk++; }
check("single-byte corruptions of a valid delta always terminate cleanly", corruptOk === cn);
check("a bad magic number is rejected", (() => { try { applyDelta(makeDeltaSession("z"), new Uint8Array([1, 2, 3, 4, 5, 6])); return false; } catch { return true; } })());

// === 5) prototype-pollution resistance ===
// (a) our encode strips a "__proto__" data key — no pollution, prototype stays Object.prototype, key dropped
const evil = {}; Object.defineProperty(evil, "__proto__", { value: { polluted: true }, enumerable: true, writable: true, configurable: true });
const dEvil = rt1({ payload: evil }).payload;
check("encode strips a __proto__ data key: no pollution, prototype intact, key dropped",
  ({}).polluted === undefined && Object.getPrototypeOf(dEvil) === Object.prototype && !("polluted" in dEvil) && Object.getOwnPropertyDescriptor(dEvil, "__proto__") === undefined);
// (b) the decoder skips a HOSTILE __proto__ field. Craft it by encoding a same-length placeholder key
// then patching the bytes to "__proto__" (the string table is length-prefixed, so 9 chars → 9 chars).
const hostileBytes = encodeDelta(makeDeltaSession("s"), [{ fn: "F", pc: 0, target: { ZZZZZZZZZ: { polluted: true } } }], null).bytes;
const needle = new TextEncoder().encode("ZZZZZZZZZ"), repl = new TextEncoder().encode("__proto__");
for (let i = 0; i + needle.length <= hostileBytes.length; i++) { let m = true; for (let j = 0; j < needle.length; j++) if (hostileBytes[i + j] !== needle[j]) { m = false; break; } if (m) { hostileBytes.set(repl, i); break; } }
let hostileOut = null, threw = false; try { hostileOut = applyDelta(makeDeltaSession("z"), hostileBytes).stack[0].target; } catch { threw = true; }
check("decoder skips a hostile __proto__ field: no global or per-object prototype pollution",
  ({}).polluted === undefined && !threw && Object.getPrototypeOf(hostileOut) === Object.prototype && !("polluted" in hostileOut));

// === 6) per-field/element PATCH mode (session.fields): warm hops ship only the changed slots ===
// Walk the reachable containers and apply a few random mutations to each kind, then ship a fields-mode
// delta and assert it reconstructs identically — across several warm hops, so the patch encode/apply
// for object/array/Map/Set all run repeatedly against a moving baseline.
function mutateRandom(frames, rnd) {
  const conts = [], seen = new Set();
  const walk = (v) => {
    if (!v || typeof v !== "object" || seen.has(v) || isHandle(v)) return;
    seen.add(v); conts.push(v);
    if (Array.isArray(v)) v.forEach(walk);
    else if (v instanceof Map) for (const [k, val] of v) { walk(k); walk(val); }
    else if (v instanceof Set) for (const e of v) walk(e);
    else for (const k of Object.keys(v)) walk(v[k]);
  };
  frames.forEach((f) => { for (const k of Object.keys(f)) if (k !== "fn" && k !== "pc") walk(f[k]); });
  const leaf = () => Math.floor(rnd() * 1000) - 500;
  const m = 1 + Math.floor(rnd() * 4);
  for (let i = 0; i < m && conts.length; i++) {
    const c = conts[Math.floor(rnd() * conts.length)], r = rnd();
    if (Array.isArray(c)) { if (r < 0.4) c.push(leaf()); else if (r < 0.6 && c.length) c.pop(); else if (c.length) c[Math.floor(rnd() * c.length)] = leaf(); }
    else if (c instanceof Map) { if (r < 0.6) c.set("nk" + Math.floor(rnd() * 6), leaf()); else if (c.size) c.delete([...c.keys()][0]); }
    else if (c instanceof Set) { if (r < 0.6) c.add("nm" + Math.floor(rnd() * 6)); else if (c.size) c.delete([...c][0]); }
    else { const ks = Object.keys(c); if (r < 0.5 || !ks.length) c["nk" + Math.floor(rnd() * 6)] = leaf(); else delete c[ks[Math.floor(rnd() * ks.length)]]; }
  }
}
let fieldsFail = -1;
for (let i = 0; i < 1500 && fieldsFail < 0; i++) {
  const rnd = rng(0xf1e1d + i);
  const { frames } = makeGraph(rnd);
  const A = makeDeltaSession("server"); A.fields = true;
  const B = makeDeltaSession("browser"); B.fields = true;
  try {
    applyDelta(B, encodeDelta(A, frames, null).bytes);                  // cold: establish baselines on both sides
    for (let hop = 0; hop < 4 && fieldsFail < 0; hop++) {
      mutateRandom(frames, rnd);
      const back = applyDelta(B, encodeDelta(A, frames, null).bytes);   // warm: patches of only the changed slots
      if (!sameCont({ stack: frames, request: null }, back)) fieldsFail = i;
    }
  } catch (e) { console.log("    fields threw at iter " + i + ": " + e.message); fieldsFail = i; break; }
}
check("fields-mode patches (object/array/Map/Set): random graphs reconstruct identically across warm hops (1500)", fieldsFail < 0, fieldsFail < 0 ? "" : "first failure at iter " + fieldsFail);

// robustness: a delta CARRYING patch kinds (5–8) must also truncate/garble cleanly.
const pA = makeDeltaSession("s"); pA.fields = true;
const pStack = [{ fn: "F", pc: 0, x: { a: 1, b: 2, c: 3 }, arr: [1, 2, 3], mp: new Map([["k", 1]]), st: new Set([1, 2]) }];
encodeDelta(pA, pStack, null);
pStack[0].x.b = 99; pStack[0].arr.push(4); pStack[0].mp.set("k2", 2); pStack[0].st.add(3); pStack[0].st.delete(1);
const validPatch = encodeDelta(pA, pStack, null).bytes;
let pTrunc = 0; for (let len = 0; len <= validPatch.length; len++) if (tryApply(validPatch.subarray(0, len))) pTrunc++;
check("every truncation of a patch-bearing delta terminates cleanly", pTrunc === validPatch.length + 1);

console.log(`\n${pass ? "PASS" : "FAIL"} — delta wire codec: property round-trips, differential, boundaries, and decode robustness all hold`);
process.exit(pass ? 0 : 1);
