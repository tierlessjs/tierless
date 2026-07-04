// Tierless ⨯ Vite — wire actions into an existing web app with one plugin.
//
//   // vite.config.mjs
//   import react from "@vitejs/plugin-react";
//   import tierless from "tierless/vite";
//   export default { plugins: [react(), tierless({ api: "./src/api.server.mjs" })] };
//
// Any module whose first statement is the "use tierless" directive is compiled by the Tierless
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
// attachTierless(yourServer, ...) with the built module — same contract.
//
// The plugin is a plain object (no vite import), so it is unit-testable headless.
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Server as HttpServer } from "node:http";
import type { SidecarClient } from "./api/sidecar.mjs";

const require = createRequire(import.meta.url);

const DIRECTIVE = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*["']use tierless["']\s*;?/;

export interface TierlessPluginOptions {
  /** Path to the trusted service module (forked as a reference-monitor sidecar). */
  api?: string;
  /** Demo session: log in once per connection with these credentials, carry the token. */
  login?: { user: string; pass: string } | null;
  /** Extra allow-list namespaces merged over the api/commit defaults. Note: the dev plugin's own
   *  server exec (`makeApiExec` over the sidecar) services `api.*` only — pinning another namespace
   *  here also needs a custom exec that can service it, or those calls throw at runtime. */
  resources?: Record<string, string>;
  /** Import specifier for the browser host in emitted modules (test override). */
  runtime?: string;
  /** Session endpoint path (defaults to WS_PATH). */
  path?: string;
  /** Passed through to the compiler (e.g. `trackWrites`). Note: the compiler's `sourceMap` emits a
   *  runtime frame→line table for `file:line` reporting (see source-maps.mts), not a debugger
   *  sourcemap Vite can chain — this transform returns no map (see below). */
  compilerOptions?: Record<string, unknown>;
}
export interface TierlessPlugin {
  name: string;
  enforce: "pre";
  transform(code: string, id: string): { code: string; map: null } | null;
  configureServer(server: unknown): Promise<void>;
}

// A minimal Vite ViteDevServer shape — just the fields this plugin actually touches. vite
// itself isn't a dependency here (the plugin is a plain object, unit-testable headless), so
// there's no real type to import; configureServer's own param stays `unknown` for callers.
interface ViteDevServerLike {
  config?: { root?: string };
  httpServer: HttpServer | null;
  ssrLoadModule(id: string): Promise<any>;
}

export default function tierless(opts: TierlessPluginOptions = {}): TierlessPlugin {
  const {
    api,                                   // path to the trusted service module (forked as a sidecar)
    login = null,                          // { user, pass }: log in once per connection, carry the token
    resources,                             // extra allow-list namespaces (merged over api/commit defaults)
    runtime = "tierless/browser",          // import specifier for the browser host (overridable for tests)
    path: wsPath,                          // session endpoint path (defaults to WS_PATH)
    compilerOptions = {},                  // passed through to the transform (trackWrites, sourceMap, …)
  } = opts;

  const isTierlessModule = (code: string): boolean => DIRECTIVE.test(code);
  let sidecar: SidecarClient | null = null;

  return {
    name: "tierless",
    enforce: "pre",

    transform(this: any, code: string, id: string): { code: string; map: null } | null {
      if (id.includes("node_modules") || !isTierlessModule(code)) return null;
      const { compile } = require("./transform.cjs");
      const { code: compiled, meta } = compile(code, { ...compilerOptions, resources, filename: id, preamble: "" });
      if (!meta.exported.length) this?.warn?.(`tierless: ${id} has "use tierless" but exports no suspendable function`);
      const wrappers = [
        `import { bindActions as __bindActions } from ${JSON.stringify(runtime)};`,
        `export const __bundle = { PROGRAMS, __unwind };`,
        `const __actions = __bindActions(__bundle, { module: ${JSON.stringify(id)} });`,
        ...meta.exported.map((n: string) => `export const ${n} = __actions[${JSON.stringify(n)}];`),
      ].join("\n");
      // No debugger sourcemap: the compiler rewrites the module into a state machine (whole-program
      // CPS), so output lines don't correspond to input lines — there is no honest line map to hand
      // Vite. (The compiler's own `--source-map` is a runtime frame→line table, unrelated to this.)
      return { code: compiled + "\n" + wrappers + "\n", map: null };
    },

    // Dev server: fork the api sidecar and host the session endpoint on Vite's own http
    // server. Each module's continuations resolve their server copy via ssrLoadModule,
    // so the browser and the server always run the SAME transformed machine.
    async configureServer(server: unknown): Promise<void> {
      const s = server as ViteDevServerLike;
      const { attachTierless } = await import("./server.mjs");
      const { startSidecar, makeApiExec } = await import("./api/sidecar.mjs");
      if (api) {
        const entry = pathToFileURL(path.resolve(s.config?.root || process.cwd(), api));
        sidecar = startSidecar(entry);
        await sidecar.ready();
        s.httpServer!.on("close", () => sidecar!.close());
      }
      attachTierless(s.httpServer!, {
        path: wsPath,
        bundle: async (moduleId: string) => {
          if (!moduleId) throw new Error("tierless: session did not name its module");
          const mod = await s.ssrLoadModule(moduleId);
          if (!mod.__bundle) throw new Error("tierless: " + moduleId + " is not a tierless module");
          return mod.__bundle;
        },
        session: async () => {
          let token: string | null = null;
          if (sidecar && login) {
            const res = await sidecar.call("login", [login]);
            if (!res.ok) throw new Error("tierless: login failed: " + res.error);
            token = res.value as string;
          }
          const exec = sidecar ? makeApiExec(sidecar, token)
            : () => { throw new Error("tierless: no api service configured (pass { api } to the plugin)"); };
          return { exec };
        },
      });
    },
  };
}
