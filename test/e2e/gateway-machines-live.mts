// LIVE: `tierless gateway --machines <dist-tierless>` hosts a build's compiled machines.
// The vite plugin emits a machine-only server bundle + manifest for a compiled app class
// (the vite-build-compile fixture); the CLI gateway — until now exec-only — must resolve
// that module by its wire id and RESUME a migrated method: a 2-call chain ships once and
// both http.* calls run gateway-side against the backend. This is the seam a port whose
// pages are NOT served by vite preview (NocoDB: nuxt statics from the app's own backend)
// needs before any compiled surface can run there.
import { writeFileSync, mkdtempSync, mkdirSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import tierless from "tierless/vite";
import { makeHost } from "tierless";
import { makePeer, wsPort } from "tierless/transport";
import { makeCheck } from "../lib/check.mts";

const { WebSocket } = createRequire(import.meta.url)("ws");
const SRC_DIR = fileURLToPath(new URL("../../packages/tierless/src/", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "gw-machines-"));
const { check, ok } = makeCheck();

// ---- fixture app: one compiled class whose chain makes two http.* calls ----------------
writeFileSync(join(dir, "package.json"), "{}\n");
const EXAMPLE_NM = fileURLToPath(new URL("../../examples/react-vite/node_modules", import.meta.url));
const ROOT_NM = fileURLToPath(new URL("../../node_modules", import.meta.url));
symlinkSync(existsSync(join(EXAMPLE_NM, "vite")) ? EXAMPLE_NM : ROOT_NM, join(dir, "node_modules"));
mkdirSync(join(dir, "src"), { recursive: true });
const svcId = join(dir, "src", "svc.ts");
writeFileSync(svcId, `export class Svc {
  constructor(http?: any) { this.http = http; this.total = 0; }
  http: any
  total: number
  async chain(id: string) {
    const a = await this.http.get("/a/" + id);
    const b = await this.http.get("/b/" + a.data.next);
    this.total = 42;
    return "got:" + b.data.value;
  }
}
`);
const plugin: any = tierless({ apiUrl: "http://127.0.0.1:1", compile: ["src/svc.ts"], runtime: pathToFileURL(join(SRC_DIR, "browser.mjs")).href });
plugin.configResolved({ root: dir, resolve: { alias: [] } });
const out = await plugin.transform(readFileSync(svcId, "utf8"), svcId);
check("fixture class compiled", !!out && out.code.includes("__bindTierlessMethods"));
plugin.writeBundle();
const manifest = JSON.parse(readFileSync(join(dir, "dist-tierless", "tierless.manifest.json"), "utf8")) as { modules: Record<string, string> };
const wireId = Object.keys(manifest.modules).find((k) => k.startsWith("m:"))!;
check("manifest carries the machine wire id", !!wireId, Object.keys(manifest.modules).join(","));

// ---- mock backend: reachable only from the gateway --------------------------------------
const served: string[] = [];
const backend = createServer((req, res) => {
  served.push(req.url || "");
  res.setHeader("content-type", "application/json");
  if (req.url!.startsWith("/a/")) res.end(JSON.stringify({ next: "n" + req.url!.slice(3) }));
  else if (req.url!.startsWith("/b/")) res.end(JSON.stringify({ value: req.url!.slice(3) }));
  else { res.statusCode = 404; res.end("{}"); }
});
await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
const backendPort = (backend.address() as { port: number }).port;

// ---- the CLI gateway, machines on --------------------------------------------------------
const BIN = fileURLToPath(new URL("../../packages/tierless/bin/tierless.mjs", import.meta.url));
const gw: ChildProcess = spawn(process.execPath, [BIN, "gateway", "--backend", `http://127.0.0.1:${backendPort}`, "--port", "0", "--machines", join(dir, "dist-tierless")], { stdio: ["ignore", "pipe", "inherit"] });
const gwPort = await new Promise<number>((resolve, reject) => {
  let buf = "";
  gw.stdout!.on("data", (c) => { buf += String(c); const m = buf.match(/tierless gateway 127\.0\.0\.1:(\d+)/); if (m) resolve(Number(m[1])); });
  gw.on("exit", (code) => reject(new Error("gateway died: " + code + " " + buf)));
  setTimeout(() => reject(new Error("gateway boot timeout: " + buf)), 15000);
});
check("CLI gateway with --machines boots and prints its port", gwPort > 0, String(gwPort));

// ---- browser tier: run the compiled chain, MIGRATE it to the gateway ---------------------
const browserId = join(dir, "svc.browser.mjs");
writeFileSync(browserId, out!.code);
const mod = await import(pathToFileURL(browserId).href) as { Svc: new (http?: unknown) => { total: number }; __bundle: never };
const ws = new WebSocket(`ws://127.0.0.1:${gwPort}/__tierless`);
await new Promise<void>((r, j) => { ws.on("open", r); ws.on("error", j); });
const peer = makePeer(wsPort(ws as never));
const browser = makeHost({ bundle: mod.__bundle, tier: "browser", meta: { module: wireId }, exec: (() => { throw new Error("browser owns no resource"); }) as never });

const self = new mod.Svc({});
const v = await browser.runLocal(peer, "Svc$chain", [self, "7"], { migrate: () => true });
check("migrated chain returns through the gateway-hosted machine", v === "got:n7", String(v));
check("BOTH chain calls executed gateway-side against the backend", served.join(",") === "/a/7,/b/n7", served.join(","));
check("the stop rule brought the self-write home to the live instance", self.total === 42, String(self.total));

ws.close(); gw.kill(); backend.close();
console.log(ok() ? "\nPASS — the CLI gateway hosts compiled machines from a build manifest" : "\nFAIL");
process.exit(ok() ? 0 : 1);
