// LIVE compiled class methods over a real websocket — the native-port runtime spine
// (ports/vikunja/COMPILING.md "runtime wiring"):
//
//   browser side: a class instance (imagine a shallowReactive service) calls its own
//   method; the stub routes into host.runLocal — the frame, holding the LIVE instance,
//   never leaves the browser. Parks at `this.http.get(...)` cross as (name, args) only;
//   the server's httpResources twin answers; the method's suffix — header reads,
//   instance mutations, the arrow over `this` — resumes in the browser ON THE REAL
//   OBJECT. A failed fetch unwinds into the compiled method's own try/catch.
//
// Run:  node test/e2e/method-live.mts
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { wsPort, makePeer } from "tierless/transport";
import { makeHost } from "tierless";
import { httpResources } from "tierless/adapt";
import { makeCheck } from "../lib/check.mts";

const require = createRequire(import.meta.url);
const { WebSocketServer, WebSocket } = require("ws");
const { compile } = require("../../packages/tierless/src/transform.cjs");
const { check, ok } = makeCheck();

// ---- compile a service class shaped like the real target (AbstractService) -------------
const SRC = `"use tierless";
export class Svc {
  constructor(http) { this.http = http; this.paths = { getAll: "/things" }; this.totalPages = 0; this.done = false; }
  tag(x) { return { ...x, tagged: true }; }
  async getAll(params = {}) {
    params.page = params.page || 1;
    try {
      const response = await this.http.get(this.paths.getAll, { params });
      this.totalPages = Number(response.headers["x-total"]);
      return response.data.map((e) => this.tag(e));
    } finally {
      this.done = true;
    }
  }
  async fragile() {
    try {
      const r = await this.http.get("/boom", {});
      return r.data;
    } catch (e) {
      return "caught: " + e.message;
    }
  }
}`;
const { code } = compile(SRC, { resources: { "this.http": "server" }, filename: "svc.js" });
const dir = mkdtempSync(join(tmpdir(), "tlml-"));
writeFileSync(join(dir, "svc.mjs"), code);
const bundle = await import(pathToFileURL(join(dir, "svc.mjs")).href);

// ---- server tier: the twin instance answering http.* over localhost-in-spirit ----------
const served: Array<{ url: string; cfg: unknown }> = [];
const twin = {
  get: async (url: string, cfg: unknown) => {
    served.push({ url, cfg });
    if (url === "/boom") { const e = new Error("Request failed with status code 500") as Error & { isAxiosError: boolean }; e.isAxiosError = true; throw e; }
    return { data: [{ id: 1 }, { id: 2 }], status: 200, statusText: "OK", headers: { "x-total": "3" } };
  },
};
const wss = new WebSocketServer({ port: 0 });
await new Promise<void>((r) => wss.on("listening", r));
wss.on("connection", (sock: unknown) => {
  makeHost({ bundle, tier: "server", exec: httpResources(twin) }).answer(makePeer(wsPort(sock)));
});

// ---- browser tier: live instance, method host over the session -------------------------
const ws = new WebSocket(`ws://localhost:${(wss.address() as { port: number }).port}`);
const peer = makePeer(wsPort(ws));
await new Promise<void>((r, j) => { ws.on("open", r); ws.on("error", j); });
const browser = makeHost({ bundle, tier: "browser", exec: (() => { throw new Error("browser owns no resource"); }) });

console.log("LIVE compiled class methods — the frame stays with the live instance, resources fetch\n");

// wire the compiled stubs to the fetch path, exactly as tierless/browser bindMethods does
bundle.__bindTierlessMethods((prog: string, self: unknown, args: unknown[]) => browser.runLocal(peer, prog, [self, ...args]));

// a "reactive" stand-in: a Proxy that counts writes, like a framework proxy would observe
const writes: string[] = [];
const inst = new Proxy(new bundle.Svc({ get: async () => { throw new Error("stub must not use the browser axios when bound"); } }), {
  set(target, prop, value) { writes.push(String(prop)); return Reflect.set(target, prop, value); },
});

const out = await inst.getAll({ page: 5 }) as Array<{ id: number; tagged: boolean }>;
check("the method's result comes through the session", out.length === 2 && out.every((x) => x.tagged), out);
check("the server twin answered http.get with the frame's live arguments", served.length === 1 && served[0].url === "/things" && JSON.stringify(served[0].cfg) === '{"params":{"page":5}}', JSON.stringify(served));
check("suffix ran in the BROWSER on the real object (mutations observed by the proxy)", inst.totalPages === 3 && inst.done === true && writes.includes("totalPages") && writes.includes("done"), writes);

// error path: the fetch failure unwinds into the compiled catch
const caught = await inst.fragile();
check("a failed fetch unwinds into the compiled method's own try/catch", caught === "caught: Request failed with status code 500", caught);
check("finally ran on the happy path too (done set before return)", inst.done === true);

// unbound parity: a second module instance falls back to the original method wholesale
const bundle2 = await import(pathToFileURL(join(dir, "svc.mjs")).href + "?fresh");
const inst2 = new bundle2.Svc({ get: async (url: string) => ({ data: [{ id: 9 }], status: 200, statusText: "OK", headers: { "x-total": "1" } }) });
const out2 = await inst2.getAll() as Array<{ tagged: boolean }>;
check("unbound module: the untouched original runs against the instance's own http", out2.length === 1 && out2[0].tagged && inst2.totalPages === 1);

ws.close(); wss.close();
console.log(ok()
  ? "\nPASS — compiled methods run live: frame and instance stay put, resources fetch, errors unwind, unbound falls back"
  : "\nFAIL");
process.exit(ok() ? 0 : 1);
