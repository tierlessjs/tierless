// Headless proof of TRANSPARENT deref: the source (heap-auto.src.js) writes ordinary
// `rows[ev.want].title` with no deref() call. Compiled with --auto-deref, the machine
// guards each read of the data-resource local `rows` and auto-fetches it the moment it's
// touched on the tier where it arrived as a §5 handle. (The ws transport for this same
// loop is exercised by heap-live.mjs; here we isolate the compiler's auto-deref.)
import { PROGRAMS } from "./heap-auto.gen.mjs";
import { makeTier, encodeWire, decodeWire, wireHandles, Channel, makeHost } from "tierless/heap";

const body = "markdown body. ".repeat(40);
const ROWS = Array.from({ length: 1500 }, (_, i) => ({ id: i, title: "Article " + i, score: i % 100, body }));
const expectedTotal = ROWS.reduce((s, r) => s + r.score, 0);
const server = makeTier("server"), browser = makeTier("browser");
const channel = new Channel({ server, browser });
const serverHost = makeHost(server, channel), browserHost = makeHost(browser, channel);
const apiExec = (req) => { if (req.name === "api.getRows") return ROWS; throw new Error("no resource " + req.name); };
let committed = null;
const domCommit = (req) => { committed = req.args[0]; return { want: 2 }; };

// A pump that resolves a `deref` resource via the tier's host (local master, or a fetch).
function pumpTier(stack, ownsHere, execHere, host, incoming = null) {
  if (incoming) stack[stack.length - 1].ret = execHere(incoming);
  for (;;) {
    const top = stack[stack.length - 1];
    const r = PROGRAMS[top.fn](top);
    if (r.op === "return") { stack.pop(); if (!stack.length) return { done: true, value: r.value }; stack[stack.length - 1].ret = r.value; }
    else if (r.op === "call") { stack.push({ fn: r.fn, pc: 0, args: r.args }); }
    else if (r.name === "deref") { stack[stack.length - 1].ret = host.deref(r.args[0]); }   // §5 handle -> master or fetch
    else if (ownsHere(r.tier)) { stack[stack.length - 1].ret = execHere(r); }
    else return { done: false, request: r, stack };
  }
}

let pass = true;
const check = (name, cond, extra = "") => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); pass = pass && cond; };
console.log("Probe: TRANSPARENT deref — ordinary source, the compiler auto-fetches handles on touch\n");

// 1) server runs Report to the commit boundary (the rows guards here are no-ops: rows is local)
let res = pumpTier([{ fn: "Report", pc: 0, args: [] }], (t) => t === "server", apiExec, serverHost);
check("server reached commit; the rows guards were no-ops on the owner (no fetch yet)", res.request && res.request.name === "dom.commit" && serverHost.stats.fetches === 0);

// 2) migrate: rows excises into the server heap; only the small summary travels
const wire = encodeWire(res.stack, res.request, { tier: server, threshold: 8192 });
check("the dataset excised to a §5 handle (did not travel)", wireHandles(wire).length === 1 && !wire.includes("markdown body"));

// 3) browser: commit, then `rows[ev.want].title` — the auto-guard derefs (fetches) transparently
const { stack, request } = decodeWire(wire);
res = pumpTier(stack, (t) => t === "browser", domCommit, browserHost, request);
check("the browser committed the small summary", committed && committed.count === 1500 && committed.total === expectedTotal);
check(`ordinary rows[2].title auto-fetched the dataset and returned the detail (got ${JSON.stringify(res.value)})`, res.value === "Article 2");
check("the touch cost exactly one fetch (then materialized in place)", browserHost.stats.fetches === 1);

console.log(`\nNo deref() in the source — the compiler inserted ${wire.length < 1000 ? "the guards" : "guards"}; the dataset crossed only when rows was actually read on the browser.`);
console.log(pass ? "PASS — transparent deref: ordinary member access on a handle auto-fetches over the §5 heap" : "FAIL");
process.exit(pass ? 0 : 1);
