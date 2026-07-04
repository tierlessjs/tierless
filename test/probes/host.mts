// Probe: the assembled host — serveApp() on the server, connect() on the client, one
// symmetric session protocol between them. This is the surface an app integrates:
//
//   full-tierless mode  the SERVER starts a session per connection (entry:) and the
//                       continuation bounces out to the client at commit();
//   actions mode        the CLIENT starts a session on the server (conn.call(entry)) —
//                       an api-heavy function runs out on the server in one hop, and if
//                       it touches a browser resource mid-flight it bounces back here;
//   concurrency         the host is stateless per message (all state rides in the
//                       continuation), so several sessions interleave on ONE socket.
//
// Everything runs over a REAL websocket with the real binary wire.
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serveApp } from "tierless/server";
import { connect } from "tierless/browser";
import { WS_PATH } from "tierless/server";
import { makeCounter } from "../lib/check.mts";

const TX = fileURLToPath(new URL("../../packages/tierless/src/transform.cjs", import.meta.url));
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const { check, counts } = makeCounter();

// Compile a tiny app: `sum` is a pure server action (api.* only); `flow` bounces to the
// browser mid-action (commit); `appMain` is a server-started session that parks on commit.
const SRC = `
function sum(a, b) { let s = 0; for (const x of [a, b]) { const d = api.dbl(x); s = s + d; } return s; }
function flow(x) { const a = api.dbl(x); const ev = commit({ show: a }); const b = api.dbl(ev.n); return a + b; }
function appMain() { const a = api.dbl(2); const ev = commit({ a }); return "ended:" + ev.n + ":" + a; }
`;
const dir = mkdtempSync(join(tmpdir(), "host-"));
writeFileSync(join(dir, "app.src.js"), SRC);
execFileSync(process.execPath, [TX, join(dir, "app.src.js"), join(dir, "app.gen.mjs"), "--bare"], { cwd: ROOT });
// app.gen.mjs is compiler OUTPUT for a fixture built at test time — no declaration file to
// generate one for, and its shape (a Bundle) is only known once the dynamic import resolves.
const bundle: any = await import(pathToFileURL(join(dir, "app.gen.mjs")).href);

const served: string[] = [];
const apiExec = (req: { name: string; args: unknown[] }): unknown => { served.push(req.name); if (req.name === "api.dbl") return (req.args[0] as number) * 2; throw new Error("no resource " + req.name); };

console.log("Probe: the assembled host — serveApp/connect, both session directions, over a real socket\n");

// ---- actions mode: the client starts sessions on the server -------------------------
{
  const app = await serveApp({ port: 0, bundle, session: async () => ({ exec: apiExec }) });
  const commits: any[] = [];
  const conn = connect({
    url: `ws://localhost:${app.port}${WS_PATH}`,
    bundle,
    exec: (req: any) => { commits.push(req.args[0]); return { n: 10 }; },   // dom.commit -> scripted "click"
  });
  await conn.ready;

  const v = await conn.call("sum", [3, 4]);
  check("an api-heavy action runs out on the server in one round trip", v === 14, v);

  const f = await conn.call("flow", [5]);
  check("an action that touches a browser resource bounces back mid-flight and returns", f === 30, f);
  check("the browser really serviced the mid-action commit", commits.length === 1 && commits[0].show === 10, commits[0]);

  const [a, b, c] = await Promise.all([conn.call("sum", [1, 1]), conn.call("sum", [10, 10]), conn.call("flow", [1])]);
  check("three sessions interleave concurrently on one socket (stateless host)", a === 4 && b === 40 && c === 22, [a, b, c]);

  const bad = await conn.call("nope", []).then(() => null, (e) => String((e && e.message) || e));
  check("a server-side failure rejects the action's promise with the error", bad !== null, bad);

  conn.close(); app.close();
}

// ---- full-tierless mode: the server starts the session per connection ----------------
{
  let doneValue: unknown = null, resolveDone: () => void; const done = new Promise<void>((r) => { resolveDone = r; });
  const app = await serveApp({
    port: 0, bundle,
    session: async () => ({ exec: apiExec, entry: "appMain", onDone: (v: unknown) => { doneValue = v; resolveDone(); } }),
  });
  const conn = connect({ url: `ws://localhost:${app.port}${WS_PATH}`, bundle, exec: () => ({ n: 7 }) });
  await conn.ready;
  await done;
  check("the server-started session bounced to the client's commit and completed", doneValue === "ended:7:4", doneValue);
  conn.close(); app.close();
}

check("every api.* was serviced on the server tier, none leaked to the client", served.every((n) => n === "api.dbl"));

// ---- static file server: a hostile request must 400, never crash the process (§7 boundary) ----
{
  writeFileSync(join(dir, "ok.txt"), "hi");
  const app = await serveApp({ port: 0, bundle, staticRoot: dir, session: async () => ({ exec: apiExec }) });
  const base = `http://localhost:${app.port}`;
  const bad = await fetch(`${base}/%`);                          // malformed percent-encoding — used to take the whole process down
  const good = await fetch(`${base}/ok.txt`);
  check("a malformed static request is refused with 400, not a process crash", bad.status === 400);
  check("a well-formed static request still serves its file", good.status === 200 && (await good.text()) === "hi");
  app.close();
}

const { pass, fail } = counts();
const ok = fail === 0;
console.log(ok
  ? `\nOK — serveApp/connect assemble the full host: client-started actions (with mid-flight bounces and concurrency) and server-started sessions both run over one socket, and a malformed static request is refused without crashing the host (${pass} checks)`
  : `\nFAILED (${pass} passed, ${fail} failed)`);
process.exit(ok ? 0 : 1);
