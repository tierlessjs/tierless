// Stackmix — RealWorld/Conduit benchmark: over-fetch vs server-side assembly.
//
//   node bench-conduit.mjs        (modeled latency, instant)
//   node bench-conduit.mjs --real (inject real RTT sleeps -> genuine wall-clock)
//
// A different shape than the HN waterfall. Conduit's home feed is assembled from
// several sources, and the realistic ask is a filter the public API doesn't
// support (e.g. "score >= X"). With REST you either pre-build a bespoke endpoint
// for every filter, or fetch ALL the articles to the client and filter there —
// dragging every article body across the wire to render a small projected feed,
// plus an N+1 round trip per article to join its author.
//
// We run the SAME assembly function under the runtime in two placements:
//   REST  : db.articles ships every body to the client; the filter/join/project
//           run on the client; each author is a round trip. Over-fetch + N+1.
//   Stackmix  : the function migrates once, filters/joins/projects on the server
//           where the data lives, and ships back ONLY the assembled feed.
//
// HN proved the latency/round-trip win (bytes were equal). Conduit proves the
// bandwidth/over-fetch win: the big article bodies never leave the server.

import { PROGRAM, run, Suspend, Tier, fmt } from "#stackmix/runtime/core.mjs";
import { execute, DEFAULT_RTT, DEFAULT_API } from "./core.mjs";

function asm(lines) {
  const labels = {}, code = [];
  for (const l of lines) (typeof l === "string") ? (labels[l] = code.length) : code.push(l.slice());
  for (const ins of code)
    if ((ins[0] === "JMP" || ins[0] === "JMPF") && typeof ins[1] === "string") ins[1] = labels[ins[1]];
  return code;
}

// loadFeed(minScore): assemble the home feed.
//   function loadFeed(minScore) {
//     const articles = db.articles();           // large: every article incl. body
//     const feed = [];
//     for (let i = 0; i < articles.length; i++) {
//       const a = articles[i];
//       if (a.score >= minScore) {               // a filter the API doesn't support
//         const author = db.user(a.authorId);    // N+1 join
//         feed.push({ title: a.title, author: author.name, score: a.score });
//       }
//     }
//     const tags = db.popularTags();
//     return { feed, tags };                     // small projection
//   }
// locals: 0 minScore,1 articles,2 feed,3 i,4 a,5 author,6 item,7 tags,8 result
PROGRAM.loadFeed = {
  nlocals: 9,
  code: asm([
    ["RES", "db.articles", 0], ["STORE", 1],
    ["NEWARR"], ["STORE", 2],
    ["PUSH", 0], ["STORE", 3],
    "loop",
    ["LOAD", 3], ["LOAD", 1], ["GETPROP", "length"], ["BIN", "<"], ["JMPF", "end"],
    ["LOAD", 1], ["LOAD", 3], ["INDEX"], ["STORE", 4],          // a = articles[i]
    ["LOAD", 4], ["GETPROP", "score"], ["LOAD", 0], ["BIN", ">="], ["JMPF", "cont"],
    ["LOAD", 4], ["GETPROP", "authorId"], ["RES", "db.user", 1], ["STORE", 5], // author = db.user(a.authorId)
    ["NEWOBJ"],
    ["LOAD", 4], ["GETPROP", "title"], ["SETPROP", "title"],
    ["LOAD", 5], ["GETPROP", "name"], ["SETPROP", "author"],
    ["LOAD", 4], ["GETPROP", "score"], ["SETPROP", "score"],
    ["STORE", 6],
    ["LOAD", 2], ["LOAD", 6], ["ARRPUSH"],                      // feed.push(item)
    "cont",
    ["LOAD", 3], ["PUSH", 1], ["BIN", "+"], ["STORE", 3], ["JMP", "loop"],
    "end",
    ["RES", "db.popularTags", 0], ["STORE", 7],
    ["NEWOBJ"],
    ["LOAD", 2], ["SETPROP", "feed"],
    ["LOAD", 7], ["SETPROP", "tags"],
    ["STORE", 8],
    ["LOAD", 8], ["RET"],
  ]),
};

