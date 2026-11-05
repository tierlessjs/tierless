// PROBE (experiment): the REAL i18next, compiled with syncClosures, its `t` captured by a
// compiled component and called mid-chain on the far tier. Reports what the engine does
// with the real instance — ships it as a value twin, or keeps it home — and why.
//
// Needs the library source and Keycloak's English table (ports/work, gitignored):
//   TIERLESS_I18NEXT=<path to i18next/dist/esm/i18next.js> (default: the admin-ui's copy)
//   TIERLESS_I18N_TABLE=<messages_en.properties>            (default: the admin-ui's)
// Absent, the probe prints SKIP and exits 0.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeHost } from "tierless";
import { makePeer, encodeMessage, decodeMessage, type Port } from "tierless/transport";
import { ContentStore, newPeerView } from "tierless/content";
import { makeCheck } from "../lib/check.mts";

const require = createRequire(import.meta.url);
const { compile } = require("../../packages/tierless/src/transform.cjs");
const { check, ok } = makeCheck();
const KC = fileURLToPath(new URL("../../ports/work/keycloak/src/js/apps/admin-ui/", import.meta.url));
const I18NEXT = process.env.TIERLESS_I18NEXT || join(KC, "node_modules/i18next/dist/esm/i18next.js");
const TABLE = process.env.TIERLESS_I18N_TABLE || join(KC, "maven-resources/theme/keycloak.v2/admin/messages/messages_en.properties");
if (!existsSync(I18NEXT) || !existsSync(TABLE)) { console.log("SKIP — i18next source or table not present (" + I18NEXT + ", " + TABLE + ")"); process.exit(0); }

const GEN = fileURLToPath(new URL("../.gen/", import.meta.url));
mkdirSync(GEN, { recursive: true });
// the library, compiled: every `const f = () => …` in a method becomes a program
const lib = compile('"use tierless";\n' + readFileSync(I18NEXT, "utf8"), { filename: "i18next.js", syncClosures: true, syncCalls: true, syncMethods: true });
writeFileSync(join(GEN, "i18next-compiled.mjs"), lib.code);
const i18next = await import(pathToFileURL(join(GEN, "i18next-compiled.mjs")).href);
const ms = lib.meta.methods as Array<{ class: string; method: string; program: string | null; error?: string }>;
console.log("  library: " + ms.filter((m) => m.program).length + " programs, " + ms.filter((m) => !m.program).length + " refused: " + [...new Set(ms.filter((m) => !m.program).map((m) => (m.error ?? "").replace(/^tierless: \S+ /, "").slice(0, 60)))].slice(0, 8).join(" | "));
check("getFixedT's closure compiles (" + ms.filter((m) => m.program).length + " closures compiled, " + ms.filter((m) => !m.program).length + " kept native)", ms.some((m) => m.program === "I18n$getFixedT$fixedT"), JSON.stringify(ms.filter((m) => !m.program)));

// Keycloak's table and init options (src/i18n/i18n.ts)
const table: Record<string, string> = {};
for (const raw of readFileSync(TABLE, "utf8").split("\n")) {
  const line = raw.trim(); if (!line || line.startsWith("#")) continue;
  const i = line.indexOf("="); if (i < 0) continue;
  table[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/\\n/g, "\n");
}
const keys = Object.keys(table);
const opts = { lng: "en", fallbackLng: "en", keySeparator: ".", nsSeparator: false, interpolation: { escapeValue: false }, defaultNS: ["master"], ns: ["master"], resources: { en: { master: table } } };
const i18n = i18next.createInstance(opts); await i18n.init();
const t = i18n.getFixedT("en", "master");
check("the real t is a compiled stub over caps {__self, fixedT, keyPrefix}", t.__tierless_sync === true && Object.keys(t.__tierless_caps()).sort().join() === "__self,fixedT,keyPrefix", JSON.stringify(Object.keys(t.__tierless_caps())));
const home = keys.map((k) => t(k));
// the chain's keys ride as a frame argument (a caps array would be a member handle and
// park the chain home by itself); a 100-key sample stays under the default threshold
const sample = keys.filter((_, i) => i % Math.ceil(keys.length / 100) === 0);
const homeSample = sample.map((k) => t(k));

