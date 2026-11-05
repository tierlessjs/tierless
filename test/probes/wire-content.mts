// Probe: CONTENT-ADDRESSED subgraphs (src/content.mjs + the graph codec). Some subgraphs are
// immutable — code, class shapes, config — and need not travel as bytes more than once. If the peer
// already holds a subgraph's content hash, ship the hash, not the bytes. This generalizes how globals
// already travel (a `Math` is shipped by name, never copied) from "things with a well-known name" to
// "any immutable subgraph, named by its content."
//
// What must hold:
//   1. Cold hop ships the subgraph inline (the peer doesn't have it yet) and the receiver caches it.
//   2. Warm hop ships only a tiny hash reference; the receiver resolves it to the copy it cached.
//   3. Identity by content — the resolved subgraph is the SAME instance the receiver already held,
//      across hops, and shared references within a capture stay shared.
//   4. It is opt-in and composable — an UNregistered object still round-trips normally (identity,
//      cycles), so content-addressing one subgraph doesn't disturb the rest of the graph.
import { encodeGraph, decodeGraph, isHandle, VIEW, type Handle } from "tierless/graph";
import { encodeWireBinary, decodeWireBinary } from "tierless/wire";
import { makeTrackedSession, subForFullWire, exciseForCapture, adoptBaseline } from "tierless/delta";
import { makeTier } from "tierless/heap";
import { ContentStore, newPeerView, hashOf } from "tierless/content";
import { makeCounter } from "../lib/check.mts";

const deepFreeze = <T,>(o: T): T => { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const k of Object.keys(o)) deepFreeze((o as unknown as Record<string, unknown>)[k]); } return o; };
const size = (enc: unknown): number => JSON.stringify(enc).length;

const { check, counts } = makeCounter();

console.log("Probe: content-addressed immutable subgraphs (ship once, then by hash)\n");

// A sizable IMMUTABLE config — the kind of subgraph that recurs identically across many hops.
const CONFIG = deepFreeze({
  schema: "article", version: 3,
  fields: Array.from({ length: 200 }, (_, i) => ({ name: "f" + i, type: i % 2 ? "string" : "number", required: i % 3 === 0, doc: "immutable config field number " + i })),
});

// Producer + receiver each keep a content store; the producer also tracks what THIS peer holds.
const prod = new ContentStore(), recv = new ContentStore();
const sent = newPeerView();
const hash = prod.register(CONFIG);                       // mark it immutable -> the codec can name it by hash
const content = { store: prod, peer: sent };

// ── Hop 1 (cold): the peer doesn't have CONFIG yet, so it ships inline; the receiver caches it. ──────
const stack1 = [{ fn: "View", pc: 2, config: CONFIG, alsoConfig: CONFIG, ui: { route: "home", scroll: 0 } }];
const enc1 = encodeGraph([stack1], { content });
const wire1 = size(enc1);
// decodeGraph is generic (unknown[] out) — cast to the ad hoc shape this probe put on the wire, as in codec.mts/wire-binary.mts.
const dec1 = decodeGraph(enc1, { content: { store: recv } })[0] as any;

check("cold hop: CONFIG travels inline (the bytes are on the wire)", JSON.stringify(enc1).includes("immutable config field number 199"));
check("cold hop: it reconstructs faithfully", dec1[0].config.fields.length === 200 && dec1[0].config.fields[199].doc === "immutable config field number 199");
check("cold hop: two references to CONFIG decode to ONE object (shared identity preserved)", dec1[0].config === dec1[0].alsoConfig);
check("cold hop: the receiver cached it under the same hash", recv.has(hash) && recv.get(hash) === dec1[0].config);
check("the content hash is stable (same immutable subgraph -> same hash)", hashOf(CONFIG) === hash);

// ── Hop 2 (warm): same immutable CONFIG, changed UI. Now the peer holds the hash. ───────────────────
const stack2 = [{ fn: "View", pc: 5, config: CONFIG, alsoConfig: CONFIG, ui: { route: "article", scroll: 120 } }];
const enc2 = encodeGraph([stack2], { content });
const wire2 = size(enc2);
const dec2 = decodeGraph(enc2, { content: { store: recv } })[0] as any;

check("warm hop: CONFIG is NOT inline — only its hash crosses", !JSON.stringify(enc2).includes("immutable config field number 199"));
check("warm hop: the hash resolves to the SAME instance the receiver already held (identity by content)", dec2[0].config === recv.get(hash) && dec2[0].config === dec1[0].config);
check("warm hop: the changed UI still travels and reconstructs", dec2[0].ui.route === "article" && dec2[0].ui.scroll === 120);
check(`warm hop is dramatically smaller (${wire1} B inline -> ${wire2} B by hash, ${(wire1 / wire2).toFixed(0)}x)`, wire2 * 5 < wire1);

// Control: WITHOUT a content store the same warm capture ships CONFIG inline again (the win is real).
const baseline = size(encodeGraph([stack2]));
check(`control: without content-addressing the warm capture re-ships CONFIG inline (${baseline} B)`, baseline > wire2 * 5);

