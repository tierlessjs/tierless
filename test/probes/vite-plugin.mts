// Probe: the Vite plugin, headless. The plugin is a plain object, so this drives its two
// hooks against the real machinery with only Vite's surface faked (an httpServer + an
// ssrLoadModule that imports the transformed file):
//
//   transform   a "use tierless" module compiles; exported suspendable fns become bound
//               actions, pure exports pass through, non-tierless files are untouched;
//   configureServer + the emitted module, END TO END: the page-side action call crosses
//               a real socket to the endpoint on the (fake) Vite server, the SAME
//               transformed module is ssr-loaded to drive the server copy, every api.*
//               is authorized by the forked sidecar with the per-connection login token
//               — and without a login, the write is denied and the action rejects.
import http from "node:http";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import tierless from "tierless/vite";
import type { TierlessPlugin, TierlessPluginOptions } from "tierless/vite";
import { configureTierless } from "tierless/browser";
import { WS_PATH } from "tierless/server";
import { makeCounter } from "../lib/check.mts";

const SRC_DIR = fileURLToPath(new URL("../../packages/tierless/src/", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "vite-"));
const { check, counts } = makeCounter();

// ---- fixture: the trusted service (forked as a sidecar by the plugin) -----------------
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

// ---- fixture: the app's "use tierless" actions module ---------------------------------------
const ACTIONS = `"use tierless";
export function rebalance(syms) {
  const orders = [];
  for (const s of syms) {
    const q = api.getQuote(s);
    if (q > 20) { const o = api.placeOrder({ sym: s, at: q }); orders.push(o.by + ":" + o.sym + "@" + o.at); }
  }
  return orders.join(",");
}
export function fmt(x) { return "[" + x + "]"; }
`;
const actionsId = join(dir, "actions.mjs");

const makePlugin = (opts: TierlessPluginOptions): TierlessPlugin => tierless({
  api: "api.server.mjs",
  runtime: pathToFileURL(join(SRC_DIR, "browser.mjs")).href,      // resolvable without node_modules
  ...opts,
});
const fakeVite = async (plugin: TierlessPlugin) => {
  const httpServer = http.createServer((_q, r) => { r.writeHead(404); r.end(); });
  await new Promise<void>((r) => httpServer.listen(0, () => r()));
  await plugin.configureServer({ httpServer, config: { root: dir }, ssrLoadModule: (id: string) => import(pathToFileURL(id).href) });
  const addr = httpServer.address();
  return { httpServer, port: addr && typeof addr === "object" ? addr.port : 0 };
};

console.log("Probe: the Vite plugin — \"use tierless\" modules become monitor-backed actions, headless\n");

// ---- transform hook --------------------------------------------------------------------
const plugin = makePlugin({ login: { user: "ana", pass: "demo" } });
check("non-tierless modules are untouched", (await plugin.transform("export const x = 1;", "/app/x.mjs")) === null);
const out = await plugin.transform(ACTIONS, actionsId);
check("a \"use tierless\" module compiles to a machine + bound action exports",
  out !== null && out.code.includes("export const PROGRAMS") && out.code.includes("export const rebalance = __actions[\"rebalance\"]"), out && out.code.slice(0, 80));
check("pure exports pass through still exported", out!.code.includes("export function fmt"));
check("the module id is stamped for server-side resolution", out!.code.includes(JSON.stringify(actionsId)));

// ---- a "use tierless" module authored in TypeScript (dev-mode entry point for .src.ts) -----
const TS_ACTIONS = `"use tierless";
interface Quote { sym: string; price: number }
export function priceCheck(sym: string): Quote {
  const price = api.getQuote(sym) as number;
  return { sym, price };
}
`;
const tsOut = await plugin.transform(TS_ACTIONS, join(dir, "actions.ts"));
check("a \"use tierless\" .ts module strips types and compiles (Vite dev-mode entry point)",
  tsOut !== null && tsOut.code.includes("export const PROGRAMS") && tsOut.code.includes("export const priceCheck = __actions[\"priceCheck\"]"), tsOut && tsOut.code.slice(0, 80));
check("the compiled output carries no leftover TS syntax", tsOut !== null && !/:\s*(string|number)\b/.test(tsOut.code) && !tsOut.code.includes("interface Quote"));
writeFileSync(actionsId, out!.code);

// ---- end to end: page-side call -> vite endpoint -> ssr module -> sidecar --------------
{
  const { httpServer, port } = await fakeVite(plugin);
  configureTierless({ url: `ws://localhost:${port}${WS_PATH}` });
  // compiler output generated at test time — no static declaration to check against
  const mod: any = await import(pathToFileURL(actionsId).href);
  check("the emitted module's pure export runs in place", mod.fmt("x") === "[x]");
  check("__bundle exposes the machine for the server side", !!(mod.__bundle && mod.__bundle.PROGRAMS.rebalance));

  const v = await mod.rebalance(["abc", "a", "abcd"]);
  check("the action ran on the server through the monitor, principal attached", v === "ana:abc@30,ana:abcd@40", v);
  const both = await Promise.all([mod.rebalance(["abc"]), mod.rebalance(["abcde"])]);
  check("two actions share the page's one socket concurrently", both[0] === "ana:abc@30" && both[1] === "ana:abcde@50", both);
  httpServer.close();
}

// ---- and the boundary still bites: no login -> the write is denied ---------------------
{
  const anon = makePlugin({});                                     // no login: anonymous socket
  const { httpServer, port } = await fakeVite(anon);
  configureTierless({ url: `ws://localhost:${port}${WS_PATH}` });
  // compiler output generated at test time — no static declaration to check against
  const mod: any = await import(pathToFileURL(actionsId).href + "?anon");   // fresh module instance, same file
  const err = await mod.rebalance(["abc"]).then(() => null, (e: any) => String((e && e.message) || e));
  check("an anonymous action's write is denied at the monitor and rejects the call", err === "denied", err);
  httpServer.close();
}

const { pass, fail } = counts();
const ok = fail === 0;
console.log(ok
  ? `\nOK — the Vite plugin turns a "use tierless" module into monitor-backed actions: transform + dev-server endpoint + ssr-loaded machine + sidecar authorization, end to end (${pass} checks)`
  : `\nFAILED (${pass} passed, ${fail} failed)`);
process.exit(ok ? 0 : 1);
