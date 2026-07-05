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
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { WS_PATH } from "./ws-path.mjs";
const require = createRequire(import.meta.url);
const DIRECTIVE = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*["']use tierless["']\s*;?/;
// A stable, collision-free filename for a module's server bundle: its basename plus a short
// FNV-1a hash of the full id (two src/actions.mjs in different dirs don't clash).
const shortHash = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
};
const serverBundleName = (id) => path.basename(id).replace(/\.[^.]+$/, "") + "." + shortHash(id) + ".server.mjs";
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Rewrite a server bundle's own relative import specifiers so they resolve from the emit dir
// (dist-tierless/) instead of the source dir. Two cases:
//   - the target is another compiled mix module → point at ITS co-located server bundle
//     (`./format.<hash>.server.mjs`), so a mix module importing another resolves to the compiled
//     copy and dist-tierless/ is self-contained for the mix-to-mix graph;
//   - anything else (a plain helper) → `../src/util.mjs`, machine-independent (source and emit
//     dirs travel together in the deploy tree, the same assumption the served api.server.mjs
//     already relies on).
// Only the exact specifiers the compiler reported are touched, and only in `from "…"` / `import "…"`
// position, so a string literal in the machine body that happens to look like a path is never hit.
const rewriteRelativeImports = (code, srcDir, outDir, specs, mixByPath) => {
    let out = code;
    for (const spec of specs) {
        const abs = path.resolve(srcDir, spec);
        const mix = mixByPath.get(abs);
        let rel = mix ? "./" + mix : path.relative(outDir, abs).split(path.sep).join("/");
        if (!rel.startsWith("."))
            rel = "./" + rel;
        out = out.replace(new RegExp(`((?:from|import)\\s*)(['"])${escapeRegExp(spec)}\\2`, "g"), `$1$2${rel}$2`);
    }
    return out;
};
export default function tierless(opts = {}) {
    const { api, // path to the trusted service module (forked as a sidecar)
    login = null, // { user, pass }: log in once per connection, carry the token
    resources, // extra allow-list namespaces (merged over api/commit defaults)
    runtime = "tierless/browser", // import specifier for the browser host (overridable for tests)
    path: wsPath, // session endpoint path (defaults to WS_PATH)
    compilerOptions = {}, // passed through to the transform (trackWrites, sourceMap, …)
    serverOutDir = "dist-tierless", // where `vite build` emits the server bundles + manifest
    workflows, // route pattern -> workflow module (adapting an existing app)
    apiUrl, // the existing backend restResources proxies to
     } = opts;
    const isTierlessModule = (code) => DIRECTIVE.test(code);
    let sidecar = null;
    const machines = new Map(); // moduleId -> compiled server machine + its relative imports
    let root = process.cwd(); // Vite root, captured in configResolved (for the build emit path)
    const SHIM_ID = "\0tierless-shim";
    // The shim virtual module: the compiled adapt-shim body plus this build's route table.
    // Workflow modules load through dynamic import, so they pass through the transform above
    // and land in dist-tierless like any mix module; the session socket carries the user's
    // token (read at connect) as a query param the preview gateway forwards to the backend.
    const shimSource = () => {
        const body = readFileSync(fileURLToPath(new URL("./adapt-shim.mjs", import.meta.url)), "utf8");
        const routes = Object.fromEntries(Object.entries(workflows).map(([p, m]) => [p, m.startsWith("/") ? m : "/" + m.replace(/^\.\//, "")]));
        const loaders = Object.values(routes).map((m) => `${JSON.stringify(m)}: () => import(${JSON.stringify(m)})`).join(", ");
        return [
            `import { configureTierless } from ${JSON.stringify(runtime)};`,
            // url is a thunk (token read at connect time, not page load); preconnect only when a
            // session already exists — the handshake then overlaps app bootstrap instead of
            // landing on the first navigation's critical path. Fresh visitors stay lazy.
            `configureTierless({ url: () => (location.protocol === "https:" ? "wss" : "ws") + "://" + location.host + ${JSON.stringify(wsPath || WS_PATH)} + "?token=" + encodeURIComponent(localStorage.getItem("token") || ""), preconnect: !!localStorage.getItem("token") });`,
            `const __TIERLESS_ROUTES__ = ${JSON.stringify(routes)};`,
            `const __TIERLESS_MODULES__ = { ${loaders} };`,
            body,
        ].join("\n");
    };
    return {
        name: "tierless",
        enforce: "pre",
        transform(code, id) {
            if (id.includes("node_modules") || !isTierlessModule(code))
                return null;
            const { compile } = require("./transform.cjs");
            const { code: compiled, meta } = compile(code, { ...compilerOptions, resources, filename: id, preamble: "" });
            if (!meta.exported.length)
                this?.warn?.(`tierless: ${id} has "use tierless" but exports no suspendable function`);
            machines.set(id, { code: compiled, imports: meta.imports }); // the SAME machine the browser will run — emitted for the server at writeBundle
            const wrappers = [
                `import { bindActions as __bindActions } from ${JSON.stringify(runtime)};`,
                `export const __bundle = { PROGRAMS, __unwind };`,
                `const __actions = __bindActions(__bundle, { module: ${JSON.stringify(id)} });`,
                `export const __tierlessActions = __actions;`, // the module's ACTION surface, for the route shim (driver exports like run/__dispatch are not actions)
                ...meta.exported.map((n) => `export const ${n} = __actions[${JSON.stringify(n)}];`),
            ].join("\n");
            // No debugger sourcemap: the compiler rewrites the module into a state machine (whole-program
            // CPS), so output lines don't correspond to input lines — there is no honest line map to hand
            // Vite. (The compiler's own `--source-map` is a runtime frame→line table, unrelated to this.)
            return { code: compiled + "\n" + wrappers + "\n", map: null };
        },
        configResolved(config) { if (config?.root)
            root = config.root; },
        buildStart() { machines.clear(); }, // fresh build: transform repopulates the map
        // Build: emit the server side of what the client build just produced. For every "use tierless"
        // module the transform compiled, write its machine (byte-identical to `tierless build --bare` —
        // the SAME compiler output, no second pass) plus a manifest mapping the module id the browser
        // stamps onto the wire to its bundle file. A prod server mounts these with
        // `bundleResolverFromManifest` — no hand-written module resolver, no re-compile. Runs on build
        // only (Vite never calls writeBundle in dev serve).
        writeBundle() {
            if (!machines.size)
                return;
            const outDir = path.resolve(root, serverOutDir);
            mkdirSync(outDir, { recursive: true });
            const modules = {};
            const mixByPath = new Map(); // resolved source path -> its server bundle filename
            for (const id of machines.keys())
                mixByPath.set(path.resolve(id), serverBundleName(id));
            for (const [id, { code, imports }] of machines) {
                const name = serverBundleName(id);
                const emitted = imports.length ? rewriteRelativeImports(code, path.dirname(id), outDir, imports, mixByPath) : code;
                writeFileSync(path.join(outDir, name), emitted);
                modules[id] = name;
            }
            writeFileSync(path.join(outDir, "tierless.manifest.json"), JSON.stringify({ path: wsPath || WS_PATH, modules }, null, 2) + "\n");
        },
        // ---- route workflows (adapting an existing app): the injected shim -----------------
        resolveId(id) { return workflows && (id === "tierless-shim" || id === SHIM_ID) ? SHIM_ID : undefined; },
        load(id) { return workflows && id === SHIM_ID ? shimSource() : undefined; },
        // an INLINE module import, injected with order "pre" so vite's own html pipeline (which
        // extracts and bundles inline module scripts) still runs after us — a bare src attribute
        // or a post-ordered tag ships as literal text and never enters the module graph
        transformIndexHtml: {
            order: "pre",
            handler(html) {
                if (!workflows)
                    return html;
                return { html, tags: [{ tag: "script", attrs: { type: "module" }, children: 'import "tierless-shim";', injectTo: "head" }] };
            },
        },
        // `vite preview` serves the built app; with workflows configured it also HOSTS the
        // session endpoint, resolving machines from this build's dist-tierless manifest and
        // servicing api.* against the existing backend (restResources), forwarding the token
        // the shim put on the socket URL. The target app's diff stays the one config line.
        async configurePreviewServer(server) {
            if (!workflows)
                return;
            const s = server;
            const { attachTierless, bundleResolverFromManifest } = await import("./server.mjs");
            const { restResources } = await import("./adapt.mjs");
            if (!apiUrl)
                throw new Error("tierless: workflows need { apiUrl } (the backend restResources proxies to)");
            const bundle = await bundleResolverFromManifest(path.join(root, serverOutDir, "tierless.manifest.json"));
            attachTierless(s.httpServer, {
                path: wsPath,
                bundle,
                session: async (req) => {
                    const token = new URL(req.url || "/", "http://x").searchParams.get("token") || undefined;
                    return { exec: restResources(apiUrl, { token }) };
                },
            });
        },
        // Dev server: fork the api sidecar and host the session endpoint on Vite's own http
        // server. Each module's continuations resolve their server copy via ssrLoadModule,
        // so the browser and the server always run the SAME transformed machine.
        async configureServer(server) {
            const s = server;
            const { attachTierless } = await import("./server.mjs");
            const { startSidecar, makeApiExec } = await import("./api/sidecar.mjs");
            if (api) {
                const entry = pathToFileURL(path.resolve(s.config?.root || process.cwd(), api));
                sidecar = startSidecar(entry);
                await sidecar.ready();
                s.httpServer.on("close", () => sidecar.close());
            }
            attachTierless(s.httpServer, {
                path: wsPath,
                bundle: async (moduleId) => {
                    if (!moduleId)
                        throw new Error("tierless: session did not name its module");
                    const mod = await s.ssrLoadModule(moduleId);
                    if (!mod.__bundle)
                        throw new Error("tierless: " + moduleId + " is not a tierless module");
                    return mod.__bundle;
                },
                session: async () => {
                    let token = null;
                    if (sidecar && login) {
                        const res = await sidecar.call("login", [login]);
                        if (!res.ok)
                            throw new Error("tierless: login failed: " + res.error);
                        token = res.value;
                    }
                    const exec = sidecar ? makeApiExec(sidecar, token)
                        : () => { throw new Error("tierless: no api service configured (pass { api } to the plugin)"); };
                    return { exec };
                },
            });
        },
    };
}