// ── Opt-in & composable: an UNregistered graph with cycles round-trips untouched even with content on. ─
const node = { name: "n", self: null as unknown }; node.self = node;   // a cycle, NOT registered as immutable
const enc3 = encodeGraph([node], { content: { store: prod, peer: newPeerView() } });
const dec3 = decodeGraph(enc3, { content: { store: recv } })[0] as any;
check("composable: an unregistered cyclic object still round-trips (content-addressing is opt-in)", dec3.self === dec3 && dec3.name === "n");

// ── Through the BINARY wire — the frame that actually crosses the socket ─────────────────────────────
const prodB = new ContentStore(), recvB = new ContentStore(), sentB = newPeerView();
const hashB = prodB.register(CONFIG);
const b1 = encodeWireBinary([{ fn: "View", pc: 2, config: CONFIG, alsoConfig: CONFIG, ui: { route: "home" } }], null, { content: { store: prodB, peer: sentB } });
const db1 = decodeWireBinary(b1, { content: { store: recvB } });
const f1 = db1.stack[0] as any;                            // DeltaFrame's index signature types extra fields unknown; cast to access the ad hoc shape
check("binary cold hop: CONFIG reconstructs, shared identity holds, cached by hash", f1.config.fields[199].doc === "immutable config field number 199" && f1.config === f1.alsoConfig && recvB.get(hashB) === f1.config);
const b2 = encodeWireBinary([{ fn: "View", pc: 5, config: CONFIG, alsoConfig: CONFIG, ui: { route: "article" } }], null, { content: { store: prodB, peer: sentB } });
const db2 = decodeWireBinary(b2, { content: { store: recvB } });
const f2 = db2.stack[0] as any;
check(`binary warm hop: only the hash crosses (${b1.length} B -> ${b2.length} B), resolving to the cached instance`, b2.length * 5 < b1.length && f2.config === recvB.get(hashB) && f2.ui.route === "article");

// ── Composition: content-addressing + §5 excision + the min(delta, full) FULL arm together ──────────
const tier = makeTier("server"), session = makeTrackedSession(tier.id);
const cprod = new ContentStore(), crecv = new ContentStore(), ct = { store: cprod, peer: newPeerView() };
const chash = cprod.register(CONFIG);
const DATASET = { rows: Array.from({ length: 3000 }, (_, i) => ({ id: i, v: "row " + i })) };  // big + MUTABLE -> §5 handle (excision), not content
const THRESH = 8192;

// Cold FULL hop: CONFIG content-addressed (inline + cache), DATASET excised to a §5 handle that stays home.
const stackC1 = [{ fn: "View", pc: 1, config: CONFIG, data: DATASET, ui: { route: "home" } }];
exciseForCapture(session, stackC1, null, tier, THRESH, ct);
const subC1 = subForFullWire(session, stackC1, null, ct);
const full1 = encodeWireBinary(subC1.stack, subC1.request, { content: ct });
const dc1 = decodeWireBinary(full1, { content: { store: crecv } });
adoptBaseline(session, stackC1, null);                    // establish the shared baseline (walks CONFIG in full — content stays id-consistent)
check("compose cold: CONFIG reconstructs, DATASET stayed home as a §5 handle, CONFIG cached by hash",
  (dc1.stack[0].config as any).fields.length === 200 && isHandle(dc1.stack[0].data) && crecv.get(chash) === dc1.stack[0].config);

// Re-frame FULL hop (the case min(delta, full) falls back to a full frame): the immutable CONFIG now ships by HASH.
const stackC2 = [{ fn: "View", pc: 9, config: CONFIG, data: DATASET, ui: { route: "article", scroll: 200 } }];
exciseForCapture(session, stackC2, null, tier, THRESH, ct);
const subC2 = subForFullWire(session, stackC2, null, ct);
const full2 = encodeWireBinary(subC2.stack, subC2.request, { content: ct });
const dc2 = decodeWireBinary(full2, { content: { store: crecv } });
check(`compose re-frame: CONFIG ships by hash (not re-inlined), DATASET still a handle (${full1.length} B -> ${full2.length} B)`,
  full2.length * 5 < full1.length && dc2.stack[0].config === crecv.get(chash) && isHandle(dc2.stack[0].data));

