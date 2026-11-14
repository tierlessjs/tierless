// Probe: the server emit for COMPILED APP MODULES (docs/migrate-arm.md slice 1). The vite
// transform compiles a configured class file for the browser; writeBundle now also emits a
// MACHINE-ONLY server bundle for it — esbuild-bundled so app-alias imports ('@/…') resolve,
// with the class's construction-time graph (browser-only http factories) left out entirely.
// The gateway resolves it from the same manifest and can RESUME a migrated method: proven
// here end to end — the emitted bundle services a 2-call chain in ONE resume crossing.
import { writeFileSync, mkdtempSync, mkdirSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
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
// PREFIX and deco: top-level module bindings the MACHINE references — they must join
// the server emit's closure (esbuild would otherwise treat them as globals and the
// migrated method dies at runtime)
writeFileSync(svcId, `import {makeHttp} from '@/helpers/factory.mjs'
import {fmt} from '@/helpers/fmt.mjs'
const PREFIX = "/a/"
const deco = (s: string) => "<" + s + ">"
export class Svc {
  constructor(http?: any) { this.http = http || makeHttp(); this.total = 0; }
  http: any
  total: number
  async chain(id: string) {
    const a = await this.http.get(PREFIX + id);
    const b = await this.http.get("/b/" + a.data.next);
    return deco(fmt(b.data.value));
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
check("the emitted machine served the whole chain server-side — top-level const + arrow helper included", value === "<[v:n7]>" && served.join(",") === "/a/7,/b/n7", JSON.stringify({ value, served }));
check("one resume crossing, zero execs", msgCounts.resume === 1 && !msgCounts.exec, JSON.stringify(msgCounts));

// ---- module code by name: the plugin vets each import's graph ------------------------
// A component closure calling an imported helper keeps it a free reference when the
// helper's module can load on the gateway (a plain .mjs). A module that mixes helpers with
// UI code (a .jsx file) never loads there whole — the machine bundle must not carry a
// component tree — but a named export that stands alone is SLICED out of it: its
// declaration with the module-level code it reaches, importing only modules that load
// whole. An export that builds JSX, or reaches module state that is reassigned, stays a
// capture. Verdicts: an esbuild metafile probe of the resolved file, then the slicer.
{
  writeFileSync(join(dir, "src", "helpers", "badge.jsx"), `import { fmt } from './fmt.mjs';
const MARK = "*";
let hits = 0;
export const badge = (s) => MARK + fmt(s);              // stands alone: MARK, and an import that loads whole
export const fancy = (s) => <i>{s}</i>;                 // builds JSX
export const counted = (s) => { hits++; return s; };    // reassigns module state
export function Badge() { return <b>{badge("x")}</b>; } // a component beside the helpers
`);
  const compId = join(dir, "src", "comp.ts");
  writeFileSync(compId, `import { fmt } from '@/helpers/fmt.mjs'
import { badge, fancy, counted } from '@/helpers/badge.jsx'
const KINDS = { fancy };
function kind(s: string) { return KINDS.fancy(s); }   // a module helper over a table of UI imports: must stay a capture
function twice(s: string) { return fmt(fmt(s)); }   // a module helper over a safe import: free
function useClient() { return { client: (globalThis as any).__probeClient }; }
export function Comp() {
  const { client } = useClient();
  const loader = async (n: number) => { const a = await client.scopes.a(n); const s = twice(fmt(a)); const b = await client.scopes.b(badge(s)); return kind(counted(b)); };
  return { loader };
}
`);
  const plugin2: any = tierless({ apiUrl: "http://127.0.0.1:1", compile: ["src/comp.ts"], compilerOptions: { closures: true }, runtime: pathToFileURL(join(SRC_DIR, "browser.mjs")).href });
  plugin2.configResolved({ root: dir, resolve: { alias: [{ find: "@", replacement: join(dir, "src") }] } });
  // Vite's plugin context: resolves the alias, and a relative import against its importer
  const ctx = { resolve: async (spec: string, importer: string) => ({ id: spec.startsWith("@/") ? join(dir, "src", spec.slice(2)) : join(importer, "..", spec) }) };
  const out2 = await plugin2.transform.call(ctx, readFileSync(compId, "utf8"), compId);
  const slots2 = JSON.parse(/__slots = (\{.*?\});/s.exec(out2?.code ?? "")?.[1] ?? "{}")["Comp$loader"] as Record<string, string[]> | undefined;
  const refs2 = new Set(Object.values(slots2 ?? {}).flat());
  check("module code by name: the plain-module helper and a module function over it are free references (no args[0].fmt / args[0].twice ref)",
    !!out2 && !refs2.has("args[0].fmt") && !refs2.has("args[0].twice") && /\btwice\(fmt\(F\.a\)\)/.test(out2.code), [...refs2].join(",") + " | " + (out2?.code.match(/twice\([^;]*\)/)?.[0] ?? "no twice call"));
  check("slices: a standalone export of a UI module is a free reference (no args[0].badge); one that reassigns module state, and a module function over a JSX-building export, stay captures (args[0].counted, args[0].kind)",
    !refs2.has("args[0].badge") && /\bbadge\(F\.s\)/.test(out2?.code ?? "") && refs2.has("args[0].counted") && refs2.has("args[0].kind"), [...refs2].join(","));
  const { tmpdir } = await import("node:os"); const { readdirSync } = await import("node:fs");
  const sliceDir = join(tmpdir(), `tierless-slices-${process.pid}`);
  const sliceFiles = existsSync(sliceDir) ? readdirSync(sliceDir).map((f) => join(sliceDir, f)) : [];
  const sliceText = sliceFiles.length === 1 ? readFileSync(sliceFiles[0], "utf8") : "";
  check("slices: the slice holds badge with what it reaches (MARK, the fmt import by absolute path) and nothing else of the module (no component, no JSX, no other export, no module state)",
    sliceFiles.length === 1 && /const badge = /.test(sliceText) && /const MARK = /.test(sliceText) && sliceText.includes(JSON.stringify(join(dir, "src", "helpers", "fmt.mjs"))) && /export \{ badge \}/.test(sliceText)
      && !/Badge|fancy|counted|hits|<i>|<b>/.test(sliceText.replace(/^\/\/.*$/m, "")), sliceFiles.length + " slice file(s): " + sliceText.slice(0, 400));
  const sliceMod = sliceFiles.length === 1 ? await import(pathToFileURL(sliceFiles[0]).href) : null;
  check("slices: the slice loads in plain Node and runs the same code", sliceMod?.badge("x") === "*[x]", String(sliceMod?.badge?.("x")));
  // the slicer alone (transform.cts sliceModule)
  const { sliceModule } = createRequire(import.meta.url)(join(SRC_DIR, "transform.cjs")) as { sliceModule: (src: string, names: string[], ok: (s: string) => boolean) => { names: string[]; body: string; imports: Array<{ source: string; specifiers: Array<{ imported: string; local: string }> }> } | null };
  const SRC = `import { a as a1, b } from "./dep"; import ui from "./ui";
function inner(x) { return a1(x) + 1; }
const local = (x) => inner(x) * 2;
export { local as doubled };
export const viaUi = (x) => ui(x);
export { b as rex } from "./dep";
export const view = () => <p/>;`;
  const s1 = sliceModule(SRC, ["doubled", "viaUi", "rex", "view", "missing"], (src) => src === "./dep");
  check("slicer: a renamed export slices with its closure (inner, the one import specifier it uses); an export over a refused import, a re-export, a JSX builder and an unknown name do not",
    !!s1 && s1.names.join() === "doubled" && /function inner/.test(s1.body) && /export \{ local as doubled \}/.test(s1.body) && !/viaUi|view|rex/.test(s1.body)
      && JSON.stringify(s1.imports) === JSON.stringify([{ source: "./dep", specifiers: [{ imported: "a", local: "a1" }] }]), JSON.stringify(s1));
  check("slicer: nothing qualifies -> null", sliceModule(SRC, ["view", "viaUi"], () => false) === null);
}

const { pass, fail } = counts();
console.log(fail === 0
  ? `\nOK — vite build emits a machine-only server bundle for compiled app modules; the gateway resumes a migrated chain from it (${pass} checks)`
  : `\n(${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
