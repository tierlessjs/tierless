// RealWorld / Conduit, combined into one Tierless program — measured against the stock
// REST split it replaces. Only the orchestration (bench/conduit.src.js) changed; the backend
// service functions and the rendered fields are RealWorld's.
//
// Honest latency model: independent requests PARALLELIZE (a real client fires them at once,
// ~1 round-trip wave per CONC connections); a DEPENDENT chain cannot (one round trip per
// step). That distinction is the whole story — Tierless's robust latency win is the round
// trips you can't parallelize away.
//
//   node bench/conduit.mts
import { PROGRAMS } from "./conduit.gen.mjs";
import { encodeWire, decodeWire, wireHandles, makeTier } from "tierless/heap";
import type { Frame, ResourceRequest } from "tierless/runtime";

const fmt = (n: number): string => (n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(2) + " MB");
const jsonBytes = (o: unknown): number => Buffer.byteLength(JSON.stringify(o));

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
    relatedSlug: "article-" + ((i * 7 + 1) % 500),                       // a "related article" link (for the dependent chain)
    tagList: [TAGS[i % TAGS.length], TAGS[(i * 3) % TAGS.length]],
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
    author: { username: author, bio: "", image: "https://example.com/u/" + author + ".png", following: false },
    favorited: false, favoritesCount: Math.floor(rnd() * 60),
  };
});
type Article = (typeof ARTICLES)[number];
const BY_SLUG = new Map(ARTICLES.map((a) => [a.slug, a]));
const FAVS = new Map(USERS.map((u): [string, string[]] => [u, []]));
for (const a of ARTICLES) for (const u of USERS) if (rnd() < 0.04) FAVS.get(u)!.push(a.slug);   // u always present: seeded from the same USERS list
const COMMENTS = new Map(ARTICLES.map((a) => {
  const n = Math.floor(rnd() * 8);
  return [a.slug, Array.from({ length: n }, (_, k) => ({
    id: a.slug + "-c" + k, body: "Great post — comment " + k + ". " + PARA.slice(0, 70),
    author: { username: USERS[(k * 11) % USERS.length], image: "https://example.com/u/x.png" }, createdAt: "2026-01-03T00:00:00.000Z",
  }))] as [string, unknown[]];
}));
const ME = "user0";
const FOLLOWING = USERS.filter((_, i) => i % 5 === 1).slice(0, 10);

// --- the backend's real service functions (the server tier's api.* resources) -----------
interface ArticleFilter { limit?: number; tag?: string; author?: string; favorited?: string }
function getArticles({ limit, tag, author, favorited }: ArticleFilter = {}): Article[] {
  let r = ARTICLES;
  if (tag) r = r.filter((a) => a.tagList.includes(tag));
  if (author) r = r.filter((a) => a.author.username === author);
  if (favorited) { const set = new Set(FAVS.get(favorited)); r = r.filter((a) => set.has(a.slug)); }
  return (limit != null ? r.slice(0, limit) : r);
}
const apiExec = (req: ResourceRequest): unknown => {
  const a = req.args[0];
  if (req.name === "api.getTags") return TAGS;
  if (req.name === "api.getArticles") return getArticles(a as ArticleFilter);
  if (req.name === "api.getArticle") return BY_SLUG.get(a as string);
  if (req.name === "api.getComments") return COMMENTS.get(a as string) || [];
  if (req.name === "api.getFollowing") return FOLLOWING;
  throw new Error("no resource " + req.name);
};

// --- the server-tier pump: runs api.* inline, stops (migrates) at commit -----------------
type RunResult = { done: true; value: unknown } | { request: ResourceRequest; stack: Frame[] };
function runTierless(fn: string, args: unknown[]): RunResult {
  const stack: Frame[] = [{ fn, pc: 0, args }];
  for (;;) {
    const top = stack[stack.length - 1];
    const r = PROGRAMS[top.fn](top);
    if (r.op === "return") { stack.pop(); if (!stack.length) return { done: true, value: r.value }; stack[stack.length - 1].ret = r.value; }
    else if (r.op === "call") { stack.push({ fn: r.fn, pc: 0, args: r.args }); }
    else {
      // these benchmark programs never throw across a resource boundary — every non-return/call
      // result here is a real resource request.
      const req = r as ResourceRequest;
      if (req.tier === "server") stack[stack.length - 1].ret = apiExec(req);
      else return { request: req, stack };
    }
  }
}
// every scenario below ends in a migration (commit), never a full same-tier return.
const migrated = (res: RunResult): { request: ResourceRequest; stack: Frame[] } => res as { request: ResourceRequest; stack: Frame[] };
const deliveredBytes = (res: { request: ResourceRequest; stack: Frame[] }): number =>                                          // codec bytes the browser receives to render (no excision)
  encodeWire([{ fn: "_", pc: 0, args: [] }], { op: "resource", tier: "browser", name: "dom.commit", args: [res.request.args[0]] }, {}).length;
const bodiesHome = (res: { request: ResourceRequest; stack: Frame[] }): number => wireHandles(encodeWire(res.stack, res.request, { tier: makeTier("server"), threshold: 8192 })).length;
function serdeUs(res: { request: ResourceRequest; stack: Frame[] }): number {
  let best = Infinity;
  for (let b = 0; b < 8; b++) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 1000; i++) decodeWire(encodeWire(res.stack, res.request, { tier: makeTier("server"), threshold: 8192 }));
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1000);
  }
  return best / 1000;
}

