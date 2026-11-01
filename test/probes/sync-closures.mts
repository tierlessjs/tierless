// PROBE: a library's sync closure over its instance ships as a VALUE and runs where the
// run is (the i18next experiment, docs/migrate-arm.md "sync closures").
//
// i18next's getFixedT returns `t`, an arrow over `this` (the I18n instance), a key prefix
// and itself. A component captures `t`; a migrated chain that calls it between two
// admin-client calls had to go home, because a native closure's environment can't be
// read. With `syncClosures`, the closure compiles into a program over explicit caps and
// the kept closure is a stub carrying both; the codec ships it (graph.mts "fn"), and the
// far tier calls its own copy of the program over the shipped caps. The instance ships
// like any migrated value: whole under the codec's threshold, else as a handle — in which
// case the stop rule sends the calling segment home. Asserted:
//   - the closure compiles; the module's classes get a tier-independent identity
//   - the stub behaves as the original at home, own props (t.lng) included
//   - shipped through the binary wire to another tier, it translates identically over a
//     rebuilt instance (prototype restored), with no crossing
//   - a migrated chain calling the borrowed t between two twin calls: ONE crossing
//   - a big instance (over the threshold) stays home: the chain still right, the engine
//     parked the calling segment home (two crossings), no crash
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeHost } from "tierless";
import { makePeer, encodeMessage, decodeMessage, type Port } from "tierless/transport";
import { encodeWireBinary, decodeWireBinary } from "tierless/wire";
import { makeTier } from "tierless/heap";
import { makeCheck } from "../lib/check.mts";

const require = createRequire(import.meta.url);
const { compile } = require("../../packages/tierless/src/transform.cjs");
const { check, ok } = makeCheck();

// i18next's shape, reduced: a store, a translator, and getFixedT's closure over `this`
const SRC = `"use tierless";
class Store { constructor(data) { this.data = data; } get(lng, ns, key) { const n = this.data[lng]; return n && n[ns] ? n[ns][key] : undefined; } }
class Translator {
  constructor(store, options) { this.store = store; this.options = options; this.language = options.lng; }
  translate(key, o) {
    const lng = (o && o.lng) || this.language, ns = (o && o.ns) || this.options.defaultNS;
    let res = this.store.get(lng, ns, key);
    if (res === undefined) res = key;
    if (o && o.count !== undefined) res = res.replace("{{count}}", String(o.count));
    return res;
  }
}
export class I18n {
  constructor(options) { this.options = options; this.language = options.lng; this.store = new Store(options.resources); this.translator = new Translator(this.store, options); }
  t(...args) { return this.translator.translate(...args); }
  getFixedT(lng, ns, keyPrefix) {
    const fixedT = (key, opts) => {
      const o = { ...(opts || {}) };
      o.lng = o.lng || fixedT.lng; o.ns = o.ns || fixedT.ns;
      const k = keyPrefix ? keyPrefix + "." + key : key;
      return this.t(k, o);
    };
    fixedT.lng = lng; fixedT.ns = ns; fixedT.keyPrefix = keyPrefix;
    return fixedT;
  }
}
// the component: a chain through a borrowed client, calling the borrowed t between calls
function useClient() { return { client: globalThis.__probeClient }; }
export function Dialog(props) {
  const { client } = useClient();
  const { t } = props;
  async function save(id) {
    const a = await client.scopes.a(id);
    const label = t("label", { count: a });
    return await client.scopes.b(a, label);
  }
  return { save };
}`;
const { code, meta } = compile(SRC, { filename: "i18n.js", closures: true, syncClosures: true });
const ms = meta.methods as Array<{ class: string; method: string; program: string | null; error?: string }>;
check("the sync closure compiles into a program over its caps", ms.some((m) => m.program === "I18n$getFixedT$fixedT"), JSON.stringify(ms));
check("every class in the module gets a tier-independent identity (module hash + name)", /__tlShareClass\("[0-9a-f]+:I18n", I18n\)/.test(code) && /__tlShareClass\("[0-9a-f]+:Store", Store\)/.test(code), "");
check("the stub builds its caps from the live closure: this as __self, the prefix, and itself",
  code.includes("fixedT.__tierless_caps = () => ({") && code.includes("__self: this") && code.includes("keyPrefix })") && code.includes("fixedT.__tierless_sync = true"), "");