// the component: translate every key between two borrowed-client calls
const comp = compile(`"use tierless";
function useClient() { return { client: globalThis.__probeClient }; }
export function Dialog(props) {
  const { client } = useClient();
  const { t } = props;
  async function save(id, keys) {
    const a = await client.scopes.a(id);
    const labels = [];
    for (const k of keys) labels.push(t(k));
    await client.scopes.b(a, labels.length);
    return labels;
  }
  return { save };
}`, { filename: "dialog.js", closures: true, syncCalls: true });
writeFileSync(join(GEN, "i18next-dialog.mjs"), comp.code);
const dlg = await import(pathToFileURL(join(GEN, "i18next-dialog.mjs")).href);
const bundle = {
  PROGRAMS: { ...i18next.PROGRAMS, ...dlg.PROGRAMS },
  __unwind: (stack: unknown, err: unknown) => i18next.__unwind(stack, err) || dlg.__unwind(stack, err),
  __slots: { ...i18next.__slots, ...dlg.__slots },
};
class Client {
  scopes: Record<string, (...a: any[]) => Promise<unknown>>;
  constructor(where: string, log: string[]) {
    this.scopes = { a: async (x: number) => { log.push(where + ":a"); return x + 1; }, b: async (x: number, n: number) => { log.push(where + ":b"); return x * 10 + n; } };
  }
}
(Client.prototype as unknown as { __tierless_cls: string }).__tierless_cls = "Client";

// one connection (a socket's two hosts, each with its views-by-content pair), on which the
// dialog can run more than once: crossings and shipped bytes are counted per run
type Run = { labels: string[]; resumes: number; bytes: number; log: string[] };
const connect = (threshold?: number): { save: (keys: string[]) => Promise<Run> } => {
  const log: string[] = []; let resumes = 0, bytes = 0;
  const cbs: Array<((obj: unknown, bin: Uint8Array | null) => void) | null> = [null, null];
  const mkPort = (me: number): Port => ({
    send(obj: any, bin?: Uint8Array): void {
      if (me === 0 && obj.kind === "request" && obj.payload?.type === "resume") { resumes++; bytes += bin?.length ?? 0; }
      const m = decodeMessage(encodeMessage(obj, bin)); queueMicrotask(() => cbs[1 - me]?.(m.obj, m.bin));
    },
    onMessage(cb): void { cbs[me] = cb; }, onClose(): void { /* in-process */ }, close(): void { /* in-process */ },
  });
  const content = (): { store: ContentStore; peer: ContentStore } => ({ store: new ContentStore(), peer: newPeerView() });
  const twin = new Client("server", log);
  makeHost({ bundle: bundle as never, tier: "server", exec: (() => { throw new Error("none"); }) as never, twins: (cls) => (cls === "Client" ? twin : undefined), content: content() }).answer(makePeer(mkPort(1)));
  const peer = makePeer(mkPort(0));
  const bhost = makeHost({ bundle: bundle as never, tier: "browser", exec: (() => { throw new Error("none"); }) as never, ...(threshold ? { threshold } : {}), content: content() });
  (globalThis as Record<string, unknown>).__probeClient = new Client("browser", log);
  return { save: async (keys) => {
    resumes = 0; bytes = 0; log.length = 0;
    dlg.__bindTierlessMethods((prog: string, caps: object, args: unknown[]) => bhost.runLocal(peer, prog, [caps, ...args], { migrate: () => true }));
    try { return { labels: await dlg.Dialog({ t }).save(1, keys) as string[], resumes, bytes, log: [...log] }; } finally { dlg.__bindTierlessMethods(null); }
  } };
};
const run = (threshold?: number): Promise<Run> => connect(threshold).save(sample);

