// Probe: the server emit for COMPILED APP MODULES (docs/migrate-arm.md slice 1). The vite
// transform compiles a configured class file for the browser; writeBundle now also emits a
// MACHINE-ONLY server bundle for it — esbuild-bundled so app-alias imports ('@/…') resolve,
// with the class's construction-time graph (browser-only http factories) left out entirely.
// The gateway resolves it from the same manifest and can RESUME a migrated method: proven
// here end to end — the emitted bundle services a 2-call chain in ONE resume crossing.
import { writeFileSync, mkdtempSync, mkdirSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import tierless from "tierless/vite";
import { bundleResolverFromManifest } from "tierless/server";
import { makeHost } from "tierless";
import { makePeer, encodeMessage, decodeMessage, type Port } from "tierless/transport";
import { makeCounter } from "../lib/check.mts";

const SRC_DIR = fileURLToPath(new URL("../../packages/tierless/src/", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "vite-build-compile-"));
const { check, counts } = makeCounter();

// the compile branch and the emit both resolve vite/esbuild from the APP root — give
// the fixture app a node_modules that has them: the react-vite example's when it's
// installed (a real vite app's own dependency tree), else the REPO root's (CI installs
// workspaces only; vite is a root devDependency for exactly this probe)
writeFileSync(join(dir, "package.json"), "{}\n");
const EXAMPLE_NM = fileURLToPath(new URL("../../examples/react-vite/node_modules", import.meta.url));
const ROOT_NM = fileURLToPath(new URL("../../node_modules", import.meta.url));
symlinkSync(existsSync(join(EXAMPLE_NM, "vite")) ? EXAMPLE_NM : ROOT_NM, join(dir, "node_modules"));

// ---- the fixture app -------------------------------------------------------------------
mkdirSync(join(dir, "src", "helpers"), { recursive: true });
// browser-only construction-time dependency, marked so the emitted server bundle can be
// asserted free of the class's constructor graph
writeFileSync(join(dir, "src", "helpers", "factory.mjs"), `globalThis.__browserOnlyLoaded = true; export const makeHttp = () => ({});\n`);
// alias-imported helper that MACHINE code references (used after a park -> must be bundled)
writeFileSync(join(dir, "src", "helpers", "fmt.mjs"), `export const fmt = (s) => "[" + s + "]";\n`);
const svcId = join(dir, "src", "svc.ts");
writeFileSync(svcId, `import {makeHttp} from '@/helpers/factory.mjs'
import {fmt} from '@/helpers/fmt.mjs'
export class Svc {
  constructor(http?: any) { this.http = http || makeHttp(); this.total = 0; }
  http: any
  total: number
  async chain(id: string) {
    const a = await this.http.get("/a/" + id);
    const b = await this.http.get("/b/" + a.data.next);
    return fmt(b.data.value);
  }
}
`);

console.log("Probe: server emit for compiled app modules — machine-only, alias-bundled, gateway-resumable\n");

const plugin: any = tierless({ apiUrl: "http://127.0.0.1:1", compile: ["src/svc.ts"], runtime: pathToFileURL(join(SRC_DIR, "browser.mjs")).href });
plugin.configResolved({ root: dir, resolve: { alias: [{ find: "@", replacement: join(dir, "src") }] } });

const out = await plugin.transform(readFileSync(svcId, "utf8"), svcId);
check("the class file compiled and self-binds for the browser", !!out && out.code.includes("__bindTierlessMethods"), out ? "" : "transform returned null");
const browserId = join(dir, "svc.browser.mjs");
// in a real app Vite's resolver handles '@/…' in the BROWSER module; this probe loads it
// in Node, so pre-resolve the alias here (the server bundle keeps the alias — resolving
// it through esbuild at writeBundle is exactly what this probe proves)
writeFileSync(browserId, out!.code.replaceAll("'@/", "'./src/").replaceAll('"@/', '"./src/'));

plugin.writeBundle();

// ---- the emitted machine bundle ---------------------------------------------------------
const manifestPath = join(dir, "dist-tierless", "tierless.manifest.json");
check("writeBundle emits a manifest for the compiled app module", existsSync(manifestPath));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const wireId = Object.keys(manifest.modules).find((k) => k.startsWith("m:"));
check("the manifest keys the machine by the hashed wire id the browser stamps", !!wireId, Object.keys(manifest.modules).join(","));
const emitted = readFileSync(join(dir, "dist-tierless", manifest.modules[wireId!]), "utf8");
check("the machine bundle inlines the alias-imported helper", emitted.includes("\"[\""), emitted.slice(0, 120));
check("the machine bundle leaves the browser-only constructor graph OUT", !emitted.includes("__browserOnlyLoaded"), "");

const resolver = await bundleResolverFromManifest(manifestPath);
const serverBundle: any = await resolver(wireId!);
check("the gateway-resolved bundle carries the machine AND the stop-rule table",
  !!serverBundle.PROGRAMS?.["Svc$chain"] && !!serverBundle.__slots?.["Svc$chain"], Object.keys(serverBundle.PROGRAMS || {}).join(","));

// ---- end to end: the emitted bundle resumes a MIGRATED method --------------------------
const msgCounts: Record<string, number> = {};
const cbs: Array<((obj: unknown, bin: Uint8Array | null) => void) | null> = [null, null];
const mkPort = (me: number, count: boolean): Port => ({
  send(obj: any, bin?: Uint8Array): void {
    if (count && obj.kind === "request" && obj.payload?.type) msgCounts[obj.payload.type] = (msgCounts[obj.payload.type] || 0) + 1;
    const m = decodeMessage(encodeMessage(obj, bin));
    queueMicrotask(() => cbs[1 - me]?.(m.obj, m.bin));
  },
  onMessage(cb): void { cbs[me] = cb; },
  onClose(): void { /* in-process */ },
  close(): void { /* in-process */ },
});
const served: string[] = [];
const twin = async (req: { name: string; args: unknown[] }): Promise<unknown> => {
  const url = String(req.args[0]); served.push(url);
  return url.startsWith("/a/") ? { data: { next: "n" + url.slice(3) } } : { data: { value: "v:" + url.slice(3) } };
};
makeHost({ bundle: serverBundle, tier: "server", exec: twin as never }).answer(makePeer(mkPort(1, false)));

const browserMod: any = await import(pathToFileURL(browserId).href);
const bhost = makeHost({ bundle: { PROGRAMS: browserMod.PROGRAMS, __unwind: browserMod.__unwind }, tier: "browser", exec: (() => { throw new Error("browser owns nothing"); }) });
const value = await bhost.runLocal(makePeer(mkPort(0, true)), "Svc$chain", [{ http: {}, cb: () => {} }, "7"], { migrate: () => true });
check("the emitted machine served the whole chain server-side", value === "[v:n7]" && served.join(",") === "/a/7,/b/n7", JSON.stringify({ value, served }));
check("one resume crossing, zero execs", msgCounts.resume === 1 && !msgCounts.exec, JSON.stringify(msgCounts));

const { pass, fail } = counts();
console.log(fail === 0
  ? `\nOK — vite build emits a machine-only server bundle for compiled app modules; the gateway resumes a migrated chain from it (${pass} checks)`
  : `\n(${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
