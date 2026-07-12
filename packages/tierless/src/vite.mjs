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
import { writeFileSync, mkdirSync, readFileSync, appendFileSync, existsSync, rmSync } from "node:fs";
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
//
// The emitted bundle is loaded by NODE, not Vite, so Vite-only specifier forms must not
// leak into it: an extensionless "./format" resolves to the real .mjs/.js file at emit
// time, and a target only Vite could load (a .ts file, an alias) FAILS THE BUILD here —
// a broken import in dist-tierless/ would otherwise surface as a runtime crash in
// bundleResolverFromManifest, far from its cause.
const resolveEmitTarget = (srcDir, spec) => {
    const abs = path.resolve(srcDir, spec);
    if (existsSync(abs) && path.extname(abs))
        return abs;
    for (const ext of [".mjs", ".js"])
        if (existsSync(abs + ext))
            return abs + ext;
    for (const ext of [".mts", ".ts", ".tsx", ".vue"])
        if (existsSync(abs + ext)) {
            throw new Error(`tierless: "${spec}" resolves to ${path.basename(abs + ext)} — the server bundle for a "use tierless" module is loaded by Node as-is; import a plain .mjs/.js helper instead`);
        }
    return abs; // missing target: leave it to Node to report, same as before
};
const rewriteRelativeImports = (code, srcDir, outDir, specs, mixByPath, aliases = {}) => {
    let out = code;
    for (const spec of specs) {
        const abs = resolveEmitTarget(srcDir, spec);
        const mix = mixByPath.get(abs);
        let rel = mix ? "./" + mix : path.relative(outDir, abs).split(path.sep).join("/");
        if (!rel.startsWith("."))
            rel = "./" + rel;
        out = out.replace(new RegExp(`((?:from|import)\\s*)(['"])${escapeRegExp(spec)}\\2`, "g"), `$1$2${rel}$2`);
    }
    // an alias specifier ('@/helpers') reads as a scoped npm package to Node — it would
    // emit fine and crash at load; the actions path is deliberately NOT esbuild-bundled
    // (the emitted machine is the compiler's own output, byte-identical), so aliases in a
    // "use tierless" module are a build error with a fix, never a delayed runtime one
    for (const find of Object.keys(aliases)) {
        const hit = new RegExp(`(?:from|import)\\s*['"]${escapeRegExp(find)}[/'"]`).exec(out);
        if (hit)
            throw new Error(`tierless: a "use tierless" module imports through the Vite alias "${find}" — the emitted server bundle is not alias-aware; use a relative import to a .mjs/.js helper`);
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
    compile: compileList, // app files whose class methods compile (real-code port)
    twins: twinsModule, // app module exporting TWIN_CLASSES stamping + makeTwins (docs/migrate-arm.md)
    twinsStubs = [], // browser-bound module ids stubbed in the twins bundle
     } = opts;
    const isTierlessModule = (code) => DIRECTIVE.test(code);
    const hasCompile = !!(compileList && compileList.length);
    let compileTargets = new Set(); // absolute paths, resolved once root is known
    let sidecar = null;
    const machines = new Map(); // moduleId -> compiled server machine + its relative imports
    // wire id -> the machine-only server module for a compiled APP file (meta.serverCode) +
    // where its relative/aliased imports resolve from. Bundled (esbuild) at writeBundle so
    // the gateway can RESUME migrated methods (docs/migrate-arm.md); the fetch arm never
    // needed it — handleExec is bundle-free — so this is additive.
    const appMachines = new Map();
    let root = process.cwd(); // Vite root, captured in configResolved (for the build emit path)
    let aliases = {}; // string finds from Vite's resolved alias, for the server-machine bundle
    const SHIM_ID = "\0tierless-shim";
    // The shim virtual module: the compiled adapt-shim body plus this build's route table.
    // Workflow modules load through dynamic import, so they pass through the transform above
    // and land in dist-tierless like any mix module; the session socket carries the user's
    // token (read at connect) as a bearer.<base64url> subprotocol the preview gateway
    // forwards to the backend — subprotocol, not query param, so it never reaches access logs.
    const shimSource = () => {
        const configure = [
            // the twins module's browser side effect stamps each twinned class's identity onto
            // its prototype — what a §5 handle carries so the gateway can dispatch to a twin
            ...(twinsModule ? [`import ${JSON.stringify("/" + twinsModule.replace(/^\//, ""))};`] : []),
            `import { configureTierless } from ${JSON.stringify(runtime)};`,
            // url is a thunk (token read at connect time, not page load); preconnect only when a
            // session already exists — the handshake then overlaps app bootstrap instead of
            // landing on the first navigation's critical path. Fresh visitors stay lazy.
            `configureTierless({ url: () => (location.protocol === "https:" ? "wss" : "ws") + "://" + location.host + ${JSON.stringify(wsPath || WS_PATH)}, protocols: () => { const t = localStorage.getItem("token"); return t ? ["tierless", "bearer." + btoa(t).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "")] : ["tierless"]; }, preconnect: !!localStorage.getItem("token") });`,
        ];
        if (!workflows)
            return configure.join("\n"); // compile-only: session config, no route/XHR machinery
        const body = readFileSync(fileURLToPath(new URL("./adapt-shim.mjs", import.meta.url)), "utf8");
        const routes = Object.fromEntries(Object.entries(workflows).map(([p, m]) => [p, m.startsWith("/") ? m : "/" + m.replace(/^\.\//, "")]));
        const loaders = Object.values(routes).map((m) => `${JSON.stringify(m)}: () => import(${JSON.stringify(m)})`).join(", ");
        return [
            ...configure,
            `const __TIERLESS_ROUTES__ = ${JSON.stringify(routes)};`,
            `const __TIERLESS_MODULES__ = { ${loaders} };`,
            body,
        ].join("\n");
    };
    return {
        name: "tierless",
        enforce: "pre",
        async transform(code, id) {
            // real-code compilation: a configured app file (TypeScript, classes) — strip types
            // with Vite's own esbuild, compile class methods, self-bind to the session. No
            // server emit: the fetch arm never runs the machine server-side (handleExec only
            // needs the exec), which also sidesteps app-alias imports (@/…) in Node.
            const cleanId = id.split("?")[0];
            if (hasCompile && compileTargets.has(path.resolve(cleanId))) {
                // strip types with the APP's own esbuild (resolved from the Vite root, not from
                // this package — under pnpm's strict linking we can't see the app's deps)
                const appRequire = createRequire(path.join(root, "package.json"));
                const esbuild = appRequire("esbuild");
                const stripped = esbuild.transformSync(code, { loader: "ts", format: "esm", target: "es2022", sourcefile: cleanId });
                const { compile } = require("./transform.cjs");
                const { code: compiled, meta } = compile(stripped.code, { ...compilerOptions, resources: { "this.http": "server", ...(resources || {}) }, filename: id, preamble: "" });
                for (const m of meta.methods)
                    if (m.error)
                        this?.warn?.(`tierless: ${m.class}.${m.method} kept original — ${m.error}`);
                if (!meta.methods.some((m) => m.program)) {
                    this?.warn?.(`tierless: ${id} is in compile[] but no method compiled`);
                    return null;
                }
                if (meta.serverCode)
                    appMachines.set("m:" + shortHash(cleanId), { code: meta.serverCode, resolveDir: path.dirname(cleanId) });
                const binder = [
                    `import { bindMethods as __tlBindMethods } from ${JSON.stringify(runtime)};`,
                    `export const __bundle = { PROGRAMS, __unwind, __bindTierlessMethods, BUNDLE_HASH, ...(typeof __slots === "undefined" ? {} : { __slots }) };`,
                    `__tlBindMethods(__bundle, { module: ${JSON.stringify("m:" + shortHash(cleanId))} });` // wire id: a hash, not the ~85 B source path — it rides EVERY exec message (app modules resolve to the exec-only host, so any stable id works),
                ].join("\n");
                return { code: compiled + "\n" + binder + "\n", map: null };
            }
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
        configResolved(config) {
            if (config?.root)
                root = config.root;
            compileTargets = new Set((compileList || []).map((p) => path.resolve(root, p)));
            // string alias finds ('@' -> src) carry over to the server-machine esbuild bundle;
            // regex finds don't map onto esbuild's alias option and are skipped (loudly at build
            // time if a machine import then fails to resolve — never silently misresolved).
            aliases = Object.fromEntries((config?.resolve?.alias || []).filter((a) => typeof a.find === "string").map((a) => [a.find, a.replacement]));
        },
        buildStart() { machines.clear(); appMachines.clear(); }, // fresh build: transform repopulates the maps
        // Build: emit the server side of what the client build just produced. For every "use tierless"
        // module the transform compiled, write its machine (byte-identical to `tierless build --bare` —
        // the SAME compiler output, no second pass) plus a manifest mapping the module id the browser
        // stamps onto the wire to its bundle file. A prod server mounts these with
        // `bundleResolverFromManifest` — no hand-written module resolver, no re-compile. Runs on build
        // only (Vite never calls writeBundle in dev serve).
        writeBundle() {
            if (!machines.size && !appMachines.size) {
                // dist-tierless/ lives OUTSIDE Vite's cleaned outDir: a build with no tierless
                // modules must not leave the PREVIOUS build's manifest for a server to mount
                try {
                    rmSync(path.resolve(root, serverOutDir, "tierless.manifest.json"), { force: true });
                }
                catch { /* nothing stale */ }
                return;
            }
            const outDir = path.resolve(root, serverOutDir);
            mkdirSync(outDir, { recursive: true });
            const modules = {};
            const mixByPath = new Map(); // resolved source path -> its server bundle filename
            for (const id of machines.keys())
                mixByPath.set(path.resolve(id), serverBundleName(id));
            for (const [id, { code, imports }] of machines) {
                const name = serverBundleName(id);
                const emitted = rewriteRelativeImports(code, path.dirname(id), outDir, imports, mixByPath, aliases);
                writeFileSync(path.join(outDir, name), emitted);
                modules[id] = name;
            }
            // Compiled APP modules: the machine-only server module still imports app-graph
            // helpers ('@/models/…', packages) — esbuild bundles that closure into ONE
            // Node-loadable file, aliases resolved from the app's own Vite config. Errors here
            // are BUILD errors: a machine import that can't resolve fails the build, never a
            // half-emitted gateway.
            if (appMachines.size) {
                const esbuild = createRequire(path.join(root, "package.json"))("esbuild");
                for (const [wireId, { code, resolveDir }] of appMachines) {
                    const name = wireId.replace(/[^A-Za-z0-9._-]/g, "_") + ".server.mjs";
                    esbuild.buildSync({
                        stdin: { contents: code, resolveDir, loader: "js", sourcefile: wireId },
                        bundle: true, format: "esm", platform: "node", target: "es2022",
                        // a CJS dep in the graph (axios & co) compiles to require() calls — give the
                        // ESM output a real require for node builtins instead of esbuild's throw-shim
                        banner: { js: 'import { createRequire as __tlCreateRequire } from "node:module"; const require = __tlCreateRequire(import.meta.url);' },
                        outfile: path.join(outDir, name), alias: aliases, logLevel: "silent",
                    });
                    modules[wireId] = name;
                }
            }
            // the twins module: the app's own service classes, Node-bundled so the gateway can
            // construct per-session twin instances (docs/migrate-arm.md "twins and correctness")
            let twinsOut;
            if (twinsModule) {
                const esbuild = createRequire(path.join(root, "package.json"))("esbuild");
                twinsOut = "twins.server.mjs";
                // stub file is CJS ON PURPOSE: named imports from CJS resolve at RUNTIME, so one
                // Proxy covers every name a stubbed browser module exports
                const stubPath = path.join(outDir, "__tl_twin_stub.cjs");
                if (twinsStubs.length)
                    writeFileSync(stubPath, "module.exports = new Proxy({}, { get: (_, k) => (k === \"__esModule\" ? undefined : () => { throw new Error(\"tierless twin stub called: \" + String(k) + \" — audit the twins list\"); }) });\n");
                esbuild.buildSync({
                    entryPoints: [path.resolve(root, twinsModule)],
                    bundle: true, format: "esm", platform: "node", target: "es2022",
                    banner: { js: 'import { createRequire as __tlCreateRequire } from "node:module"; const require = __tlCreateRequire(import.meta.url);' },
                    outfile: path.join(outDir, twinsOut),
                    alias: { ...aliases, ...Object.fromEntries(twinsStubs.map((id) => [id, stubPath])) }, // exact ids beat the '@' prefix: esbuild prefers the longest alias match
                    logLevel: "silent",
                });
            }
            writeFileSync(path.join(outDir, "tierless.manifest.json"), JSON.stringify({ path: wsPath || WS_PATH, modules, ...(twinsOut ? { twins: twinsOut } : {}) }, null, 2) + "\n");
        },
        // ---- injected page glue: session config (+ the route shim when workflows are on) ----
        resolveId(id) { return (workflows || hasCompile) && (id === "tierless-shim" || id === SHIM_ID) ? SHIM_ID : undefined; },
        load(id) { return (workflows || hasCompile) && id === SHIM_ID ? shimSource() : undefined; },
        // an INLINE module import, injected with order "pre" so vite's own html pipeline (which
        // extracts and bundles inline module scripts) still runs after us — a bare src attribute
        // or a post-ordered tag ships as literal text and never enters the module graph
        transformIndexHtml: {
            order: "pre",
            handler(html) {
                if (!workflows && !hasCompile)
                    return html;
                return { html, tags: [{ tag: "script", attrs: { type: "module" }, children: 'import "tierless-shim";', injectTo: "head" }] };
            },
        },
        // `vite preview` serves the built app; with workflows configured it also HOSTS the
        // session endpoint, resolving machines from this build's dist-tierless manifest and
        // servicing api.* against the existing backend (restResources), forwarding the token
        // the shim put on the socket URL. The target app's diff stays the one config line.
        async configurePreviewServer(server) {
            if (!workflows && !hasCompile)
                return;
            const s = server;
            const { attachTierless, bundleResolverFromManifest, makeWireStats, bearerFromUpgrade } = await import("./server.mjs");
            const { restResources, httpResources, twinHttp } = await import("./adapt.mjs");
            // TCP-true session byte counter for measured runs (suite truth protocol): CDP sees
            // ws frames post-inflate, so the gateway itself is the only honest place to count
            const wire = process.env.TIERLESS_WIRE_TRUTH ? makeWireStats() : undefined;
            if (wire)
                s.middlewares.use("/__tierless/wire", (_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(wire.read())); });
            // Run protocol (docs/corpus.md): a PROFILING run appends browser trace batches to
            // TIERLESS_TRACE_OUT; a COMPARISON run serves the locked TIERLESS_PROFILE. The shim
            // wires the browser side to these endpoints when the matching env is set at preview.
            if (process.env.TIERLESS_TRACE_OUT) {
                const out = process.env.TIERLESS_TRACE_OUT;
                s.middlewares.use("/__tierless/trace", (req, res) => {
                    let body = "";
                    req.on("data", (c) => { body += String(c); });
                    req.on("end", () => { try {
                        appendFileSync(out, body.endsWith("\n") || !body ? body : body + "\n");
                    }
                    catch { /* profiling only; never fail the app */ } res.statusCode = 204; res.end(); });
                });
            }
            if (process.env.TIERLESS_PROFILE) {
                const profileJson = readFileSync(process.env.TIERLESS_PROFILE, "utf8"); // read at boot: comparison runs are frozen
                s.middlewares.use("/__tierless/profile", (_req, res) => { res.setHeader("content-type", "application/json"); res.end(profileJson); });
            }
            if (!apiUrl)
                throw new Error("tierless: workflows/compile need { apiUrl } (the backend the gateway calls)");
            // compiled APP modules have no server emit (the fetch arm runs no machine here) —
            // their sessions get an exec-only host; workflow modules resolve from the manifest
            let fromManifest = null;
            try {
                fromManifest = await bundleResolverFromManifest(path.join(root, serverOutDir, "tierless.manifest.json"));
            }
            catch (e) {
                if (workflows)
                    throw e;
            }
            const EXEC_ONLY = { PROGRAMS: {}, __unwind: () => false };
            // Compiled APP modules resolve to ONE merged machine world (docs/migrate-arm.md
            // slice 3): a migrated store frame's dynamic call park must find the service
            // module's programs, whatever module id the wire happens to carry.
            let appMerged = null;
            const mergedApp = async () => {
                if (appMerged || !fromManifest)
                    return appMerged;
                const manifest = JSON.parse(readFileSync(path.join(root, serverOutDir, "tierless.manifest.json"), "utf8"));
                const merged = { PROGRAMS: {}, __unwind: null, __slots: {} };
                for (const id of Object.keys(manifest.modules)) {
                    if (!id.startsWith("m:"))
                        continue;
                    const b = await fromManifest(id);
                    Object.assign(merged.PROGRAMS, b.PROGRAMS);
                    if (b.__slots)
                        Object.assign(merged.__slots, b.__slots);
                    if (!merged.__unwind)
                        merged.__unwind = b.__unwind;
                }
                return (appMerged = merged.__unwind ? merged : null);
            };
            attachTierless(s.httpServer, {
                path: wsPath,
                wire,
                bundle: async (id) => {
                    if (id.startsWith("m:")) {
                        try {
                            const m = await mergedApp();
                            if (m)
                                return m;
                        }
                        catch { /* fall through */ }
                    }
                    if (fromManifest) {
                        try {
                            return await fromManifest(id);
                        }
                        catch { /* an app module: exec-only */ }
                    }
                    return EXEC_ONLY;
                },
                session: async (req) => {
                    const token = bearerFromUpgrade(req);
                    const rest = restResources(apiUrl, { token });
                    // the twin of the app's own axios instance: http.* from compiled class methods
                    const twin = httpResources(twinHttp(apiUrl, { token }));
                    const log = !!process.env.TIERLESS_LOG_EXEC;
                    // session twin INSTANCES of the app's own service classes (manifest.twins):
                    // a migrated chain's dynamic call parks settle on these, interceptors and all
                    let twinReg;
                    try {
                        const manifest = JSON.parse(readFileSync(path.join(root, serverOutDir, "tierless.manifest.json"), "utf8"));
                        if (manifest.twins) {
                            const mod = await import(pathToFileURL(path.join(root, serverOutDir, manifest.twins)).href);
                            if (typeof mod.makeTwins === "function")
                                twinReg = mod.makeTwins({ token: token ?? null, apiUrl });
                        }
                    }
                    catch { /* no twins bundle: chains dispatch home, correctness unchanged */ }
                    return { exec: (r) => {
                            if (log)
                                console.log("[tierless exec]", r.name, JSON.stringify(r.args).slice(0, 3000));
                            return r.name.startsWith("http.") ? twin(r) : rest(r);
                        }, ...(twinReg ? { twins: twinReg } : {}) };
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
                    // compiled APP modules stamp opaque m:<hash> wire ids — not loadable module
                    // paths. In dev their frames run in the browser (fetch arm) and only exec
                    // crossings arrive here, so an exec-only host serves them; migration needs
                    // the built manifest (vite preview / prod), and a resume against this host
                    // fails with "no machine", not a bogus ssrLoadModule("m:…") error.
                    if (moduleId.startsWith("m:"))
                        return { PROGRAMS: {}, __unwind: () => false };
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