const r1 = await run();
check("default threshold: every sampled key translates right", r1.labels.length === sample.length && r1.labels.every((l, i) => l === homeSample[i]), r1.labels.length + " labels");
console.log(`  default threshold (8 KB): ${r1.resumes} crossing(s), ${r1.bytes} B shipped, calls ran ${r1.log.join(",")}`);
const c2 = connect(1 << 22);
const r2 = await c2.save(sample);
check("4 MB threshold: every sampled key translates right", r2.labels.length === sample.length && r2.labels.every((l, i) => l === homeSample[i]), r2.labels.length + " labels");
// the instance is behavior AND data: under the default threshold its 337 KB table is a
// member handle, so t() parks home between the two calls (two crossings); with the table
// inside the view the whole chain — both calls, both t() — runs on the gateway (one crossing)
check("default threshold: the table stays home, t() parks home between the calls (two crossings)", r1.resumes === 2, String(r1.resumes));
check("4 MB threshold: t() runs on the gateway over the instance's view — one crossing", r2.resumes === 1, String(r2.resumes));
check("4 MB threshold: the crossing carries the table once (under 400 KB)", r2.bytes < 400 * 1024, r2.bytes + " B");
check("home translates all " + keys.length + " keys through the compiled stub exactly as the native closure would", home.length === keys.length && home.every((l, i) => l === i18n.t(keys[i], { lng: "en", ns: "master" })), "");
console.log(`  4 MB threshold: ${r2.resumes} crossing(s), ${r2.bytes} B shipped, calls ran ${r2.log.join(",")}`);

// VIEWS BY CONTENT (graph.mts viewOf): the gateway holds the table from the first run, so a
// second run on the same connection ships the instance's view with the table named by its
// hash — one crossing still, a few KB instead of 338. A change to the table at home is a
// new hash: it ships once more, then by hash again.
const r3 = await c2.save(sample);
check("4 MB threshold, second run on the connection: one crossing, the table by hash (under 24 KB shipped)", r3.resumes === 1 && r3.bytes < 24 * 1024, r3.resumes + " crossing(s), " + r3.bytes + " B");
check("…and every sampled key still translates right on the gateway", r3.labels.length === sample.length && r3.labels.every((l, i) => l === homeSample[i]), r3.labels.length + " labels");
i18n.addResource("en", "master", "probeAdded", "added at home after the first runs");
const r4 = await c2.save([...sample, "probeAdded"]);
check("the table changed at home: shipped once more (over 300 KB), the new key translates on the gateway", r4.resumes === 1 && r4.bytes > 300 * 1024 && r4.labels[r4.labels.length - 1] === "added at home after the first runs", r4.bytes + " B, last label " + JSON.stringify(r4.labels[r4.labels.length - 1]));
const r5 = await c2.save(sample);
check("…then by hash again", r5.resumes === 1 && r5.bytes < 24 * 1024, r5.bytes + " B");
console.log(`  4 MB threshold, same connection: run 2 ${r3.bytes} B, after addResource ${r4.bytes} B, run 4 ${r5.bytes} B`);

// why: what the instance holds that is BEHAVIOR (a function the copy can't carry), by kind
{
  const inst = t.__tierless_caps().__self;
  const protoFns = new Set<string>();
  for (const k of Object.getOwnPropertyNames(Object.getPrototypeOf(inst))) if (typeof inst[k] === "function") protoFns.add(k);
  const seen = new Set<unknown>(); const kinds: Record<string, string[]> = {};
  const walk = (v: unknown, path: string): void => {
    if (v === null || (typeof v !== "object" && typeof v !== "function") || seen.has(v)) return;
    seen.add(v);
    if (typeof v === "function") {
      const own = path.split(".").pop()!;
      const kind = path.split(".").length === 2 && protoFns.has(own) ? "bound prototype method (bindMemberFunctions)" : (v as Function).name && !(v as Function).name.startsWith("bound ") && /^[a-z]/.test((v as Function).name) ? "closure or object-literal method" : "other";
      (kinds[kind] ??= []).push(path); return;
    }
    if (v instanceof RegExp) return;
    for (const [k, x] of Object.entries(v as object)) walk(x, path + "." + k);
  };
  walk(inst, "i18n");
  console.log("  the instance holds " + Object.values(kinds).reduce((n, a) => n + a.length, 0) + " function values the copy would need:");
  for (const [k, paths] of Object.entries(kinds)) console.log(`    ${paths.length} ${k}: ${paths.slice(0, 4).join(" ")}${paths.length > 4 ? " …" : ""}`);
}
console.log(`\n${ok() ? "PASS" : "FAIL"} — real i18next: correct either way; one crossing once the table fits the view`);
process.exit(ok() ? 0 : 1);
