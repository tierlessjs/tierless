// The two-tier host: static files + the session endpoint, with the api service forked as
// a reference-monitor sidecar. Each browser connection logs in (demo session), gets its
// token, and the server starts the App session — the continuation then bounces between
// here and the tab at every commit()/api.* boundary.
import { fileURLToPath } from "node:url";
import { serveApp } from "stackmix/server";
import { startSidecar, makeApiExec } from "stackmix/api";
import * as bundle from "./app.gen.mjs";

const PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stackmix app</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 560px; margin: 2rem auto; }
  #status { color: #888; font-size: 13px; min-height: 1.2em; }
  ul { padding-left: 1.2rem; } .addbar { display: flex; gap: .5rem; } input { flex: 1; padding: .3rem; }
</style></head>
<body>
  <h1>Notes — a Stackmix app</h1>
  <p id="status">connecting…</p>
  <div id="root"></div>
  <script type="module" src="/client.mjs"></script>
</body>
</html>`;

const apiService = startSidecar(new URL("./api.server.mjs", import.meta.url));
await apiService.ready();

const app = await serveApp({
  port: process.env.PORT != null ? Number(process.env.PORT) : 8123,
  page: PAGE,
  staticRoot: fileURLToPath(new URL("./", import.meta.url)),
  bundle,
  session: async () => {
    const login = await apiService.call("login", [{ user: "demo", pass: "demo" }]);
    if (!login.ok) throw new Error("login failed: " + login.error);
    return { exec: makeApiExec(apiService, login.value), entry: "App" };
  },
});

console.log(`stackmix app listening on http://localhost:${app.port}`);
const shutdown = () => { apiService.close(); app.close(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