// the generated module is imported in place (tierless/graph must resolve for the stamps)
const GEN = fileURLToPath(new URL("../.gen/", import.meta.url));
mkdirSync(GEN, { recursive: true });
writeFileSync(join(GEN, "sync-closures.mjs"), code);
const mod = await import(pathToFileURL(join(GEN, "sync-closures.mjs")).href);
const bundle = { PROGRAMS: mod.PROGRAMS, __unwind: mod.__unwind, __slots: mod.__slots };

const TABLE: Record<string, string> = { hello: "Hello", label: "{{count}} items", "ns.key": "nested" };
const i18n = new mod.I18n({ lng: "en", defaultNS: "master", resources: { en: { master: TABLE } } });
const t = i18n.getFixedT("en", "master");
check("at home the stub behaves as the original, own props included", t("hello") === "Hello" && t("label", { count: 3 }) === "3 items" && t.lng === "en" && t.__tierless_program === "I18n$getFixedT$fixedT", t("hello"));

// ---- ship t to another tier through the binary wire ------------------------------------
{
  const browser = makeTier("browser"), server = makeTier("server");
  const bytes = encodeWireBinary([{ fn: "x", pc: 0, args: [t] }], null, { tier: browser });
  const shost = makeHost({ bundle, tier: "server", exec: (() => { throw new Error("no resources"); }) as never });
  void shost;
  // decode with the server host's program runner: the host threads it into its own decodes;
  // here the probe does the same by hand
  const run = (name: string) => (mod.PROGRAMS[name] ? (caps: unknown, args: unknown[]) => {
    const stack: any[] = [{ fn: name, pc: 0, args: [caps, ...args] }];
    for (;;) { const top = stack[stack.length - 1]; const r = mod.PROGRAMS[top.fn](top);
      if (r.op === "return") { stack.pop(); if (!stack.length) return r.value; stack[stack.length - 1].ret = r.value; }
      else if (r.op === "call") stack.push({ fn: r.fn, pc: 0, args: r.args }); else if (r.op === "check") continue;
      else if (r.op === "throw") throw r.value; else throw new Error("parked " + r.op); }
  } : undefined);
  const [t2] = decodeWireBinary(bytes, { tier: server, programs: run }).stack[0].args as any[];
  check("shipped: a callable stub arrives, own props restored", typeof t2 === "function" && t2 !== t && t2.lng === "en" && t2.__tierless_program === "I18n$getFixedT$fixedT", String(typeof t2));
  const caps = t2.__tierless_caps();
  check("shipped: the instance rebuilt with its prototype (class identity by module), its closure names itself",
    Object.getPrototypeOf(caps.__self) === mod.I18n.prototype && caps.fixedT === t2 && caps.__self !== i18n, "");
  check("shipped: translates identically over there, with no crossing",
    t2("hello") === "Hello" && t2("label", { count: 7 }) === "7 items" && t2("missing") === "missing" && t2("hello", { lng: "en" }) === t("hello", { lng: "en" }), t2("hello"));
  console.log("  (shipped t: " + bytes.length + " wire bytes for a " + Object.keys(TABLE).length + "-key table)");
}

