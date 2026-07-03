// Headless proof of TRANSPARENT deref: the source (heap-auto.src.js) writes ordinary
// `rows[ev.want].title` with no deref() call. Compiled with --auto-deref, the machine
// guards each read of the data-resource local `rows` and auto-fetches it the moment it's
// touched on the tier where it arrived as a §5 handle. (The ws transport for this same
// loop is exercised by heap-live.mjs; here we isolate the compiler's auto-deref.)
import { PROGRAMS } from "./heap-auto.gen.mjs";
import { makeTier, encodeWire, decodeWire, wireHandles, Channel, makeHost } from "tierless/heap";
import { makeCheck } from "../lib/check.mts";
import type { Frame, MachineResult } from "tierless/runtime";
import type { DeltaFrame, DeltaRequest } from "tierless/delta";
import type { FetchHost } from "tierless/fetch";

type ResourceReq = Extract<MachineResult, { op: "resource" }>;
type PumpResult = { done: true; value: unknown } | { done: false; request: ResourceReq; stack: DeltaFrame[] };

interface Row { id: number; title: string; score: number; body: string }
interface Commit { total: number; count: number }

const body = "markdown body. ".repeat(40);
const ROWS: Row[] = Array.from({ length: 1500 }, (_, i) => ({ id: i, title: "Article " + i, score: i % 100, body }));
const expectedTotal = ROWS.reduce((s, r) => s + r.score, 0);
const server = makeTier("server"), browser = makeTier("browser");
const channel = new Channel({ server, browser });
const serverHost = makeHost(server, channel), browserHost = makeHost(browser, channel);
const apiExec = (req: ResourceReq): unknown => { if (req.name === "api.getRows") return ROWS; throw new Error("no resource " + req.name); };
let committed = null as Commit | null;   // cast (not just annotated): keeps TS from pinning the CFA-narrowed type to the literal `null` initializer, since the real assignment happens inside a closure it can't trace
const domCommit = (req: ResourceReq): { want: number } => { committed = req.args[0] as Commit; return { want: 2 }; };

// A pump that resolves a `deref` resource via the tier's host (local master, or a fetch).
function pumpTier(
  stack: DeltaFrame[],
  ownsHere: (tier: string) => boolean,
  execHere: (req: ResourceReq) => unknown,
  host: FetchHost,
  incoming: DeltaRequest | null = null,
): PumpResult {
  if (incoming) stack[stack.length - 1].ret = execHere(incoming as ResourceReq);
  for (;;) {
    const top = stack[stack.length - 1] as Frame;   // DeltaFrame/Frame share the same runtime shape; PROGRAMS is typed over Frame
    const r = PROGRAMS[top.fn](top);
    if (r.op === "return") { stack.pop(); if (!stack.length) return { done: true, value: r.value }; stack[stack.length - 1].ret = r.value; }
    else if (r.op === "call") { stack.push({ fn: r.fn, pc: 0, args: r.args }); }
    else if (r.op === "resource" && r.name === "deref") { stack[stack.length - 1].ret = host.deref(r.args[0]); }   // §5 handle -> master or fetch
    else if (r.op === "resource" && ownsHere(r.tier)) { stack[stack.length - 1].ret = execHere(r); }
    else return { done: false, request: r as ResourceReq, stack };
  }
}

const { check, ok } = makeCheck();
console.log("Probe: TRANSPARENT deref — ordinary source, the compiler auto-fetches handles on touch\n");

// 1) server runs Report to the commit boundary (the rows guards here are no-ops: rows is local)
const res1 = pumpTier([{ fn: "Report", pc: 0, args: [] }], (t) => t === "server", apiExec, serverHost) as Extract<PumpResult, { done: false }>;
check("server reached commit; the rows guards were no-ops on the owner (no fetch yet)", res1.request && res1.request.name === "dom.commit" && serverHost.stats.fetches === 0);

// 2) migrate: rows excises into the server heap; only the small summary travels
const wire = encodeWire(res1.stack, res1.request, { tier: server, threshold: 8192 });
check("the dataset excised to a §5 handle (did not travel)", wireHandles(wire).length === 1 && !wire.includes("markdown body"));

// 3) browser: commit, then `rows[ev.want].title` — the auto-guard derefs (fetches) transparently
const { stack, request } = decodeWire(wire);
const res2 = pumpTier(stack, (t) => t === "browser", domCommit, browserHost, request) as Extract<PumpResult, { done: true }>;
check("the browser committed the small summary", committed !== null && committed.count === 1500 && committed.total === expectedTotal);
check(`ordinary rows[2].title auto-fetched the dataset and returned the detail (got ${JSON.stringify(res2.value)})`, res2.value === "Article 2");
check("the touch cost exactly one fetch (then materialized in place)", browserHost.stats.fetches === 1);

console.log(`\nNo deref() in the source — the compiler inserted ${wire.length < 1000 ? "the guards" : "guards"}; the dataset crossed only when rows was actually read on the browser.`);
console.log(ok() ? "PASS — transparent deref: ordinary member access on a handle auto-fetches over the §5 heap" : "FAIL");
process.exit(ok() ? 0 : 1);
