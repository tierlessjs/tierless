// Probe: compile:"auto" — eligibility as a build feature, not a hand-curated list.
// Candidacy is a cheap truthful prefilter (the two forms the compiler carries:
// top-level classes, Pinia setup stores); INCLUSION is the compiler's own verdict
// (at least one method compiled). Sound by construction: an uncompiled candidate runs
// stock, a broken candidate runs stock (recorded, never a build break), mix modules
// keep their own path — and the build emits a coverage artifact so a port commits
// EVIDENCE of its compile surface instead of a curated list.
//
// Run:  node test/probes/vite-auto-compile.mts
import { writeFileSync, mkdtempSync, mkdirSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import tierless from "tierless/vite";
import { makeCounter } from "../lib/check.mts";

const SRC_DIR = fileURLToPath(new URL("../../packages/tierless/src/", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "vite-auto-compile-"));
const { check, counts } = makeCounter();

writeFileSync(join(dir, "package.json"), "{}\n");
const EXAMPLE_NM = fileURLToPath(new URL("../../examples/react-vite/node_modules", import.meta.url));
const ROOT_NM = fileURLToPath(new URL("../../node_modules", import.meta.url));
symlinkSync(existsSync(join(EXAMPLE_NM, "vite")) ? EXAMPLE_NM : ROOT_NM, join(dir, "node_modules"));

// ---- the fixture app: one of each kind ---------------------------------------------------
mkdirSync(join(dir, "src"), { recursive: true });
const F = (name: string, code: string): string => { const p = join(dir, "src", name); writeFileSync(p, code); return p; };
const svc = F("svc.ts", `export class Svc {
  http: any
  constructor(http: any) { this.http = http }
  async load(id: string) { const r = await this.http.get("/items/" + id); return r.data }
  syncOnly() { return 1 }
}
`);
const store = F("store.ts", `import {defineStore} from 'pinia-ish'
const svc = { get: async (p: string) => ({data: p}) }
export const useTasks = defineStore('tasks', () => {
  async function load(id: string) { const t = await svc.get('/t/' + id); return t.data }
  function pure() { return 2 }
  return { load, pure }
})
`);
const decoy = F("decoy.ts", `export class Plain {
  n = 0
  bump() { this.n++ }
}
`);
const ui = F("ui.ts", `export const useThing = () => ({ visible: true })
`);
const mix = F("wf.js", `"use tierless";
export function flow(id) { const a = api.get("/x/" + id); return a; }
`);

console.log('Probe: compile:"auto" — the compiler is the judge, the build emits the evidence\n');

const plugin: any = tierless({ apiUrl: "http://127.0.0.1:1", compile: "auto", resources: { api: "server" }, runtime: pathToFileURL(join(SRC_DIR, "browser.mjs")).href });
plugin.configResolved({ root: dir, resolve: { alias: [] } });
plugin.buildStart();

const t = (p: string): Promise<{ code: string } | null> => plugin.transform.call({ warn() {} }, readFileSync(p, "utf8"), p);
const svcOut = await t(svc);
check("a class with tier calls auto-compiles (PROGRAMS + method binder in the browser module)", !!svcOut && svcOut.code.includes("Svc$load") && svcOut.code.includes("__tlBindMethods"));
check("its uncompilable sibling stubs gracefully (kept class, per-method report)", !!svcOut && svcOut.code.includes("syncOnly"));
const storeOut = await t(store);
check("a Pinia setup store auto-compiles its awaited-member-call action", !!storeOut && storeOut.code.includes("tasks$load"));
check("a class with no tier calls is a candidate but does NOT transform (the compiler said no)", (await t(decoy)) === null);
check("a plain composable is not even a candidate", (await t(ui)) === null);
const mixOut = await t(mix);
check('a "use tierless" mix module keeps its own path (actions, not method binding)', !!mixOut && mixOut.code.includes("__tierlessActions"));

plugin.writeBundle();
const cov = JSON.parse(readFileSync(join(dir, "dist-tierless", "tierless.compile-coverage.json"), "utf8"));
check("coverage artifact: mode auto, per-module verdicts with the compiler's reasons", cov.mode === "auto" && cov.perModule["src/svc.ts"]?.compiled === true && cov.perModule["src/store.ts"]?.compiled === true && cov.perModule["src/decoy.ts"]?.compiled === false);
check("coverage artifact: program counts match what transformed", cov.compiledModules === 2 && cov.compiledPrograms >= 2, JSON.stringify({ m: cov.compiledModules, p: cov.compiledPrograms }));

const { pass, fail } = counts();
console.log(fail === 0
  ? `OK — compile:"auto" makes eligibility a build feature: the compiler judges every candidate form, non-candidates and refusals run stock, mix modules are untouched, and the coverage artifact is the committed evidence (${pass} checks)`
  : `FAIL (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