// --- synthetic Conduit data -------------------------------------------------
function genData(nArticles, nUsers) {
  const users = new Map();
  for (let id = 0; id < nUsers; id++) users.set(id, { id, name: "user_" + id, bio: "x".repeat(40) });
  const body = "markdown body. ".repeat(130); // ~2 KB per article — the over-fetch payload
  const articles = [];
  for (let id = 0; id < nArticles; id++)
    articles.push({ id, title: "Article " + id, authorId: id % nUsers, score: id % 100, tags: ["t" + (id % 7)], body });
  const popularTags = Array.from({ length: 10 }, (_, k) => "tag_" + k);
  return { users, articles, popularTags };
}

const REAL = process.argv.includes("--real");
const N_ARTICLES = 2000, N_USERS = 50, MIN_SCORE = 90;
const data = genData(N_ARTICLES, N_USERS);

async function runStrategy(policy) {
  const net = { hops: 0, bytes: 0, calls: 0 };
  const server = new Tier("server", {
    "db.articles":    ()     => { net.calls++; return data.articles; },
    "db.user":        ([id]) => { net.calls++; return data.users.get(id); },
    "db.popularTags": ()     => { net.calls++; return data.popularTags; },
  });
  const client = new Tier("client", {});
  const value = await execute("loadFeed", [MIN_SCORE], {
    startTier: client, tiers: [server, client], policy, net, rtt: DEFAULT_RTT, real: REAL,
  });
  return { value, hops: net.hops, bytes: net.bytes, calls: net.calls, latency: net.hops * DEFAULT_RTT + net.calls * DEFAULT_API };
}

const rest = await runStrategy("fetch");
const stackmix = await runStrategy("migrate");

const datasetBytes = Buffer.byteLength(JSON.stringify(data.articles));
const matched = stackmix.value.feed.length;
const ok = JSON.stringify(rest.value) === JSON.stringify(stackmix.value) && matched > 0;

console.log("Stackmix — Conduit feed load: REST over-fetch vs server-side assembly\n");
console.log(`Data: ${N_ARTICLES} articles (~${fmt(datasetBytes / N_ARTICLES)}/body, ${fmt(datasetBytes)} total), ${N_USERS} users`);
console.log(`Query: home feed where score >= ${MIN_SCORE}  ->  ${matched} articles, each joined to its author`);
console.log(`Network model: ${DEFAULT_RTT}ms client<->server RTT, ${DEFAULT_API}ms server<->API${REAL ? "  [REAL sleeps]" : "  [modeled]"}\n`);

const row = (name, s) => `  ${name.padEnd(22)} ${String(s.hops).padStart(4)} rt   ${fmt(s.bytes).padStart(9)}   ${(s.latency + "ms").padStart(8)}`;
console.log("  strategy               round trips    bytes      latency");
console.log(row("REST (over-fetch)", rest));
console.log(row("Stackmix (migrate)", stackmix));
console.log("");

console.log(`Bandwidth: REST drags every article body to the client to filter & join locally;`);
console.log(`Stackmix filters/joins/projects on the server and ships only the assembled feed.`);
console.log(`  bytes crossed : ${fmt(rest.bytes)} -> ${fmt(stackmix.bytes)}   =  ${(rest.bytes / stackmix.bytes).toFixed(0)}x less data`);
console.log(`Round trips: REST ${rest.hops} (db.articles + ${matched} author joins + tags) -> Stackmix ${stackmix.hops}`);
console.log(`             =  ${(rest.latency / stackmix.latency).toFixed(0)}x faster (${rest.latency}ms -> ${stackmix.latency}ms)`);
console.log("");
console.log(`A bespoke server endpoint could also avoid the over-fetch — but that's new`);
console.log(`boilerplate for every filter you didn't anticipate (the §2 argument). Stackmix runs`);
console.log(`the filter inline because it's already on the server where the data is.`);
console.log(`Correctness: REST and Stackmix produced identical feeds? ${ok ? "YES" : "NO"}`);
if (!ok) process.exitCode = 1;
