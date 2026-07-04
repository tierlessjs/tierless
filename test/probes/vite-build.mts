// Probe: the Vite build emit + prod mount. `vite build` compiles each "use tierless" module
// ONCE (the transform, for the browser) and — at writeBundle — emits the SAME machine for the
// server plus a manifest keyed by the module id the browser stamps onto the wire. A prod server
// mounts it with `bundleResolverFromManifest`: no second `tierless build` pass, no hand-written
// module resolver. This drives the plugin's build hooks headless, then stands up the real prod
// path (resolver + serveApp + sidecar) and calls an action across a socket, end to end.
import { writeFileSync, mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import tierless from "tierless/vite";
import { serveApp, bundleResolverFromManifest, WS_PATH } from "tierless/server";
import { startSidecar, makeApiExec } from "tierless/api";
import { configureTierless } from "tierless/browser";
import { makeCounter } from "../lib/check.mts";

const SRC_DIR = fileURLToPath(new URL("../../packages/tierless/src/", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "vite-build-"));
const { check, counts } = makeCounter();

// ---- fixtures: the trusted service + the app's "use tierless" actions module -----------
writeFileSync(join(dir, "api.server.mjs"), `
import { defineApi, PUBLIC } from ${JSON.stringify(pathToFileURL(join(SRC_DIR, "api/api.mjs")).href)};
import { sidecarMain } from ${JSON.stringify(pathToFileURL(join(SRC_DIR, "api/sidecar.mjs")).href)};
export const def = defineApi((api) => ({
  login: { authorize: PUBLIC, run: ([c]) => { if (!c || c.pass !== "demo") throw new Error("bad credentials"); return api.issue({ sub: c.user }, 60); } },
  getQuote: { authorize: PUBLIC, run: ([sym]) => sym.length * 10 },
  placeOrder: { authorize: (p) => p != null, run: ([o], p) => ({ by: p.sub, sym: o.sym, at: o.at }) },
}));
sidecarMain(def);
`);
const ACTIONS = `"use tierless";
export function rebalance(syms) {
  const orders = [];
  for (const s of syms) {
    const q = api.getQuote(s);
    if (q > 20) { const o = api.placeOrder({ sym: s, at: q }); orders.push(o.by + ":" + o.sym + "@" + o.at); }
  }
  return orders.join(",");
}
`;
const actionsId = join(dir, "actions.mjs");

console.log("Probe: the Vite build emit — one compile, a manifest, a prod mount with no re-compile\n");

const plugin = tierless({ api: "api.server.mjs", runtime: pathToFileURL(join(SRC_DIR, "browser.mjs")).href });

// ---- the client build: transform stamps the module id, writes the browser module ------------
const out = plugin.transform(ACTIONS, actionsId);
if (!out) throw new Error("transform returned null for a \"use tierless\" module");
writeFileSync(actionsId, out.code);

// ---- the build emit: writeBundle drops the server bundles + manifest ----------------------
plugin.configResolved({ root: dir });
plugin.writeBundle();

const manifestPath = join(dir, "dist-tierless", "tierless.manifest.json");
check("writeBundle emits a manifest", existsSync(manifestPath));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
check("the manifest keys the module by the build-time id the browser puts on the wire",
  manifest.modules[actionsId] !== undefined, Object.keys(manifest.modules));
check("the manifest records the endpoint path", manifest.path === WS_PATH, manifest.path);
const serverFile = join(dir, "dist-tierless", manifest.modules[actionsId]);
const serverMod: any = await import(pathToFileURL(serverFile).href);
check("the emitted server bundle IS the machine — same compiler output, no second pass",
  !!(serverMod.PROGRAMS && serverMod.PROGRAMS.rebalance) && typeof serverMod.__unwind === "function");

// ---- the prod mount: resolver + serveApp + sidecar, action call end to end ----------------
const apiService = startSidecar(pathToFileURL(join(dir, "api.server.mjs")));
await apiService.ready();
const bundle = await bundleResolverFromManifest(manifestPath);
const app = await serveApp({
  port: 0,
  bundle,                                                        // the whole server side: no hand-written dispatch
  session: async () => {
    const login = await apiService.call("login", [{ user: "ana", pass: "demo" }]);
    if (!login.ok) throw new Error("login failed: " + login.error);
    return { exec: makeApiExec(apiService, login.value as string) };
  },
});

configureTierless({ url: `ws://localhost:${app.port}${WS_PATH}` });
const mod: any = await import(pathToFileURL(actionsId).href);
const v = await mod.rebalance(["abc", "a", "abcd"]);
check("the prod path serves the action from the manifest bundle, monitor-authorized",
  v === "ana:abc@30,ana:abcd@40", v);

// a module the manifest never saw is a clear error, not a silent wrong machine
const missing = await bundle("/nope/unknown.mjs").then(() => null, (e: any) => String(e && e.message || e));
check("an unknown module id is rejected", missing !== null && missing.includes("no server bundle"), missing);

app.close();
apiService.close();

const { pass, fail } = counts();
const ok = fail === 0;
console.log(ok
  ? `\nOK — \`vite build\` emits the server machine + manifest and a prod server mounts it end to end, no second compile and no hand-written resolver (${pass} checks)`
  : `\nFAILED (${pass} passed, ${fail} failed)`);
process.exit(ok ? 0 : 1);