// --- latency model: parallel waves (independent) or sequential (dependent) ---------------
const RTT_MS = 50, BW_BPS = 12e6, CONC = 6;                             // 50 ms RTT, 12 Mbps, 6 concurrent connections
const wall = (rt: number, bytes: number, dependent: boolean): number => (dependent ? rt : Math.ceil(rt / CONC)) * RTT_MS + (bytes * 8 / BW_BPS) * 1000;

console.log("RealWorld / Conduit — one combined Tierless program vs the stock REST split");
console.log(`(${ARTICLES.length} articles w/ full bodies; RTT ${RTT_MS} ms, ${BW_BPS / 1e6} Mbps, ${CONC} parallel connections; uncompressed)`);

function row(label: string, rt: number, bytes: number, wall_: number): string {
  return `   ${label.padEnd(22)} ${String(rt).padStart(3)} rt   ${fmt(bytes).padStart(11)}   ${wall_.toFixed(0).padStart(6)} ms`;
}

// === A: home feed — over-fetch (REST's 2 requests are independent -> parallel) ===
{
  const rb = jsonBytes({ tags: TAGS }) + jsonBytes({ articles: getArticles({ limit: 10 }), articlesCount: ARTICLES.length });
  const res = migrated(runTierless("homeFeed", [10])); const sb = deliveredBytes(res);
  console.log("\nA) home feed — render 10 previews; stock GET /articles drags all 10 FULL bodies");
  console.log(row("REST (2 parallel)", 2, rb, wall(2, rb, false)));
  console.log(row("Tierless (1 migrate)", 1, sb, wall(1, sb, false)));
  console.log(`   => ${(rb / sb).toFixed(1)}x less data, ${(wall(2, rb, false) / wall(1, sb, false)).toFixed(1)}x faster — a BYTES win; bodies stay home (${bodiesHome(res)} §5 handle), +${serdeUs(res).toFixed(0)} µs serialize`);
}

// === B: favorited-by-followed — independent fan-out (parallelizable) ===
{
  let rb = 0, rt = 0; for (const u of FOLLOWING) { rb += jsonBytes({ articles: getArticles({ favorited: u }), articlesCount: 0 }); rt++; }
  const res = migrated(runTierless("favoritedByFollowed", [ME])); const sb = deliveredBytes(res);
  console.log("\nB) articles favorited by the 10 people I follow — REST fans out 1 request/user (independent -> parallel)");
  console.log(row(`REST (${rt} parallel)`, rt, rb, wall(rt, rb, false)));
  console.log(row("Tierless (1 migrate)", 1, sb, wall(1, sb, false)));
  console.log(`   => ${(rb / sb).toFixed(1)}x less data, ${rt}->1 requests, ${(wall(rt, rb, false) / wall(1, sb, false)).toFixed(1)}x faster — bytes + request-count win`);
}

// === C: dependent drill-down — CANNOT parallelize; the win scales with depth ===
console.log("\nC) a DEPENDENT chain — each step needs the previous article's link, so REST pays one");
console.log("   round trip PER STEP (no parallelism possible). This is Tierless's robust latency win.");
console.log("        depth      REST              Tierless          speedup");
for (const depth of [2, 5, 10, 20]) {
  let rb = 0; let slug = "article-0";
  for (let i = 0; i < depth; i++) { rb += jsonBytes({ article: BY_SLUG.get(slug) }); slug = BY_SLUG.get(slug)!.relatedSlug; }
  const res = migrated(runTierless("drilldown", [depth])); const sb = deliveredBytes(res);
  const rW = wall(depth, rb, true), sW = wall(1, sb, false);
  console.log(`   ${String(depth).padStart(8)}   ${(String(depth) + " rt / " + rW.toFixed(0) + " ms").padEnd(16)}  ${("1 rt / " + sW.toFixed(0) + " ms").padEnd(16)}  ${(rW / sW).toFixed(1)}x faster`);
}

// === D: a single article page — nothing to project; Tierless's codec overhead makes it a wash/loss ===
{
  const slug = "article-7";
  const rb = jsonBytes({ article: BY_SLUG.get(slug) }) + jsonBytes({ comments: COMMENTS.get(slug) });
  const res = migrated(runTierless("articlePage", [slug])); const sb = deliveredBytes(res);
  console.log("\nD) a single article page — the body IS rendered and comments are independent: the stock");
  console.log("   API already serves it in ~1 parallel round trip, with nothing to project away.");
  console.log(row("REST (2 parallel)", 2, rb, wall(2, rb, false)));
  console.log(row("Tierless (1 migrate)", 1, sb, wall(1, sb, false)));
  const faster = wall(2, rb, false) / wall(1, sb, false);
  console.log(`   => ${faster >= 1 ? faster.toFixed(2) + "x faster" : (1 / faster).toFixed(2) + "x SLOWER"}; nothing to save here — Tierless just pays its verbose-codec overhead (+${serdeUs(res).toFixed(0)} µs).`);
}

console.log("\nThe lesson: Tierless wins (1) BYTES, by not over-fetching (A, B), and (2) LATENCY only for");
console.log("round trips you can't parallelize away — DEPENDENT chains (C), where the win grows with depth.");
console.log("For well-composed, fully-used responses (D) it's a wash or slight loss (codec overhead). The");
console.log("overhead it adds is always tens of µs. Use it where the API over-fetches or forces waterfalls.");
