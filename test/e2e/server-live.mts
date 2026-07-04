// LIVE two-tier demo — a REAL human-clickable browser tier.
//
// Same continuation model as demo.mjs, but instead of Playwright scripting clicks into a
// headless page, this serves a real page to a real browser. A human opens the URL, the
// backend client starts the render, the continuation serializes across a real websocket
// into the browser tab, finishes the render there, paints the real DOM, and PARKS on a
// real click. The click resumes it; it migrates back at the next api.* call — serviced by
// the TASKS SERVICE, a reference-monitor sidecar in its own process (the default api.*
// path): this Node process is just the untrusted backend client, holding a pipe client
// and a per-session token.
//
// The whole host is one serveApp() call — static files (repo root, so the page's module
// imports resolve), the dashboard page, the session endpoint, and a per-connection
// session hook that logs in and wires the monitor-backed exec.
//
// Run:  node src/server-live.mjs   (or: npm run live)
//       then open the printed http://localhost:PORT in a browser and click.
import { fileURLToPath } from "node:url";
import { serveApp, type ResourceRequest } from "tierless/server";
import { startSidecar, makeApiExec } from "tierless/api";
import * as bundle from "./app/bundle.gen.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));   // repo root (the web root: /packages/..., /test/e2e/...)
const PORT = Number(process.env.PORT) || 8123;

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tierless — live two-tier React</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 system-ui, sans-serif; margin: 1.5rem; max-width: 720px; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  .lead { color: #666; margin: 0 0 1rem; }
  #status { font: 12px ui-monospace, monospace; color: #444; background: #f3f3f3;
            padding: .4rem .6rem; border-radius: 6px; margin-bottom: 1rem; }
  .stats { margin: .5rem 0; }
  .filters { display: flex; gap: .4rem; margin: .5rem 0; }
  .filters button.active { font-weight: 700; outline: 2px solid #888; }
  ul.tasks { list-style: none; padding: 0; margin: .5rem 0; }
  li.task { display: flex; gap: .6rem; align-items: center; padding: .25rem 0;
            border-bottom: 1px solid #eee; }
  .badge { font-size: 11px; padding: 1px 7px; border-radius: 6px; background: #eee; }
  .task.done .badge { background: #cfe9cf; }
  .task.doing .badge { background: #fde9b8; }
  .prio { font-size: 11px; color: #888; width: 2.5rem; }
  .title { flex: 1; }
  .who { color: #888; font-size: 12px; }
  .addbar { display: flex; gap: .4rem; margin-top: .75rem; }
  .addbar input { flex: 1; padding: .3rem; }
  button { cursor: pointer; }
</style>
</head>
<body>
  <h1>Tierless — live two-tier React</h1>
  <p class="lead">Render starts on the <strong>backend client</strong>, the continuation
  crosses a real websocket into <strong>this browser</strong> to commit the DOM, and your
  click resumes it — then it migrates back for the next data call, which a
  <strong>reference-monitor sidecar</strong> in its own process authorizes per call.
  No client/server split was hand-written; this is one compiled continuation.</p>
  <div id="status">connecting…</div>
  <div id="root"></div>
  <script type="module" src="/test/e2e/public/client.mjs"></script>
</body>
</html>`;

// The trusted side: the tasks service in its own process (it seeds the DB on start).
const apiService = startSidecar(new URL("./api/tasks-fns.mts", import.meta.url));
await apiService.ready();

const app = await serveApp({
  port: PORT,
  page: PAGE,
  staticRoot: ROOT,
  bundle,
  // Per browser connection: one login (the monitor mints the session token in its own
  // process), then every api.* this socket forwards carries it — and the server starts
  // the App session immediately (the full-tierless mode).
  session: async () => {
    console.log("\n— browser connected; starting render on the server tier —");
    const login = await apiService.call("login", [{ user: "demo", pass: "demo" }]);
    if (!login.ok) throw new Error("login failed: " + login.error);
    const exec = makeApiExec(apiService, login.value as string);   // login.value: the session token minted by the sidecar
    return {
      exec: (req: ResourceRequest) => { console.log(`  server  ${req.name}(${JSON.stringify(req.args).slice(1, -1)}) → monitor`); return exec(req); },
      entry: "App",
      onDone: (value: unknown) => console.log(`  => session value: ${JSON.stringify(value)}`),
    };
  },
});

console.log(`Tierless live two-tier demo`);
console.log(`  open  http://localhost:${app.port}  in a browser and click the dashboard.`);
console.log(`  (api.* is serviced by the reference-monitor sidecar in its own process;`);
console.log(`   your clicks drive the continuation across the socket)`);

const shutdown = () => { apiService.close(); app.close(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
