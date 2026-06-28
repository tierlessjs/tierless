// RealWorld / Conduit, combined into one Stackmix program — measured against the stock
// REST split it replaces. The orchestration (bench/conduit.src.js) is the only thing that
// changed; the backend service functions and the rendered fields are exactly RealWorld's.
//
// Per scenario we report round trips, the DATA DELIVERED to render (REST's JSON responses
// vs the payload Stackmix commits to the browser — full article bodies stay home as a §5
// handle), the modeled wall-clock, and the overhead Stackmix ADDS, so the net is honest.
//
//   node bench/conduit.mjs
import { PROGRAMS } from "./conduit.gen.mjs";
import { encodeWire, decodeWire, wireHandles, makeTier } from "../src/heap.mjs";

const fmt = (n) => (n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(2) + " MB");
const jsonBytes = (o) => Buffer.byteLength(JSON.stringify(o));

// --- a deterministic, realistic RealWorld dataset (article shape per the spec) -----------
let s = 12345; const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const USERS = Array.from({ length: 60 }, (_, i) => "user" + i);
const TAGS = ["dragons", "training", "react", "node", "wasm", "javascript", "ai", "databases", "webdev", "performance"];
const PARA = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore. ";
const ARTICLES = Array.from({ length: 500 }, (_, i) => {
  const author = USERS[(i * 7) % USERS.length];
  const paras = 4 + Math.floor(rnd() * 16);                              // ~0.5–2 KB of Markdown body
  return {
    slug: "article-" + i, title: "Article number " + i,
    description: "A short one-line description of article " + i + ", shown in the preview.",
    body: "## " + author + "'s post\n\n" + (PARA.repeat(paras)),         // FULL body — the over-fetch
    tagList: [TAGS[i % TAGS.length], TAGS[(i * 3) % TAGS.length]],
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
    author: { username: author, bio: "", image: "https://example.com/u/" + author + ".png", following: false },
    favorited: false, favoritesCount: Math.floor(rnd() * 60),
  };
});
const FAVS = new Map(USERS.map((u) => [u, []]));                         // user -> [slug] (kept OUT of the article JSON)
for (const a of ARTICLES) for (const u of USERS) if (rnd() < 0.04) FAVS.get(u).push(a.slug);
const ME = "user0";
const FOLLOWING = USERS.filter((_, i) => i % 5 === 1).slice(0, 10);      // I follow 10 people

// --- the backend's real service functions (the server tier's api.* resources) -----------
function getArticles({ limit, tag, author, favorited } = {}) {
  let r = ARTICLES;
  if (tag) r = r.filter((a) => a.tagList.includes(tag));
  if (author) r = r.filter((a) => a.author.username === author);
  if (favorited) { const set = new Set(FAVS.get(favorited)); r = r.filter((a) => set.has(a.slug)); }
  return (limit != null ? r.slice(0, limit) : r);                       // full articles, bodies included
}
const apiExec = (req) => {
  const a = req.args[0];
  if (req.name === "api.getTags") return TAGS;
  if (req.name === "api.getArticles") return getArticles(a);
  if (req.name === "api.getFollowing") return FOLLOWING;
  throw new Error("no resource " + req.name);
};

// --- the server-tier pump: runs api.* inline, stops (migrates) at commit -----------------
function runStackmix(fn, args) {
  const stack = [{ fn, pc: 0, args }];
  for (;;) {
    const top = stack[stack.length - 1];
    const r = PROGRAMS[top.fn](top);
    if (r.op === "return") { stack.pop(); if (!stack.length) return { done: true, value: r.value }; stack[stack.length - 1].ret = r.value; }
    else if (r.op === "call") { stack.push({ fn: r.fn, pc: 0, args: r.args }); }
    else if (r.tier === "server") { stack[stack.length - 1].ret = apiExec(r); }
    else return { request: r, stack };                                  // commit -> the one migration
  }
}
// DELIVERED bytes = the commit payload that the browser must receive to render (the previews),
// codec-encoded as it crosses, with NO excision — because the previews genuinely travel.
const deliveredBytes = (res) =>
  encodeWire([{ fn: "_", pc: 0, args: [] }], { op: "resource", tier: "browser", name: "dom.commit", args: [res.request.args[0]] }, {}).length;
