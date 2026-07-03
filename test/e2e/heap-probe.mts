// Headless probe: the §5 distributed handle heap on a react-tiers continuation.
//
// A continuation holds a BIG dataset local (the heap) and a small projection (the live
// local actually needed downstream). When it migrates, the big local should stay home as
// a §5 handle — the wire ships the small projection, not the dataset — and the other tier
// fetches the dataset only if it derefs the handle, coherently (single-writer + version-
// invalidated cache). Reuses the project's Heap/Channel/makeHost and graph codec.
import { makeTier, encodeWire, decodeWire, wireHandles, Channel, makeHost } from "tierless/heap";
import { makeCheck } from "../lib/check.mts";

const fmt = (n: number): string => (n < 1024 ? n + " B" : n < 1024 * 1024 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB");
const { check, ok } = makeCheck();

console.log("Probe: §5 handle heap on a CPS continuation — big locals stay home, fetched on deref\n");

// --- a continuation: server-side frame holds a big dataset + a small projection ----
interface Row { id: number; title: string; score: number; body: string }
interface Dataset { rows: Row[]; count: number; self?: Dataset }
const body = "markdown body. ".repeat(40);                          // ~600 B/row, the over-fetch payload
const rows: Row[] = Array.from({ length: 1500 }, (_, i) => ({ id: i, title: "Article " + i, score: i % 100, body }));
const dataset: Dataset = { rows, count: rows.length };
dataset.self = dataset;                                              // a cycle, to prove the codec survives the fetch
const summary = { count: dataset.count, top: rows[0].title };       // small: what the next tier actually renders
const stack = [{ fn: "App", pc: 17, dataset, summary, filter: "all", args: [] }];
const request = { op: "resource", tier: "browser", name: "dom.commit", args: [summary] };

// --- inline (whole graph) vs §5 handle (dataset stays on the server) ----------------
const server = makeTier("server");
const inlineWire = encodeWire(stack, request, {});                  // no tier -> everything travels
const handleWire = encodeWire(stack, request, { tier: server, threshold: 8192 });

check("the big dataset excised to exactly one §5 handle owned by the server",
  wireHandles(handleWire).length === 1 && wireHandles(handleWire)[0].owner === "server");
check("the dataset's bodies did NOT travel (stayed on the server)", !handleWire.includes("markdown body"));
check("the small projection DID travel inline", handleWire.includes(summary.top));
check(`the handle wire is far smaller than shipping the dataset inline`, handleWire.length * 10 < inlineWire.length,
  `(${fmt(handleWire.length)} vs ${fmt(inlineWire.length)} = ${(inlineWire.length / handleWire.length).toFixed(0)}x smaller)`);

// --- the other tier decodes: handle stub for dataset, projection intact -------------
const browser = makeTier("browser");
const got = decodeWire(handleWire);
const F = got.stack[0] as any;      // ad hoc fixture — decodeWire's generic DeltaFrame return can't carry this shape
const R = got.request as any;       // same — DeltaRequest's args is unknown[]
check("decoded frame keeps fn/pc and the small locals", F.fn === "App" && F.pc === 17 && F.filter === "all");
check("decoded summary survived intact", F.summary.count === 1500 && R.args[0].top === rows[0].title);
const handle = F.dataset;
check("dataset arrived as a §5 handle, not a copy", handle && handle.__tierless_handle__ === true && handle.owner === "server");

// --- deref on the browser: fetch from the server, identity/cycle-safe ---------------
const channel = new Channel({ server, browser });
const host = makeHost(browser, channel);
const d1 = host.deref(handle) as any;   // deref returns unknown; this probe's fixture shape is checked structurally below
check(`deref fetches the dataset from the server (count ${d1 && d1.count})`, d1.count === 1500 && d1.rows.length === 1500 && d1.rows[0].body === body);
check("the dataset's cycle survived the fetch", d1.self === d1);
check("it cost exactly one fetch across the channel", host.stats.fetches === 1);
host.deref(handle);
check("a second deref is a coherent cache hit (no refetch)", host.stats.fetches === 1 && host.stats.hits === 1);

// --- single-writer coherence: owner mutates -> reader refetches ---------------------
server.heap.mutate(handle.id, (o: any) => { o.count = 9999; });    // the master bumps its version
const d2 = host.deref(handle) as any;
check(`after the owner mutates, the reader refetches the new value (count ${d2 && d2.count})`, d2.count === 9999 && host.stats.fetches === 2);

// --- migrate back: on the owner the handle is local, no fetch -----------------------
const ownerHost = makeHost(server, channel);
const d3 = ownerHost.deref(handle) as any;
check("back on the server the handle is local — master used, zero fetches", d3.count === 9999 && ownerHost.stats.fetches === 0 && ownerHost.stats.localUses === 1);

console.log(`\nWire: dataset ${fmt(inlineWire.length)} inline -> ${fmt(handleWire.length)} with a handle (${channel.fetches} fetches, ${fmt(channel.bytes)} moved only when derefed).`);
console.log(ok()
  ? "PASS — §5 handle heap on a CPS continuation: big locals stay home, fetched on deref, single-writer coherent"
  : "FAIL");
process.exit(ok() ? 0 : 1);
