// The DEFAULT api.* path — proven on the real app and the real runtime. verify.mjs drives
// the Tasks app with an in-process resource host (the labeled degenerate mode); THIS proof
// drives the SAME compiled continuation through runtime.mjs's own pump with every api.*
// serviced by the tasks service — the reference monitor forked into its own process — over
// the pipe, exactly as the live demos now run. The continuation binary-wire round-trips at
// every browser hop, so it is a genuine migration.
//
// And the boundary is shown to be LOAD-BEARING, not ceremonial:
//   - the authenticated session (one login per session; the pump host holds only the token)
//     runs the full scripted journey correctly through the monitor,
//   - an ANONYMOUS session still reads (the dashboard endpoints are deliberately PUBLIC)
//     but its first write is denied IN THE MONITOR'S PROCESS and the denial is thrown
//     across the tier into the continuation,
//   - a FORGED token (tampered claims break the signature) buys exactly nothing,
//   - an oversize payload is rejected by the monitor's resource budget before running.
import { makePump, initialStack } from "tierless/runtime";
import { startSidecar, makeApiExec } from "tierless/api";
import { encodeWireBinary, decodeWireBinary } from "tierless/wire";
import { textOf } from "./app/render.mjs";
import * as bundle from "./app/bundle.gen.mjs";

const pump = makePump(bundle);

let pass = 0, fail = 0;
const check = (label, cond, got) => { if (cond) { pass++; console.log(`  PASS  ${label}`); } else { fail++; console.log(`  FAIL  ${label}${got === undefined ? "" : `  (got ${JSON.stringify(got)})`}`); } };

const ownsServer = (tier) => tier === "server";

// Drive the App continuation on the runtime pump: api.* to the monitor via exec, dom.commit
// answered from a scripted event list, the whole stack crossing the binary wire at each hop.
async function runSession(exec, events) {
  const commits = [];
  let ei = 0;
  let res = await pump(initialStack("App"), ownsServer, exec);
  while (!res.done) {
    if (res.request.name !== "dom.commit") throw new Error("unexpected request " + res.request.name);
    const { stack } = decodeWireBinary(encodeWireBinary(res.stack, res.request));   // MIGRATE: browser hop, both directions
    commits.push(textOf(res.request.args[0]));
    stack[stack.length - 1].ret = events[ei++] || { ev: "stop" };
    res = await pump(stack, ownsServer, exec);
  }
  return { value: res.value, commits };
}

console.log("Proof: the default api.* path is the reference monitor (the runtime pump + the tasks service over the pipe)\n");

const apiService = startSidecar(new URL("./api/tasks-fns.mjs", import.meta.url));
await apiService.ready();
try {
  // ---- authenticated session: the exact verify.mjs journey, now through the monitor ----
  const login = await apiService.call("login", [{ user: "demo", pass: "demo" }]);
  check("the session logs in over the pipe (the monitor mints the token in its own process)", login.ok === true);
  const token = login.value;

  const authed = await runSession(makeApiExec(apiService, token), [
    { ev: "filter", value: "done" }, { ev: "filter", value: "all" },
    { ev: "cycle", id: 2, next: "doing" }, { ev: "add", title: "Ship the demo" },
    { ev: "delete", id: 1 }, { ev: "stop" },
  ]);
  check("the full session runs on the runtime pump with every api.* monitor-serviced", authed.value === "session ended" && authed.commits.length === 6);
  check("reads through the monitor render the seeded dashboard", authed.commits[0].includes("todo 2 / doing 2 / done 1"), authed.commits[0]);
  check("an authorized write (cycle) took effect through the monitor", authed.commits[3].includes("todo 1 / doing 3 / done 1"), authed.commits[3]);
  check("an authorized add + delete round out the journey", authed.commits[4].includes("6 tasks") && authed.commits[4].includes("Ship the demo") && authed.commits[5].includes("5 tasks"));

  // ---- anonymous session: PUBLIC reads stand; the FIRST write is denied at the monitor ----
  const anonExec = makeApiExec(apiService, null);
  let anonCommits = null, anonErr = null;
  try { await runSession(anonExec, [{ ev: "cycle", id: 2, next: "doing" }]); }
  catch (e) { anonErr = e; }
  // rerun read-only to capture what an anonymous session CAN see (the session above aborted)
  anonCommits = (await runSession(anonExec, [{ ev: "stop" }])).commits;
  check("anonymous PUBLIC reads still render the dashboard (authorization, not a dead pipe)", anonCommits.length === 1 && anonCommits[0].includes("5 tasks"), anonCommits[0]);
  check("the anonymous write is denied in the monitor's process and thrown across the tier", anonErr !== null && anonErr.message === "denied", anonErr && anonErr.message);

  // ---- forged token: tampered claims break the signature; buys exactly anonymous ----
  const [body, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ sub: "demo", role: "admin" }), "utf8").toString("base64url") + "." + sig;
  let forgedErr = null;
  try { await runSession(makeApiExec(apiService, forged), [{ ev: "delete", id: 2 }]); }
  catch (e) { forgedErr = e; }
  check("a forged token (client-edited claims, stale signature) is denied identically", forgedErr !== null && forgedErr.message === "denied", forgedErr && forgedErr.message);
  check("the forgery really did break verification (control: the untampered token still works)", body.length > 0 && (await apiService.call("getStats", [], token)).ok === true);

  // ---- resource budget: an oversize payload is rejected before anything runs ----
  const oversize = await apiService.call("addTask", [{ title: "x".repeat(20000) }], token);
  check("an oversize call is rejected by the monitor's args budget (even authenticated)", oversize.ok === false);
  const stats = await apiService.call("getStats", [], token);
  check("the oversize task was never created", stats.ok === true && stats.value.total === 5, stats.value && stats.value.total);
} finally {
  apiService.close();
}

const ok = fail === 0;
console.log(ok
  ? `\nPASS — the default api.* path IS the reference monitor: the runtime pump serviced every api call over the pipe, PUBLIC reads stood anonymously, and an unauthenticated or forged write was denied in the monitor's process and thrown across the tier (${pass} checks)`
  : `\nFAIL (${pass} passed, ${fail} failed)`);
process.exit(ok ? 0 : 1);
