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
import { encodeGraph, decodeGraph } from "../../src/graph.mjs";
import { ContentStore, newPeerView, hashOf } from "../../src/content.mjs";

const deepFreeze = (o) => { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); } return o; };
const size = (enc) => JSON.stringify(enc).length;

let pass = 0, fail = 0;
const check = (label, cond) => { if (cond) { pass++; console.log(`  PASS  ${label}`); } else { fail++; console.log(`  FAIL  ${label}`); } };

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
const dec1 = decodeGraph(enc1, { content: { store: recv } })[0];

check("cold hop: CONFIG travels inline (the bytes are on the wire)", JSON.stringify(enc1).includes("immutable config field number 199"));
check("cold hop: it reconstructs faithfully", dec1[0].config.fields.length === 200 && dec1[0].config.fields[199].doc === "immutable config field number 199");
check("cold hop: two references to CONFIG decode to ONE object (shared identity preserved)", dec1[0].config === dec1[0].alsoConfig);
check("cold hop: the receiver cached it under the same hash", recv.has(hash) && recv.get(hash) === dec1[0].config);
check("the content hash is stable (same immutable subgraph -> same hash)", hashOf(CONFIG) === hash);

// ── Hop 2 (warm): same immutable CONFIG, changed UI. Now the peer holds the hash. ───────────────────
const stack2 = [{ fn: "View", pc: 5, config: CONFIG, alsoConfig: CONFIG, ui: { route: "article", scroll: 120 } }];
const enc2 = encodeGraph([stack2], { content });
const wire2 = size(enc2);
const dec2 = decodeGraph(enc2, { content: { store: recv } })[0];

check("warm hop: CONFIG is NOT inline — only its hash crosses", !JSON.stringify(enc2).includes("immutable config field number 199"));
check("warm hop: the hash resolves to the SAME instance the receiver already held (identity by content)", dec2[0].config === recv.get(hash) && dec2[0].config === dec1[0].config);
check("warm hop: the changed UI still travels and reconstructs", dec2[0].ui.route === "article" && dec2[0].ui.scroll === 120);
check(`warm hop is dramatically smaller (${wire1} B inline -> ${wire2} B by hash, ${(wire1 / wire2).toFixed(0)}x)`, wire2 * 5 < wire1);

// Control: WITHOUT a content store the same warm capture ships CONFIG inline again (the win is real).
const baseline = size(encodeGraph([stack2]));
check(`control: without content-addressing the warm capture re-ships CONFIG inline (${baseline} B)`, baseline > wire2 * 5);

// ── Opt-in & composable: an UNregistered graph with cycles round-trips untouched even with content on. ─
const node = { name: "n" }; node.self = node;             // a cycle, NOT registered as immutable
const enc3 = encodeGraph([node], { content: { store: prod, peer: newPeerView() } });
const dec3 = decodeGraph(enc3, { content: { store: recv } })[0];
check("composable: an unregistered cyclic object still round-trips (content-addressing is opt-in)", dec3.self === dec3 && dec3.name === "n");

const ok = fail === 0;
console.log(ok
  ? `\nPASS — content-addressed immutable subgraphs ship once then by hash, resolving to the held copy (identity by content); the win is real and the codec is otherwise untouched (${pass} checks)`
  : `\nFAIL (${pass} passed, ${fail} failed)`);
process.exit(ok ? 0 : 1);