// how many big locals (the full-body article sets) stayed home as §5 handles on the migration
const bodiesHome = (res) => wireHandles(encodeWire(res.stack, res.request, { tier: makeTier("server"), threshold: 8192 })).length;
// overhead Stackmix ADDS: encode+decode of its actual migrated continuation (best-of-batches)
function serdeUs(res) {
  let best = Infinity;
  for (let b = 0; b < 8; b++) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 1000; i++) decodeWire(encodeWire(res.stack, res.request, { tier: makeTier("server"), threshold: 8192 }));
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1000);
  }
  return best / 1000;
}

// --- latency model: round-trips × RTT + bytes ÷ bandwidth --------------------------------
const RTT_MS = 50, BW_BPS = 12e6;                                       // 50 ms RTT, 12 Mbps (typical 4G)
const wallMs = (rt, b) => rt * RTT_MS + (b * 8 / BW_BPS) * 1000;

function report(name, rest, sx) {
  console.log(`\n${name}`);
  console.log(`                        round trips     data delivered      modeled wall-clock`);
  console.log(`   stock REST split     ${String(rest.rt).padStart(7)}        ${fmt(rest.bytes).padStart(11)}        ${rest.wall.toFixed(0).padStart(6)} ms`);
  console.log(`   Stackmix (1 migrate) ${String(sx.rt).padStart(7)}        ${fmt(sx.bytes).padStart(11)}        ${sx.wall.toFixed(0).padStart(6)} ms`);
  console.log(`   =>  ${(rest.bytes / sx.bytes).toFixed(1)}x less data, ${(rest.wall / sx.wall).toFixed(1)}x faster.  Overhead Stackmix added: ${sx.serde.toFixed(1)} µs to serialize`);
  console.log(`       its continuation; the full article bodies stayed on the server (${sx.home} §5 handle(s)),`);
  console.log(`       fetched only if the user opens an article.`);
}

console.log("RealWorld / Conduit — one combined Stackmix program vs the stock REST split");
console.log(`(${ARTICLES.length} articles w/ full Markdown bodies; RTT ${RTT_MS} ms, bandwidth ${BW_BPS / 1e6} Mbps; bytes uncompressed)`);

// === Scenario A: the home feed (over-fetch) ===
{
  const restBytes = jsonBytes({ tags: TAGS }) + jsonBytes({ articles: getArticles({ limit: 10 }), articlesCount: ARTICLES.length });
  const rest = { rt: 2, bytes: restBytes, wall: wallMs(2, restBytes) };
  const res = runStackmix("homeFeed", [10]);
  const b = deliveredBytes(res);
  const sx = { rt: 1, bytes: b, wall: wallMs(1, b), serde: serdeUs(res), home: bodiesHome(res) };
  report("Scenario A — home feed: render 10 previews; stock GET /articles drags all 10 FULL bodies", rest, sx);
}

// === Scenario B: "articles favorited by people I follow" (a query no single endpoint serves) ===
{
  let restBytes = 0, rt = 0;
  for (const u of FOLLOWING) { restBytes += jsonBytes({ articles: getArticles({ favorited: u }), articlesCount: 0 }); rt++; }  // one GET /articles?favorited= per followed user
  const rest = { rt, bytes: restBytes, wall: wallMs(rt, restBytes) };
  const res = runStackmix("favoritedByFollowed", [ME]);
  const b = deliveredBytes(res);
  const sx = { rt: 1, bytes: b, wall: wallMs(1, b), serde: serdeUs(res), home: bodiesHome(res) };
  report(`Scenario B — articles favorited by the ${FOLLOWING.length} people I follow: REST fans out 1 request per followed user`, rest, sx);
}

console.log("\nNotes (kept honest): bytes are uncompressed — gzip would shrink the over-fetched bodies and");
console.log("narrow Scenario A's data gap, but not the round-trip gap that dominates Scenario B. Stackmix's");
console.log("wire is the verbose graph codec (a binary format, on the roadmap, would shrink its side further).");
console.log("Only the orchestration changed; the backend functions and rendered fields are RealWorld's.");
