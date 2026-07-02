// Stackmix ⨯ Vite — mix actions into an existing web app with one plugin.
//
//   // vite.config.mjs
//   import react from "@vitejs/plugin-react";
//   import stackmix from "stackmix/vite";
//   export default { plugins: [react(), stackmix({ api: "./src/api.server.mjs" })] };
//
// Any module whose first statement is the "use mix" directive is compiled by the Stackmix
// transform: its exported functions become ACTIONS — plain calls from the app's point of
// view that run as migratable continuations, with every api.* serviced on the dev server
// through the reference-monitor sidecar (forked from `api`), and any browser-pinned
// resource bouncing back to the page mid-flight. Pure helpers in the module run wherever
// the continuation is standing.
//
// The SAME transformed module serves both sides: in the browser it exports bound action
// wrappers (one shared lazy socket per page); on the server the session endpoint loads it
// through Vite's ssrLoadModule and drives the raw machine (__bundle). Dev-first: this
// plugin hosts the endpoint on Vite's own http server. For production, mount
// attachStackmix(yourServer, ...) with the built module — same contract.
//
// The plugin is a plain object (no vite import), so it is unit-testable headless.
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

const DIRECTIVE = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*["']use mix["']\s*;?/;

export default function stackmix(opts = {}) {
  const {
    api,                                   // path to the trusted service module (forked as a sidecar)
    login = null,                          // { user, pass }: log in once per connection, carry the token
    resources,                             // extra allow-list namespaces (merged over api/commit defaults)
    runtime = "stackmix/browser",          // import specifier for the browser host (overridable for tests)
    path: wsPath,                          // session endpoint path (defaults to WS_PATH)
    compilerOptions = {},                  // passed through to the transform (trackWrites, sourceMap, …)
  } = opts;

  const isMix = (code) => DIRECTIVE.test(code);
  let sidecar = null;

  return {
    name: "stackmix",
    enforce: "pre",

    transform(code, id) {
      if (id.includes("node_modules") || !isMix(code)) return null;
      const { compile } = require("./transform.cjs");
      const { code: compiled, meta } = compile(code, { ...compilerOptions, resources, filename: id, preamble: "" });
      if (!meta.exported.length) this?.warn?.(`stackmix: ${id} has "use mix" but exports no suspendable function`);
      const wrappers = [
        `import { bindActions as __bindActions } from ${JSON.stringify(runtime)};`,
        `export const __bundle = { PROGRAMS, __unwind };`,
        `const __actions = __bindActions(__bundle, { module: ${JSON.stringify(id)} });`,
        ...meta.exported.map((n) => `export const ${n} = __actions[${JSON.stringify(n)}];`),
      ].join("\n");
      return { code: compiled + "\n" + wrappers + "\n", map: null };
    },

    // Dev server: fork the api sidecar and host the session endpoint on Vite's own http
    // server. Each mix-module's continuations resolve their server copy via ssrLoadModule,
    // so the browser and the server always run the SAME transformed machine.
    async configureServer(server) {
      const { attachStackmix } = await import("./server.mjs");
      const { startSidecar, makeApiExec } = await import("./api/sidecar.mjs");
      if (api) {
        const entry = pathToFileURL(path.resolve(server.config?.root || process.cwd(), api));
        sidecar = startSidecar(entry);
        await sidecar.ready();
        server.httpServer?.on("close", () => sidecar && sidecar.close());
      }
      attachStackmix(server.httpServer, {
        path: wsPath,
        bundle: async (moduleId) => {
          if (!moduleId) throw new Error("stackmix: session did not name its mix-module");
          const mod = await server.ssrLoadModule(moduleId);
          if (!mod.__bundle) throw new Error("stackmix: " + moduleId + " is not a mix module");
          return mod.__bundle;
        },
        session: async () => {
          let token = null;
          if (sidecar && login) {
            const res = await sidecar.call("login", [login]);
            if (!res.ok) throw new Error("stackmix: login failed: " + res.error);
            token = res.value;
          }
          const exec = sidecar ? makeApiExec(sidecar, token)
            : () => { throw new Error("stackmix: no api service configured (pass { api } to the plugin)"); };
          return { exec };
        },
      });
    },
  };
}