// ── VIEWS BY CONTENT (graph.mts viewOf): a plain DATA member of an excised object's view — a library
// instance's table — ships inline once, tagged with its hash; while its content stands, every later
// crossing carries the member's handle and the hash (slot "cv") and the receiver copies it from what
// it holds. Nothing is registered: the hash is taken as the view ships. ─────────────────────────────
{
  const tierV = makeTier("browser");
  class Lib { table: Record<string, string>; hits: number; constructor(table: Record<string, string>) { this.table = table; this.hits = 0; } }
  const mkTable = (n: number, tag = ""): Record<string, string> => { const t: Record<string, string> = {}; for (let i = 0; i < n; i++) t["key." + i] = "translation number " + i + " with a few more words" + tag; return t; };
  const table = mkTable(400);                                                        // ~20 KB: well over the 2 KB floor
  const lib = new Lib(table);
  const excise = (v: unknown): boolean => v === lib;                               // browser-owned: it crosses as an instance view
  type Pair = { store: ContentStore; peer: ContentStore };
  const send = (c: Pair, frame: Record<string, unknown>, who: object = lib): Uint8Array => encodeWireBinary([{ fn: "Use", pc: 1, lib: who, ...frame }], null, { tier: tierV, excise: (v) => v === who, threshold: 1 << 20, content: c });
  const pc: Pair = { store: new ContentStore(), peer: newPeerView() }, rc = { store: new ContentStore() };   // producer's pair; receiver's store
  const top = (bin: Uint8Array, c: { store: ContentStore } = rc): any => decodeWireBinary(bin, { content: c }).stack[0];
  const w1 = send(pc, { n: 1 }), d1 = top(w1);
  const w2 = send(pc, { n: 2 }), d2 = top(w2);
  check(`cold: the table ships inline inside the instance's view (${w1.length} B)`, w1.length > 15000 && d1.lib.table["key.399"] === table["key.399"] && Object.keys(d1.lib.table).length === 400);
  check(`warm: the table crosses by hash (${w2.length} B) and reads the same`, w2.length < 1500 && d2.lib.table["key.399"] === table["key.399"] && Object.keys(d2.lib.table).length === 400);
  const h1 = d1.lib.table[VIEW] as Handle, h2 = d2.lib.table[VIEW] as Handle;
  check("warm: the copy carries THIS crossing's member handle (a home id minted per crossing, the same path)", h2.owner === "browser" && h2.id !== h1.id && h2.id === (d2.lib[VIEW] as Handle).id && (h2.path ?? []).join(".") === "table");
  d2.lib.table["key.0"] = "written on the far tier";
  const d3 = top(send(pc, { n: 3 }));
  check("warm: every crossing gets a fresh copy — a write to one never shows in the next", d3.lib.table["key.0"] === table["key.0"] && d3.lib.table !== d2.lib.table);
  table["key.0"] = "changed at home";
  const w4 = send(pc, { n: 4 }), d4 = top(w4);
  const w5 = send(pc, { n: 5 });
  check(`changed at home: a new hash — inline once more (${w4.length} B), then by hash (${w5.length} B)`, w4.length > 15000 && d4.lib.table["key.0"] === "changed at home" && w5.length < 1500);
  // not data: a member whose view would leave something home (a function in it) is never cached
  const lib2 = new Lib(mkTable(400, "-2")); (lib2.table as Record<string, unknown>).fmt = (s: string) => s.toUpperCase();
  const x1 = send(pc, { n: 1 }, lib2), x2 = send(pc, { n: 2 }, lib2);
  check("a member holding a function is not data: it ships inline every time (never by hash)", x1.length > 15000 && x2.length > 15000 && typeof top(x2).lib.table.fmt === "object");
  // a plain excised ROOT is cached the same way
  const cfg = { rows: mkTable(300, "-cfg") };
  const r1 = send(pc, { n: 1 }, cfg); top(r1);                                      // every shipped frame is decoded: the two caches move together
  const r2 = send(pc, { n: 2 }, cfg), dr2 = top(r2);
  check(`a plain excised root crosses by hash too (${r1.length} B -> ${r2.length} B), under its own fresh handle`, r2.length < 1500 && dr2.lib.rows["key.299"] === cfg.rows["key.299"] && (dr2.lib[VIEW] as Handle).owner === "browser" && !(dr2.lib[VIEW] as Handle).path);
  // bounded on both sides by the same numbers: past the budget the oldest goes, so the producer ships
  // it inline again and the receiver — which dropped it too — takes it as new
  const sp: Pair = { store: new ContentStore(30000), peer: new ContentStore(30000) }, sr = { store: new ContentStore(30000) };
  const la = new Lib(mkTable(400, "-a")), lb = new Lib(mkTable(400, "-b"));
  const a1 = send(sp, { n: 1 }, la); top(a1, sr); const b1 = send(sp, { n: 1 }, lb); top(b1, sr);   // ~20 KB each: b evicts a on both sides
  const a2 = send(sp, { n: 2 }, la), da2 = top(a2, sr);
  const a3 = send(sp, { n: 3 }, la);
  check(`mirrored bound: the evicted table ships inline again (${a2.length} B) and decodes, then by hash (${a3.length} B)`, a2.length > 15000 && da2.lib.table["key.1"] === la.table["key.1"] && a3.length < 1500);
  // a receiver that does not hold the hash fails loudly, never with an empty member
  let loud = false;
  try { top(w5, { store: new ContentStore() }); } catch (e) { loud = e instanceof RangeError && /not held/.test((e as Error).message); }
  check("a hash the receiver does not hold is a RangeError (the two caches out of step), not a silent gap", loud);
}

const { pass, fail } = counts();
const ok = fail === 0;
console.log(ok
  ? `\nPASS — content-addressed immutable subgraphs ship once then by hash, resolving to the held copy (identity by content); the win is real and the codec is otherwise untouched (${pass} checks)`
  : `\nFAIL (${pass} passed, ${fail} failed)`);
process.exit(ok ? 0 : 1);
