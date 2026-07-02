// The PRODUCTION shape of the dev endpoint the Vite plugin hosts — the same contract,
// mounted yourself. Build first:
//
//   npx vite build                                                   # client (plugin transforms "use tierless" at build time)
//   npx tierless build src/actions.mjs actions.server.gen.mjs --bare # the server copy of the same machine
//   node server.prod.mjs                                             # serve dist/ + the session endpoint
//
// The browser bundle's actions carry their build-time module id; the resolver below
// matches it by suffix and hands back the CLI-built machine — identical PROGRAMS,
// because the same compiler emitted both. Put wss:// termination and your real session
// auth in front of this in a real deployment (see docs/production.md).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serveApp } from "tierless/server";
import { startSidecar, makeApiExec } from "tierless/api";
import * as actions from "./actions.server.gen.mjs";

const apiService = startSidecar(new URL("./src/api.server.mjs", import.meta.url));
await apiService.ready();

const app = await serveApp({
  port: process.env.PORT ? Number(process.env.PORT) : 8080,
  staticRoot: fileURLToPath(new URL("./dist/", import.meta.url)),
  page: readFileSync(new URL("./dist/index.html", import.meta.url), "utf8"),
  bundle: (moduleId) => {
    if (moduleId.endsWith("/src/actions.mjs")) return { PROGRAMS: actions.PROGRAMS, __unwind: actions.__unwind };
    throw new Error("unknown mix module: " + moduleId);
  },
  session: async () => {
    const login = await apiService.call("login", [{ user: "ana", pass: "demo" }]);
    if (!login.ok) throw new Error("login failed: " + login.error);
    return { exec: makeApiExec(apiService, login.value) };
  },
});

console.log(`production server on http://localhost:${app.port}`);
const shutdown = () => { apiService.close(); app.close(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
