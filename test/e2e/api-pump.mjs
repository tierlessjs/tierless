// The trust boundary, wired into the pump. The reference monitor (api-verify.mjs) proved itself as a
// standalone component; here a REAL compiled continuation runs across two tiers and every api.* call is
// serviced by the monitor over the pipe — the integration that makes it the actual boundary, not a side
// demo. The continuation (Flow, compiled from api-pump-app.src.js) authenticates, tries an admin-only
// call, and bounces to the browser; it is serialized through the graph codec at each hop, so this is a
// genuine migration. The backend client hands the monitor the SESSION's bearer token on every call; the
// monitor decides per principal, and a denial returns as a throw the app's try/catch catches across the
// tier. Same continuation, three principals — authority is enforced at the boundary, never inferred from
// how control flow arrived.
import { PROGRAMS, __unwind } from "./api-pump-app.gen.mjs";
import { startSidecar, makeApiExec } from "tierless/api";
import { encodeGraph, decodeGraph } from "tierless/graph";

const wire = (stack) => decodeGraph(JSON.parse(JSON.stringify(encodeGraph([stack]))))[0];   // serialize the continuation at each hop (proves migration)

// The pump (mirrors runtime.mjs, bound to this app's PROGRAMS). Runs the continuation on the local tier,
// stopping at the first foreign resource. A resource failure routes through __unwind, so a monitor
// denial thrown by execHere lands in the app's try/catch even one frame up.
async function pumpLocal(stack, ownsHere, execHere, incoming) {
  const service = async (req) => { try { stack[stack.length - 1].ret = await execHere(req); } catch (e) { if (!__unwind(stack, e)) throw e; } };
  if (incoming) await service(incoming);
  for (;;) {
    const top = stack[stack.length - 1];
    const r = PROGRAMS[top.fn](top);
    if (r.op === "return") { stack.pop(); if (!stack.length) return { done: true, value: r.value }; stack[stack.length - 1].ret = r.value; }
    else if (r.op === "call") { stack.push({ fn: r.fn, pc: 0, args: r.args }); }
    else if (r.op === "throw") { stack.pop(); if (!__unwind(stack, r.value)) throw r.value; }
    else if (ownsHere(r.tier)) { await service(r); }
    else return { done: false, request: r, stack };
  }
}

const ownsServer = (tier) => tier === "server";
const ownsBrowser = (tier) => tier === "browser";

// The backend client services api.* with makeApiExec — the same default adapter the live
// demos use: monitor over the pipe with the session token, a denial becoming a catchable
// throw in the continuation. The browser services commit.
function browserExec(sink) {
  return (req) => { if (req.name === "dom.commit") { sink.committed = req.args[0]; return "shown"; } throw new Error("browser can't service " + req.name); };
}

// Drive one continuation across the two tiers under a given session token, serializing at every hop.
async function runFlow(api, token) {
  const sink = {};
  const sExec = makeApiExec(api, token), bExec = browserExec(sink);
  let res = await pumpLocal([{ fn: "Flow", pc: 0, args: [] }], ownsServer, sExec, null);
  let onServer = true;
  while (!res.done) {
    onServer = !onServer;                               // migrate to the other tier
    res = await pumpLocal(wire(res.stack), onServer ? ownsServer : ownsBrowser, onServer ? sExec : bExec, res.request);
  }
  return { value: res.value, committed: sink.committed };
}

let pass = 0, fail = 0;
const check = (label, cond) => { if (cond) { pass++; console.log(`  PASS  ${label}`); } else { fail++; console.log(`  FAIL  ${label}`); } };

console.log("Proof: the live pump services api.* through the trusted monitor (sidecar)\n");

const api = startSidecar(new URL("./api/server-fns.mjs", import.meta.url));
await api.ready();
try {
  const aliceTok = (await api.call("login", [{ user: "alice", pass: "wonderland" }])).value;
  const bobTok = (await api.call("login", [{ user: "bob", pass: "builder" }])).value;

  // Admin session: whoami resolves the verified principal, the admin-only call is allowed, and the
  // continuation bounces to the browser carrying the result.
  const alice = await runFlow(api, aliceTok);
  check("admin session: whoami resolves the verified principal over the pump", alice.committed.who === "alice");
  check("admin session: the admin-only api.deleteUser is allowed by the monitor", alice.committed.outcome === "deleted:carol");
  check("admin session: the continuation completed on the browser tier after the bounce", alice.value === "shown");

  // User session: SAME compiled continuation, different principal. The admin-only call is denied at the
  // monitor — in a separate process — and the denial is caught by the app's try/catch across the tier.
  const bob = await runFlow(api, bobTok);
  check("user session: whoami resolves the verified principal", bob.committed.who === "bob");
  check("user session: the admin-only call is denied at the monitor and caught across the tier", bob.committed.outcome === "denied");

  // Anonymous session: no token, so the very first api call (whoami) is denied; with no try around it,
  // the denial escapes the continuation — an unauthenticated session can't even start.
  let anonThrew = false;
  try { await runFlow(api, null); } catch { anonThrew = true; }
  check("anonymous session: the first api call is denied, so the session cannot proceed", anonThrew);

  // The forged-continuation point, made concrete: authority did not depend on HOW the call was reached.
  // Bob's continuation reached api.deleteUser exactly as Alice's did (same pcs, same machine); only the
  // verified principal differed, and only the monitor's per-call decision gated it.
  check("authority is enforced at the boundary, not inferred from control flow (same continuation, opposite outcomes)",
    alice.committed.outcome === "deleted:carol" && bob.committed.outcome === "denied");
} finally {
  api.close();
}

const ok = fail === 0;
console.log(ok
  ? `\nPASS — the live pump services api.* through the trusted monitor: a migrating continuation is authorized per principal in a separate process on every call, and a denial is caught across the tier (${pass} checks)`
  : `\nFAIL (${pass} passed, ${fail} failed)`);
process.exit(ok ? 0 : 1);
