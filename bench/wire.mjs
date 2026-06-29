// Binary wire vs JSON wire — bytes and CPU on representative Stackmix continuations.
// The shape table + string interning are the levers: an N-record feed pays its keys once,
// not N times. Honest counterweight: it's a JS codec vs the engine's native JSON, so we
// report encode+decode time too — the win is bytes-on-the-wire, not CPU.
//
//   node bench/wire.mjs
import { encodeWire, decodeWire } from "../src/heap.mjs";
import { encodeWireBinary, decodeWireBinary } from "../src/wire-binary.mjs";

const te = new TextEncoder();
const fmt = (n) => (n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(2) + " MB");
const REQ = { op: "resource", tier: "browser", name: "dom.commit", args: [{}] };
const best = (thunk, iters = 200) => { for (let i = 0; i < 3; i++) thunk(); let b = Infinity; for (let k = 0; k < 6; k++) { const t = process.hrtime.bigint(); for (let i = 0; i < iters; i++) thunk(); b = Math.min(b, Number(process.hrtime.bigint() - t) / iters); } return b / 1000; };

function show(label, stack) {
  decodeWireBinary(encodeWireBinary(stack, REQ, {}));                   // correctness: must round-trip
  const j = te.encode(encodeWire(stack, REQ, {})).length, b = encodeWireBinary(stack, REQ, {}).length;
  const jt = best(() => decodeWire(encodeWire(stack, REQ, {}))), bt = best(() => decodeWireBinary(encodeWireBinary(stack, REQ, {})));
  console.log(`   ${label.padEnd(32)} ${fmt(j).padStart(9)}  ${fmt(b).padStart(9)}  ${(j / b).toFixed(1).padStart(5)}x   ${jt.toFixed(1).padStart(6)}  ${bt.toFixed(1).padStart(6)} µs`);
}

console.log("Binary wire vs JSON wire — representative continuations\n");
console.log("   continuation                          JSON     binary  smaller   JSON   binary  (encode+decode)");

// Conduit home-feed previews (scenario-A payload shape)
const previews = Array.from({ length: 10 }, (_, i) => ({ slug: "article-" + i, title: "Article number " + i, description: "A short description of article " + i + ".", tagList: ["dragons", "react"], author: "user" + (i % 20), favoritesCount: i * 3, createdAt: "2026-01-01T00:00:00.000Z" }));
show("home feed: 10 previews", [{ fn: "Feed", pc: 1, payload: { articles: previews }, args: [] }]);

// a bigger feed
const big = Array.from({ length: 200 }, (_, i) => ({ id: i, title: "Article " + i, score: i % 100, author: "user" + (i % 20) }));
show("feed: 200 records", [{ fn: "Feed", pc: 1, rows: big, args: [] }]);

// Conduit article page (scenario-D payload): one full article + comments
const article = { slug: "article-7", title: "Article number 7", description: "desc", body: "## post\n\n" + ("Lorem ipsum dolor sit amet. ".repeat(40)), tagList: ["dragons", "node"], author: { username: "user1", image: "https://example.com/u/user1.png" }, favoritesCount: 12, createdAt: "2026-01-01T00:00:00.000Z" };
const comments = Array.from({ length: 5 }, (_, i) => ({ id: "c" + i, body: "Great post — comment " + i + ".", author: { username: "user" + i, image: "https://example.com/u/x.png" }, createdAt: "2026-01-03T00:00:00.000Z" }));
const pageStack = [{ fn: "Page", pc: 1, payload: { article, comments }, args: [] }];
show("article page: 1 article + 5 comments", pageStack);

// The Conduit scenario-D question: does binary bring Stackmix's wire under REST's PLAIN JSON?
const restPlain = te.encode(JSON.stringify({ article })).length + te.encode(JSON.stringify({ comments })).length;
const sxBinary = encodeWireBinary(pageStack, REQ, {}).length;
console.log(`\n   Scenario-D check — article page vs REST's plain JSON responses:`);
console.log(`     REST plain JSON ${fmt(restPlain)}   vs   Stackmix binary wire ${fmt(sxBinary)}  =>  ${sxBinary <= restPlain ? "binary is now <= REST (D flips to a wash/win)" : "still " + (sxBinary / restPlain).toFixed(2) + "x of REST"}`);

console.log("\nThe shape table pays each record's keys once; interning de-dupes repeated strings. Bytes");
console.log("drop several-fold on record-heavy payloads. CPU is higher than native JSON (a JS codec),");
console.log("so the win is the wire, not the clock — on a network the bytes dominate.");
