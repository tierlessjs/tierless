// Probe: the binary wire codec must decode to a result IDENTICAL to the JSON wire — same
// object identity, cycles, non-enumerable + symbol-keyed properties, Map/Set, BigInt,
// undefined, and §5 handles — and be smaller. The byte format is new; the graph semantics
// are the proven encodeGraph/decodeGraph underneath.
import { encodeWireBinary, decodeWireBinary } from "tierless/wire";
import { encodeWire, makeTier } from "tierless/heap";
import { isHandle } from "tierless/graph";

const te = new TextEncoder();
let pass = true;
const check = (name, cond) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`); pass = pass && cond; };
console.log("Probe: binary wire codec — identical decode (identity/cycles/exotics), smaller than JSON\n");

// --- a continuation exercising identity, cycles, and every exotic value the codec carries ---
const shared = { id: 7, name: "Ada" };
const node = { id: 1, label: "n" }; node.self = node;                    // cycle
const obj = { a: 1, b: "two", c: null, d: true };
Object.defineProperty(obj, "hidden", { value: 42, enumerable: false, writable: true, configurable: true });  // non-enumerable
const sym = Symbol("k"); obj[sym] = "symval";                           // symbol-keyed property
const stack = [{
  fn: "View", pc: 3,
  rows: [shared, shared],                                               // identity: the same object twice
  cyc: node, obj,
  m: new Map([["x", 1], [shared, "shared-as-key"]]), set: new Set([1, 2, shared]),
  big: 9007199254740993n, u: undefined, f: 3.14, neg: -5,
  args: [],
}];
const request = { op: "resource", tier: "browser", name: "dom.commit", args: [{ count: 2 }, shared] };

const { stack: st, request: rq } = decodeWireBinary(encodeWireBinary(stack, request, {}));
const F = st[0];
check("frame skeleton restored (fn/pc)", F.fn === "View" && F.pc === 3);
check("identity preserved: rows[0] === rows[1]", F.rows[0] === F.rows[1] && F.rows[0].name === "Ada");
check("cycle restored: cyc.self === cyc", F.cyc.self === F.cyc && F.cyc.label === "n");
check("primitives intact (null/bool/number/neg/float)", F.obj.a === 1 && F.obj.c === null && F.obj.d === true && F.f === 3.14 && F.neg === -5);
check("non-enumerable property restored as non-enum", F.obj.hidden === 42 && !Object.prototype.propertyIsEnumerable.call(F.obj, "hidden"));
const symKey = Object.getOwnPropertySymbols(F.obj)[0];
check("symbol-keyed property restored (description + value)", symKey && symKey.description === "k" && F.obj[symKey] === "symval");
check("Map restored, incl. object-key identity vs the shared root", F.m.get("x") === 1 && F.m.get(F.rows[0]) === "shared-as-key");
check("Set restored, incl. shared-object membership", F.set.has(1) && F.set.has(F.rows[0]));
check("BigInt exact, undefined preserved", F.big === 9007199254740993n && "u" in F && F.u === undefined);
check("request restored; identity spans frame+request (rq.args[1] === rows[0])", rq.name === "dom.commit" && rq.args[0].count === 2 && rq.args[1] === F.rows[0]);

// --- size vs the JSON wire on a realistic record feed travelling INLINE (the codec's job) ---
const rows = Array.from({ length: 200 }, (_, i) => ({ id: i, title: "Article " + i, score: i % 100, author: "user" + (i % 20) }));
const feed = [{ fn: "Feed", pc: 1, rows, filter: "all", args: [] }];
const feedReq = { op: "resource", tier: "browser", name: "dom.commit", args: [{ n: 200 }] };
const jsonBytes = te.encode(encodeWire(feed, feedReq, {})).length;
const binBytes = encodeWireBinary(feed, feedReq, {}).length;
const back = decodeWireBinary(encodeWireBinary(feed, feedReq, {}));
check("feed round-trips: 200 records, fields intact", back.stack[0].rows.length === 200 && back.stack[0].rows[199].title === "Article 199" && back.stack[0].rows[50].author === "user10");
check(`binary wire is much smaller than JSON on a record feed (${binBytes} B vs ${jsonBytes} B)`, binBytes * 2 < jsonBytes);

// --- §5 excision still works through the binary wire: a big local stays home as a handle ---
const big = [{ fn: "Big", pc: 0, dataset: { blob: "x".repeat(20000) }, small: "k", args: [] }];
const bigReq = { op: "resource", tier: "browser", name: "dom.commit", args: [{}] };
const hb = decodeWireBinary(encodeWireBinary(big, bigReq, { tier: makeTier("server"), threshold: 8192 }));
check("a big local excised to a §5 handle survives the binary wire (small locals intact)", isHandle(hb.stack[0].dataset) && hb.stack[0].small === "k");

// --- typed-array fast path: numeric arrays pack with no per-element tag, round-trip exactly ---
const ids = Array.from({ length: 1000 }, (_, i) => i * 3);             // monotonic int column -> zigzag deltas
const flo = Array.from({ length: 500 }, (_, i) => Math.sin(i) * 1e6);  // floats -> f64 pack
const ta = decodeWireBinary(encodeWireBinary([{ fn: "T", pc: 0, ids, flo, special: [NaN, Infinity, -0, 5], mixed: [1, "two", { x: 3 }], args: [] }], null, {})).stack[0];
check("numeric arrays round-trip exactly (int column, floats, NaN/Inf/-0; a mixed array stays generic)",
  ta.ids[999] === 2997 && ta.flo[3] === Math.sin(3) * 1e6 && Object.is(ta.special[0], NaN) && Object.is(ta.special[2], -0) && ta.mixed[1] === "two" && ta.mixed[2].x === 3);
const idStack = [{ fn: "T", pc: 0, ids, args: [] }];
const idJson = te.encode(encodeWire(idStack, null, {})).length, idBin = encodeWireBinary(idStack, null, {}).length;
check(`a 1000-int column packs tightly (${idBin} B binary vs ${idJson} B JSON = ${(idJson / idBin).toFixed(1)}x)`, idBin * 4 < idJson);

console.log(`\n${pass ? "PASS" : "FAIL"} — binary wire: identical decode (identity/cycles/exotics/handles/typed-arrays) at ${(jsonBytes / binBytes).toFixed(1)}x smaller than JSON on a record feed`);
process.exit(pass ? 0 : 1);
