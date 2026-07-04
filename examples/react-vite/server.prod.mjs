// The PRODUCTION shape of the dev endpoint the Vite plugin hosts — the same contract, mounted
// yourself. `vite build` emits the server side too (the plugin's writeBundle drops the compiled
// machines + a manifest into dist-tierless/), so there is no second compile and no hand-written
// module resolver — `bundleResolverFromManifest` reads the manifest and hands `serveApp` the
// bundle straight:
//
//   npx vite build       # client bundle in dist/  +  server machines & manifest in dist-tierless/
//   node server.prod.mjs # serve dist/ + the session endpoint
//
// The browser and server machines are identical because the SAME compiler pass emitted both. Put
// wss:// termination and your real session auth in front of this in a real deployment (see
// docs/production.md).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serveApp, bundleResolverFromManifest } from "tierless/server";
import { startSidecar, makeApiExec } from "tierless/api";

const apiService = startSidecar(new URL("./src/api.server.mjs", import.meta.url));
await apiService.ready();

const app = await serveApp({
  port: process.env.PORT ? Number(process.env.PORT) : 8080,
  staticRoot: fileURLToPath(new URL("./dist/", import.meta.url)),
  page: readFileSync(new URL("./dist/index.html", import.meta.url), "utf8"),
  bundle: await bundleResolverFromManifest(
    fileURLToPath(new URL("./dist-tierless/tierless.manifest.json", import.meta.url)),
  ),
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
