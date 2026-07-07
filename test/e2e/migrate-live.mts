// LIVE §6 migrate arm over a real websocket (docs/migrate-arm.md slice 1): the same
// compiled-method spine as method-live.mts, but the stub opts into MIGRATE — the whole
// continuation ships to the server at the first http.* park, the chain runs there
// against the twin, and the stack comes home only when a segment needs the live
// instance. A framework-style reactive Proxy stands in for the instance: its writes
// must be observed at HOME, after the chain, exactly once.
//
// Run:  node test/e2e/migrate-live.mts
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { wsPort, makePeer, type Port } from "tierless/transport";
import { makeHost } from "tierless";
import { httpResources } from "tierless/adapt";
import { makeCheck } from "../lib/check.mts";

const require = createRequire(import.meta.url);
const { WebSocketServer, WebSocket } = require("ws");
const { compile } = require("../../packages/tierless/src/transform.cjs");
const { check, ok } = makeCheck();

const SRC = `"use tierless";
export class Svc {
  constructor(http) { this.http = http; this.total = 0; this.loading = false; }
  async open(id) {
    this.loading = true;
    try {
      const proj = await this.http.get("/projects/" + id);
      const view = await this.http.get("/projects/" + id + "/views/" + proj.data.view);
      const tasks = await this.http.get("/views/" + view.data.id + "/tasks");
      this.total = Number(tasks.headers["x-total"]);
      return tasks.data;
    } finally {
      this.loading = false;
    }
  }
  async fragile(id) {
    try {
      const a = await this.http.get("/projects/" + id);
      const b = await this.http.get("/boom/" + a.data.view);
      return b.data;
    } catch (e) {
      return "caught: " + e.message;
    }
  }
}`;
const { code } = compile(SRC, { resources: { "this.http": "server" }, filename: "svc.js" });
const dir = mkdtempSync(join(tmpdir(), "tlmglv-"));
writeFileSync(join(dir, "svc.mjs"), code);
const bundle = await import(pathToFileURL(join(dir, "svc.mjs")).href);

// ---- server tier over a REAL websocket --------------------------------------------------
const served: string[] = [];
const twin = {
  get: async (url: string) => {
    served.push(url);
    if (url.startsWith("/boom")) { const e = new Error("Request failed with status code 500") as Error & { isAxiosError: boolean }; e.isAxiosError = true; throw e; }
    if (url.startsWith("/projects/") && url.includes("/views/")) return { data: { id: 42 }, status: 200, statusText: "OK", headers: {} };
    if (url.startsWith("/projects/")) return { data: { view: 7 }, status: 200, statusText: "OK", headers: {} };
    if (url.startsWith("/views/")) return { data: [{ id: 1 }, { id: 2 }, { id: 3 }], status: 200, statusText: "OK", headers: { "x-total": "3" } };
    throw new Error("unknown url " + url);
  },
};
const wss = new WebSocketServer({ port: 0 });
await new Promise<void>((r) => wss.on("listening", r));
wss.on("connection", (sock: unknown) => {
  makeHost({ bundle, tier: "server", exec: httpResources(twin) }).answer(makePeer(wsPort(sock)));
});

// ---- browser tier: count what actually crosses the socket -------------------------------
const ws = new WebSocket(`ws://localhost:${(wss.address() as { port: number }).port}`);
const counts: Record<string, number> = {};
const raw = wsPort(ws);
const counting: Port = {
  ...raw,
  send(obj: unknown, bin?: Uint8Array): void {
    const m = obj as { kind?: string; payload?: { type?: string } };
    if (m.kind === "request" && m.payload?.type) counts[m.payload.type] = (counts[m.payload.type] || 0) + 1;
    raw.send(obj as object, bin);
  },
};
const peer = makePeer(counting);
await new Promise<void>((r, j) => { ws.on("open", r); ws.on("error", j); });
const browser = makeHost({ bundle, tier: "browser", exec: (() => { throw new Error("browser owns no resource"); }) });

// bind the stubs to the MIGRATE arm — the one-line delta from the fetch binding
bundle.__bindTierlessMethods((prog: string, self: unknown, args: unknown[]) =>
  browser.runLocal(peer, prog, [self, ...args], { migrate: () => true }));

console.log("LIVE migrate arm — the chain crosses once, the instance is touched only at home\n");

const writes: string[] = [];
const inst = new Proxy(new bundle.Svc({ marker: "browser-axios" }), {
  set(target, prop, value) { writes.push(String(prop)); return Reflect.set(target, prop, value); },
});

const out = await inst.open(5) as Array<{ id: number }>;
check("the 3-call chain's result comes through the session", Array.isArray(out) && out.length === 3, JSON.stringify(out));
check("every call in the chain was served by the twin, in order", served.join(",") === "/projects/5,/projects/5/views/7,/views/42/tasks", served.join(","));
check("the WHOLE chain crossed as ONE resume — no execs", counts.resume === 1 && !counts.exec, JSON.stringify(counts));
check("instance mutations happened AT HOME on the live proxy (loading on/off, total)", inst.total === 3 && inst.loading === false && writes.join(",") === "loading,total,loading", writes.join(","));

// error mid-chain: unwinds into the compiled catch ON THE SERVER; still one crossing
served.length = 0; for (const k of Object.keys(counts)) delete counts[k];
const caught = await inst.fragile(5);
check("a mid-chain failure unwinds into the compiled catch server-side", caught === "caught: Request failed with status code 500", String(caught));
check("the error path was still one crossing", counts.resume === 1 && !counts.exec, JSON.stringify(counts));

ws.close(); wss.close();
console.log(ok()
  ? "\nPASS — the migrate arm runs live: a chain is one crossing, home segments see the real instance"
  : "\nFAIL");
process.exit(ok() ? 0 : 1);