// ---- a migrated chain calls the borrowed t between two twin calls ----------------------
class Client {
  calls = 0; where: string; scopes: Record<string, (...a: any[]) => Promise<unknown>>;
  constructor(where: string, log: string[]) {
    this.where = where;
    this.scopes = {
      a: async (x: number) => { this.calls++; log.push(where + ":a"); return x + 1; },
      b: async (x: number, label: string) => { this.calls++; log.push(where + ":b"); return x * 10 + "/" + label; },
    };
  }
}
(Client.prototype as unknown as { __tierless_cls: string }).__tierless_cls = "Client";
const log: string[] = [];
const counts: Record<string, number> = {};
const connect = (twins?: (cls: string) => object | undefined) => {
  const cbs: Array<((obj: unknown, bin: Uint8Array | null) => void) | null> = [null, null];
  const mkPort = (me: number, count: boolean): Port => ({
    send(obj: any, bin?: Uint8Array): void {
      if (count && obj.kind === "request" && obj.payload?.type) counts[obj.payload.type] = (counts[obj.payload.type] || 0) + 1;
      const m = decodeMessage(encodeMessage(obj, bin));
      queueMicrotask(() => cbs[1 - me]?.(m.obj, m.bin));
    },
    onMessage(cb): void { cbs[me] = cb; }, onClose(): void { /* in-process */ }, close(): void { /* in-process */ },
  });
  makeHost({ bundle: bundle as never, tier: "server", exec: (() => { throw new Error("no resources here"); }) as never, ...(twins ? { twins } : {}) }).answer(makePeer(mkPort(1, false)));
  return makePeer(mkPort(0, true));
};
const twin = new Client("server", log);
const peer = connect((cls) => (cls === "Client" ? twin : undefined));
const bhost = makeHost({ bundle, tier: "browser", exec: (() => { throw new Error("browser owns nothing"); }) as never });
const reset = (): void => { log.length = 0; for (const k of Object.keys(counts)) delete counts[k]; };
const run = async (tt: unknown): Promise<unknown> => {
  (globalThis as Record<string, unknown>).__probeClient = new Client("browser", log);
  mod.__bindTierlessMethods((prog: string, caps: object, args: unknown[]) => bhost.runLocal(peer, prog, [caps, ...args], { migrate: () => true }));
  try { return await mod.Dialog({ t: tt }).save(1); } finally { mod.__bindTierlessMethods(null); }
};
reset();
const r1 = await run(t);
check("migrated chain: t ran on the server between the two twin calls — ONE crossing, right value",
  r1 === "20/2 items" && counts.resume === 1 && log.join() === "server:a,server:b", JSON.stringify({ r1, counts, log }));

// ---- the shipped instance is a twin: a method's write over there lands at home -----------
// (the closure itself can't write — the compiler keeps a writing closure native — but the
// native method it calls can: i18next's missing-key handling, a memo, a counter)
{
  const SRC2 = `"use tierless";
export class Counter { constructor() { this.n = 0; this.seen = []; } bump(k) { this.n++; this.seen.push(k); return this.n; }
  ticker() { const tick = (k) => this.bump(k); return tick; } }
function useClient() { return { client: globalThis.__probeClient }; }
export function Dialog(props) {
  const { client } = useClient();
  const { tick } = props;
  async function save(id) { const a = await client.scopes.a(id); const n = tick("x" + a); return await client.scopes.b(a, String(n)); }
  return { save };
}`;
  const out2 = compile(SRC2, { filename: "counter.js", closures: true, syncClosures: true });
  writeFileSync(join(GEN, "sync-closures-counter.mjs"), out2.code);
  const m2 = await import(pathToFileURL(join(GEN, "sync-closures-counter.mjs")).href);
  const b2 = { PROGRAMS: m2.PROGRAMS, __unwind: m2.__unwind, __slots: m2.__slots };
  const counts2: Record<string, number> = {};
  const cbs2: Array<((obj: unknown, bin: Uint8Array | null) => void) | null> = [null, null];
  const port2 = (me: number): Port => ({
    send(obj: any, bin?: Uint8Array): void { if (me === 0 && obj.kind === "request" && obj.payload?.type) counts2[obj.payload.type] = (counts2[obj.payload.type] || 0) + 1; const m = decodeMessage(encodeMessage(obj, bin)); queueMicrotask(() => cbs2[1 - me]?.(m.obj, m.bin)); },
    onMessage(cb): void { cbs2[me] = cb; }, onClose(): void { /* in-process */ }, close(): void { /* in-process */ },
  });
  const log2: string[] = [];
  makeHost({ bundle: b2 as never, tier: "server", exec: (() => { throw new Error("none"); }) as never, twins: (cls) => (cls === "Client" ? new Client("server", log2) : undefined) }).answer(makePeer(port2(1)));
  const peer2 = makePeer(port2(0));
  const h2 = makeHost({ bundle: b2, tier: "browser", exec: (() => { throw new Error("none"); }) as never });
  const counter = new m2.Counter();
  (globalThis as Record<string, unknown>).__probeClient = new Client("browser", log2);
  m2.__bindTierlessMethods((prog: string, caps: object, args: unknown[]) => h2.runLocal(peer2, prog, [caps, ...args], { migrate: () => true }));
  let r: unknown;
  try { r = await m2.Dialog({ tick: counter.ticker() }).save(1); } finally { m2.__bindTierlessMethods(null); }
  check("the instance's write over there (this.n++, this.seen.push) landed on the home instance; one crossing",
    r === "20/1" && counter.n === 1 && counter.seen.join() === "x2" && counts2.resume === 1 && log2.join() === "server:a,server:b", JSON.stringify({ r, n: counter.n, seen: counter.seen, counts2, log2 }));
}

