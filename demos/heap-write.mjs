// Headless proof of TRANSPARENT write-back: heap-write.src.js writes ordinary
// `rows[ev.idx].score = ev.score` — no deref(), no writeBack(). Compiled --auto-deref
// --auto-writeback, the machine fetches `rows` on touch (it arrived on the browser as a §5
// handle) and, after the mutation, propagates the edited snapshot back to the SERVER master
// under optimistic CAS. The symmetric partner of heap-auto.mjs (which proved reads); here we
// prove a browser-side WRITE lands on the owner, coherently. (The same coherence layer rides
// the live ws socket in heap-live.mjs; here we isolate the compiler's auto-writeback.)
import { PROGRAMS } from "./heap-write.gen.mjs";
import { makeTier, encodeWire, decodeWire, wireHandles, Channel, makeCoherentHost } from "stackmix/heap";

const body = "markdown body. ".repeat(40);
const ROWS = Array.from({ length: 1500 }, (_, i) => ({ id: i, title: "Article " + i, score: i % 100, body }));
const server = makeTier("server"), browser = makeTier("browser");
const channel = new Channel({ server, browser });
const serverHost = makeCoherentHost(server, channel), browserHost = makeCoherentHost(browser, channel);
const apiExec = (req) => { if (req.name === "api.getRows") return ROWS; throw new Error("no resource " + req.name); };
const EDIT = { idx: 2, score: 777 };                               // the "user" edits row 2's score (was 2)
let committed = null;
const domCommit = (req) => { committed = req.args[0]; return EDIT; };

// A pump that resolves both §5 ops via the tier's coherent host: deref (read) and writeback (write).
function pumpTier(stack, ownsHere, execHere, host, incoming = null) {
  if (incoming) stack[stack.length - 1].ret = execHere(incoming);
  for (;;) {
    const top = stack[stack.length - 1];
    const r = PROGRAMS[top.fn](top);
    if (r.op === "return") { stack.pop(); if (!stack.length) return { done: true, value: r.value }; stack[stack.length - 1].ret = r.value; }
    else if (r.op === "call") { stack.push({ fn: r.fn, pc: 0, args: r.args }); }
    else if (r.name === "deref") { stack[stack.length - 1].ret = host.deref(r.args[0]); }         // §5 read: master or fetch
    else if (r.name === "writeback") { stack[stack.length - 1].ret = host.writeBack(r.args[0]); } // §5 write: optimistic CAS to the owner
    else if (ownsHere(r.tier)) { stack[stack.length - 1].ret = execHere(r); }
    else return { done: false, request: r, stack };
  }
}

let pass = true;
const check = (name, cond, extra = "") => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); pass = pass && cond; };
console.log("Probe: TRANSPARENT write-back — ordinary `rows[i].x = v`, the compiler fetches then propagates the edit\n");

// 1) server runs Edit to the commit boundary (rows is the local master: guards & write-back are no-ops here)
let res = pumpTier([{ fn: "Edit", pc: 0, args: [] }], (t) => t === "server", apiExec, serverHost);
check("server reached commit with no fetch and no write-back (rows is the local master)",
  res.request && res.request.name === "dom.commit" && serverHost.stats.fetches === 0 && serverHost.stats.writeBacks === 0);

// 2) migrate: rows excises into the server heap as a §5 handle; only the small summary travels
const wire = encodeWire(res.stack, res.request, { tier: server, threshold: 8192 });
const [handle] = wireHandles(wire);
check("the dataset excised to a §5 handle (did not travel)", wireHandles(wire).length === 1 && !wire.includes("markdown body"));
const baseVersion = server.heap.version(handle.id);

// 3) browser: commit returns the edit; `rows[ev.idx].score = ev.score` auto-derefs then auto-writes-back
const { stack, request } = decodeWire(wire);
res = pumpTier(stack, (t) => t === "browser", domCommit, browserHost, request);
check("the browser committed the summary", committed && committed.count === 1500);
check(`the local read-back reflects the edit (got ${JSON.stringify(res.value)})`, res.value === 777);
check("the edit cost exactly one fetch and one write-back, no conflict",
  browserHost.stats.fetches === 1 && browserHost.stats.writeBacks === 1 && browserHost.stats.conflicts === 0);

// 4) THE POINT: the server master now reflects the browser's edit, coherently
const master = server.heap.get(handle.id);
check(`the edit propagated to the SERVER master (rows[${EDIT.idx}].score = ${master[EDIT.idx].score})`, master[EDIT.idx].score === 777);
check("the master's version bumped, so other tiers' caches invalidate", server.heap.version(handle.id) === baseVersion + 1);
check("the rest of the dataset survived the write-back intact (unrelated rows + bodies)",
  master.length === 1500 && master[1].score === 1 && master[3].score === 3 && master[3].body === body);

console.log(`\nNo deref()/writeBack() in the source — the compiler inserted them; a browser edit fetched the dataset, mutated it, and the ${(wire.length < 1000 ? "tiny" : "")} write-back made the server master coherent.`);
console.log(pass
  ? "PASS — transparent write-back: an ordinary member assignment propagated to the owning master under §5 CAS"
  : "FAIL");
process.exit(pass ? 0 : 1);
