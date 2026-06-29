// LIVE two-tier demo — a REAL human-clickable browser tier.
//
// Same continuation model as demo.mjs, but instead of Playwright scripting clicks
// into a headless page, this serves a real page to a real browser. A human opens
// the URL, the server starts the render (it owns api.*), the continuation
// serializes across a real websocket into the browser tab, finishes the render
// there, paints the real DOM, and PARKS on a real click. The human clicks; the
// continuation resumes and migrates back to the server at the next api.* call.
//
// This Node process:
//   - serves static files with the REPO ROOT as the web root, so absolute imports
//     like /src/runtime.mjs and /src/app/bundle.gen.mjs (reached transitively from
//     /src/public/client.mjs) resolve over HTTP,
//   - serves the dashboard HTML shell at /,
//   - runs a ws WebSocketServer on the SAME http server ({ server }); the client
//     dials ws://<same-host>, so there is one port for everything,
//   - drives the continuation exactly like demo.mjs's server tier.
//
// Run:  node src/server-live.mjs   (or: npm run live)
//       then open the printed http://localhost:PORT in a browser and click.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { wsPort, makePeer } from "./transport.mjs";
import { pump, initialStack } from "./runtime.mjs";
import { encodeWireBinary, decodeWireBinary } from "./wire-binary.mjs";
import * as api from "./app/api.mjs";

const { WebSocketServer } = createRequire(import.meta.url)("ws");

// Repo root = one level up from src/. Everything under it is servable; the client's
// module graph (client.mjs -> transport.mjs + runtime.mjs -> bundle.gen.mjs + graph.mjs)
// all lives within it.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PORT = Number(process.env.PORT) || 8123;

// -------------------------------------------------------------- static server ----
const MIME = {
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stackmix — live two-tier React</title>
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
  <h1>Stackmix — live two-tier React</h1>
  <p class="lead">Render starts on the <strong>server</strong> (it owns <code>api.*</code>),
  the continuation crosses a real websocket into <strong>this browser</strong> to commit the
  DOM, and your click resumes it — then it migrates back to the server for the next data call.
  No client/server split was hand-written; this is one compiled continuation.</p>
  <div id="status">connecting…</div>
  <div id="root"></div>
  <script type="module" src="/src/public/client.mjs"></script>
</body>
</html>`;

function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": MIME[".html"] });
    res.end(PAGE);
    return;
  }
  // Resolve under ROOT and refuse traversal outside it.
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const abs = path.join(ROOT, rel);
  if (!abs.startsWith(ROOT)) { res.writeHead(403); res.end("forbidden"); return; }
  fs.readFile(abs, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("not found: " + rel); return; }
    const type = MIME[path.extname(abs)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  });
}

const server = http.createServer(serveStatic);

// ------------------------------------------------------------------ ws tier ------
const API = {
  "api.getTasks": (a) => api.getTasks(a), "api.getStats": () => api.getStats(),
  "api.addTask": (a) => api.addTask(a), "api.setStatus": (id, s) => api.setStatus(id, s),
  "api.deleteTask": (id) => api.deleteTask(id),
};
const ownsServer = (tier) => tier === "server";
const apiExec = (req) => { console.log(`  server  ${req.name}(${JSON.stringify(req.args).slice(1, -1)})`); return API[req.name](...req.args); };

api.seed();   // reset the file-backed DB to the canonical 5 tasks for each server start

const wss = new WebSocketServer({ server });
wss.on("connection", async (ws) => {
  console.log("\n— browser connected; starting render on the server tier —");
  const peer = makePeer(wsPort(ws));
  try {
    let res = await pump(initialStack("App"), ownsServer, apiExec);   // render starts here, runs to first dom.*
    while (!res.done) {
      console.log(`  ── migrate → browser (${res.request.name})`);
      const { obj: reply, bin } = await peer.request({ type: "resume" }, encodeWireBinary(res.stack, res.request));
      if (reply.type === "error") throw new Error("browser: " + reply.message);
      if (reply.type === "done") { res = { done: true, value: reply.value }; break; }
      const { stack, request } = decodeWireBinary(bin);               // browser migrated it back at a server resource
      console.log(`  ── migrate ← browser (${request.name})`);
      res = await pump(stack, ownsServer, apiExec, request);
    }
    console.log(`  => session value: ${JSON.stringify(res.value)}`);
  } catch (e) {
    if (String(e && e.message).includes("WebSocket is not open") || (ws.readyState !== 1)) {
      console.log("  (browser tab closed mid-session)");
    } else {
      console.error("  server tier error:", (e && e.stack) || e);
    }
  }
});

server.listen(PORT, () => {
  console.log(`Stackmix live two-tier demo`);
  console.log(`  open  http://localhost:${PORT}  in a browser and click the dashboard.`);
  console.log(`  (the server owns api.*; your clicks drive the continuation across the socket)`);
});