// ---- a BIG instance: the engine keeps it home and parks the calling segment -------------
const big: Record<string, string> = {};
for (let i = 0; i < 3000; i++) big["k" + i] = "value number " + i + " " + "x".repeat(40);
big.label = "{{count}} big";
const i18nBig = new mod.I18n({ lng: "en", defaultNS: "master", resources: { en: { master: big } } });
reset();
const r2 = await run(i18nBig.getFixedT("en", "master"));
check("big instance (over the threshold): still right, the engine parked the call home and re-migrated after (two crossings)",
  r2 === "20/2 big" && counts.resume === 2 && log.join() === "server:a,server:b", JSON.stringify({ r2, counts, log }));

// ---- the same big instance under a raised threshold: the engine ships the data instead ---
{
  const bytes: number[] = [];
  const cbs3: Array<((obj: unknown, bin: Uint8Array | null) => void) | null> = [null, null];
  const port3 = (me: number): Port => ({
    send(obj: any, bin?: Uint8Array): void { if (me === 0 && obj.kind === "request" && obj.payload?.type === "resume") bytes.push(bin?.length ?? 0); const m = decodeMessage(encodeMessage(obj, bin)); queueMicrotask(() => cbs3[1 - me]?.(m.obj, m.bin)); },
    onMessage(cb): void { cbs3[me] = cb; }, onClose(): void { /* in-process */ }, close(): void { /* in-process */ },
  });
  const log3: string[] = [];
  makeHost({ bundle: bundle as never, tier: "server", exec: (() => { throw new Error("none"); }) as never, twins: (cls) => (cls === "Client" ? new Client("server", log3) : undefined) }).answer(makePeer(port3(1)));
  const peer3 = makePeer(port3(0));
  const h3 = makeHost({ bundle, tier: "browser", exec: (() => { throw new Error("none"); }) as never, threshold: 1 << 20 });
  (globalThis as Record<string, unknown>).__probeClient = new Client("browser", log3);
  mod.__bindTierlessMethods((prog: string, caps: object, args: unknown[]) => h3.runLocal(peer3, prog, [caps, ...args], { migrate: () => true }));
  let r3: unknown;
  try { r3 = await mod.Dialog({ t: i18nBig.getFixedT("en", "master") }).save(1); } finally { mod.__bindTierlessMethods(null); }
  check("the same big instance under a 1 MB threshold ships whole: one crossing, right value", r3 === "20/2 big" && bytes.length === 1 && log3.join() === "server:a,server:b", JSON.stringify({ r3, bytes, log3 }));
  console.log("  (big instance shipped: " + bytes[0] + " wire bytes for " + Object.keys(big).length + " keys — the threshold is the engine's data-or-stack policy)");
}

console.log(`\n${ok() ? "PASS" : "FAIL"} — a library's sync closure ships as a value: compiled over its caps, rebuilt with its class, run where the run is — or kept home by the codec's threshold`);
process.exit(ok() ? 0 : 1);
