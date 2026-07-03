// Headless proof of TRANSPARENT write-back: heap-write.src.js writes ordinary
// `rows[ev.idx].score = ev.score` — no deref(), no writeBack(). Compiled --auto-deref
// --auto-writeback, the machine fetches `rows` on touch (it arrived on the browser as a §5
// handle) and, after the mutation, propagates the edited snapshot back to the SERVER master
// under optimistic CAS. The symmetric partner of heap-auto.mjs (which proved reads); here we
// prove a browser-side WRITE lands on the owner, coherently. (The same coherence layer rides
// the live ws socket in heap-live.mjs; here we isolate the compiler's auto-writeback.)
import { PROGRAMS } from "./heap-write.gen.mjs";
import { makeTier, encodeWire, decodeWire, wireHandles, Channel, makeCoherentHost } from "tierless/heap";
import { makeCheck } from "../lib/check.mts";
import type { Frame, MachineResult } from "tierless/runtime";
import type { DeltaFrame, DeltaRequest } from "tierless/delta";
import type { CoherentHost } from "tierless/heap";

type ResourceReq = Extract<MachineResult, { op: "resource" }>;
type PumpResult = { done: true; value: unknown } | { done: false; request: ResourceReq; stack: DeltaFrame[] };

interface Row { id: number; title: string; score: number; body: string }
interface Commit { count: number }

const body = "markdown body. ".repeat(40);
const ROWS: Row[] = Array.from({ length: 1500 }, (_, i) => ({ id: i, title: "Article " + i, score: i % 100, body }));
const server = makeTier("server"), browser = makeTier("browser");
const channel = new Channel({ server, browser });
const serverHost = makeCoherentHost(server, channel), browserHost = makeCoherentHost(browser, channel);
const apiExec = (req: ResourceReq): unknown => { if (req.name === "api.getRows") return ROWS; throw new Error("no resource " + req.name); };
const EDIT = { idx: 2, score: 777 };                               // the "user" edits row 2's score (was 2)
let committed = null as Commit | null;   // cast (not just annotated): keeps TS from pinning the CFA-narrowed type to the literal `null` initializer, since the real assignment happens inside a closure it can't trace
const domCommit = (req: ResourceReq): typeof EDIT => { committed = req.args[0] as Commit; return EDIT; };

// A pump that resolves both §5 ops via the tier's coherent host: deref (read) and writeback (write).
function pumpTier(
  stack: DeltaFrame[],
  ownsHere: (tier: string) => boolean,
  execHere: (req: ResourceReq) => unknown,
  host: CoherentHost,
  incoming: DeltaRequest | null = null,
): PumpResult {
  if (incoming) stack[stack.length - 1].ret = execHere(incoming as ResourceReq);
  for (;;) {
    const top = stack[stack.length - 1] as Frame;   // DeltaFrame/Frame share the same runtime shape; PROGRAMS is typed over Frame
    const r = PROGRAMS[top.fn](top);
    if (r.op === "return") { stack.pop(); if (!stack.length) return { done: true, value: r.value }; stack[stack.length - 1].ret = r.value; }
    else if (r.op === "call") { stack.push({ fn: r.fn, pc: 0, args: r.args }); }
    else if (r.op === "resource" && r.name === "deref") { stack[stack.length - 1].ret = host.deref(r.args[0]); }         // §5 read: master or fetch
    else if (r.op === "resource" && r.name === "writeback") { stack[stack.length - 1].ret = host.writeBack(r.args[0]); } // §5 write: optimistic CAS to the owner
    else if (r.op === "resource" && ownsHere(r.tier)) { stack[stack.length - 1].ret = execHere(r); }
    else return { done: false, request: r as ResourceReq, stack };
  }
}

const { check, ok } = makeCheck();
console.log("Probe: TRANSPARENT write-back — ordinary `rows[i].x = v`, the compiler fetches then propagates the edit\n");

// 1) server runs Edit to the commit boundary (rows is the local master: guards & write-back are no-ops here)
const res1 = pumpTier([{ fn: "Edit", pc: 0, args: [] }], (t) => t === "server", apiExec, serverHost) as Extract<PumpResult, { done: false }>;
check("server reached commit with no fetch and no write-back (rows is the local master)",
  res1.request && res1.request.name === "dom.commit" && serverHost.stats.fetches === 0 && serverHost.stats.writeBacks === 0);

// 2) migrate: rows excises into the server heap as a §5 handle; only the small summary travels
const wire = encodeWire(res1.stack, res1.request, { tier: server, threshold: 8192 });
const [handle] = wireHandles(wire);
check("the dataset excised to a §5 handle (did not travel)", wireHandles(wire).length === 1 && !wire.includes("markdown body"));
const baseVersion = server.heap.version(handle.id);

// 3) browser: commit returns the edit; `rows[ev.idx].score = ev.score` auto-derefs then auto-writes-back
const { stack, request } = decodeWire(wire);
const res2 = pumpTier(stack, (t) => t === "browser", domCommit, browserHost, request) as Extract<PumpResult, { done: true }>;
check("the browser committed the summary", committed !== null && committed.count === 1500);
check(`the local read-back reflects the edit (got ${JSON.stringify(res2.value)})`, res2.value === 777);
check("the edit cost exactly one fetch and one write-back, no conflict",
  browserHost.stats.fetches === 1 && browserHost.stats.writeBacks === 1 && browserHost.stats.conflicts === 0);

// 4) THE POINT: the server master now reflects the browser's edit, coherently
const master = server.heap.get(handle.id) as Row[];   // heap.get returns unknown; this probe knows the fixture's shape
check(`the edit propagated to the SERVER master (rows[${EDIT.idx}].score = ${master[EDIT.idx].score})`, master[EDIT.idx].score === 777);
check("the master's version bumped, so other tiers' caches invalidate", server.heap.version(handle.id) === baseVersion + 1);
check("the rest of the dataset survived the write-back intact (unrelated rows + bodies)",
  master.length === 1500 && master[1].score === 1 && master[3].score === 3 && master[3].body === body);

console.log(`\nNo deref()/writeBack() in the source — the compiler inserted them; a browser edit fetched the dataset, mutated it, and the ${(wire.length < 1000 ? "tiny" : "")} write-back made the server master coherent.`);
console.log(ok()
  ? "PASS — transparent write-back: an ordinary member assignment propagated to the owning master under §5 CAS"
  : "FAIL");
process.exit(ok() ? 0 : 1);
