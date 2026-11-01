// PROBE: a borrowed library instance is READABLE off its home tier, and only behavior parks.
//
// A component captures a library object (an i18n instance, say): class instance, data
// fields, a getter, a method, a listener, an array. A migrated chain that reads its data
// between two twin calls stays on the gateway (one crossing); one that touches what the
// view can't carry — a prototype getter, a method call, a write, passing the object to a
// native function, anything over the byte budget — goes home for that segment and is
// still right (two crossings). The compiler records what each segment reads (docs/
// migrate-arm.md "the pump rule"), the codec ships a VIEW of the instance (graph.mts), and
// the pump's stop rule decides per segment. Cases:
//   - named reads of nested data (lib.opts.sep)                        -> stays
//   - a computed read moved into a local (const v = lib.data[a][b][k]) -> stays
//   - an array element read (lib.list[1]), the length                  -> stays
//   - a prototype getter (lib.size)                                    -> home, right value
//   - a method call (lib.get(k))                                       -> home, right value
//   - a write (lib.opts.sep = x), an array push                        -> home, the live object changed
//   - the object passed to a native helper                             -> home
//   - an element write through a computed key (lib.data[a] = …)        -> home, live object changed
//   - the instance over the byte budget (threshold 64)                 -> home (a member handle)
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeHost } from "tierless";
import { makePeer, encodeMessage, decodeMessage, type Port } from "tierless/transport";
import { shareClass } from "tierless/graph";
import { makeCheck } from "../lib/check.mts";

const require = createRequire(import.meta.url);
const { compile } = require("../../packages/tierless/src/transform.cjs");
const { check, ok } = makeCheck();

const SRC = `"use tierless";
function useClient() { return { client: globalThis.__probeClient }; }
function helper(o) { o.touched = true; return Object.keys(o).length; }
export function Dialog(props) {
  const { client } = useClient();
  const { lib } = props;
  async function readNamed(id) { const a = await client.scopes.a(id); const sep = lib.opts.sep; return await client.scopes.b(a, sep); }
  async function readComputed(id, lng, ns, k) { const a = await client.scopes.a(id); const v = lib.data[lng][ns][k]; return await client.scopes.b(a, v); }
  async function readArray(id) { const a = await client.scopes.a(id); const x = lib.list[1]; const n = lib.list.length; return await client.scopes.b(a, x + ":" + n); }
  async function readGetter(id) { const a = await client.scopes.a(id); const n = lib.size; return await client.scopes.b(a, n); }
  async function callMethod(id) { const a = await client.scopes.a(id); const r = lib.get("k"); return await client.scopes.b(a, r); }
  async function write(id) { const a = await client.scopes.a(id); lib.opts.sep = "-"; return await client.scopes.b(a, lib.opts.sep); }
  async function push(id) { const a = await client.scopes.a(id); lib.list.push(9); return await client.scopes.b(a, lib.list.length); }
  async function pass(id) { const a = await client.scopes.a(id); const n = helper(lib.opts); return await client.scopes.b(a, n); }
  async function writeComputed(id, lng) { const a = await client.scopes.a(id); lib.data[lng] = { ns: { k: "w" } }; return await client.scopes.b(a, lib.data[lng].ns.k); }
  return { readNamed, readComputed, readArray, readGetter, callMethod, write, push, pass, writeComputed };
}`;
const { code, meta } = compile(SRC, { filename: "views.js", closures: true });
const GEN = fileURLToPath(new URL("../.gen/", import.meta.url));
mkdirSync(GEN, { recursive: true });
writeFileSync(join(GEN, "views.mjs"), code);
const mod = await import(pathToFileURL(join(GEN, "views.mjs")).href);
const bundle = { PROGRAMS: mod.PROGRAMS, __unwind: mod.__unwind, __slots: mod.__slots };
check("the nine chains compiled", (meta.methods as Array<{ program: string | null }>).filter((m) => m.program).length === 9, JSON.stringify(meta.methods));
const refsAt = (prog: string): string => JSON.stringify(mod.__slots[prog]);
check("the compiler records the computed read as a move through computed access (\"[]=\") and the named read as a plain chain",
  refsAt("Dialog$readComputed").includes('"args[0].lib.data[]="') && refsAt("Dialog$readNamed").includes('"args[0].lib.opts.sep="'), refsAt("Dialog$readComputed") + " " + refsAt("Dialog$readNamed"));

// the library: a class instance with data, a getter, a method, a listener
class Lib {
  opts = { sep: "." }; data: Record<string, Record<string, Record<string, string>>> = { en: { ns: { k: "v" } } }; list = [1, 2, 3];
  on = (): void => { /* a listener: behavior */ };
  get size(): number { return this.list.length * 10; }
  get(k: string): string { return this.data.en.ns[k] + "!"; }
}
shareClass("probe:Lib", Lib);
class Client {
  scopes: Record<string, (...a: any[]) => Promise<unknown>>;
  constructor(where: string, log: string[]) {
    this.scopes = { a: async (x: number) => { log.push(where + ":a"); return x + 1; }, b: async (x: number, y: unknown) => { log.push(where + ":b"); return x + "/" + String(y); } };
  }
}
(Client.prototype as unknown as { __tierless_cls: string }).__tierless_cls = "Client";

const run = async (fn: string, args: unknown[], lib: Lib, threshold?: number): Promise<{ r: unknown; resumes: number; log: string[] }> => {
  const log: string[] = []; let resumes = 0;
  const cbs: Array<((obj: unknown, bin: Uint8Array | null) => void) | null> = [null, null];
  const mkPort = (me: number): Port => ({
    send(obj: any, bin?: Uint8Array): void { if (me === 0 && obj.kind === "request" && obj.payload?.type === "resume") resumes++; const m = decodeMessage(encodeMessage(obj, bin)); queueMicrotask(() => cbs[1 - me]?.(m.obj, m.bin)); },
    onMessage(cb): void { cbs[me] = cb; }, onClose(): void { /* in-process */ }, close(): void { /* in-process */ },
  });
  const twin = new Client("server", log);
  makeHost({ bundle: bundle as never, tier: "server", exec: (() => { throw new Error("none"); }) as never, twins: (cls) => (cls === "Client" ? twin : undefined) }).answer(makePeer(mkPort(1)));
  const peer = makePeer(mkPort(0));
  const bhost = makeHost({ bundle, tier: "browser", exec: (() => { throw new Error("none"); }) as never, ...(threshold ? { threshold } : {}) });
  (globalThis as Record<string, unknown>).__probeClient = new Client("browser", log);
  mod.__bindTierlessMethods((prog: string, caps: object, a: unknown[]) => bhost.runLocal(peer, prog, [caps, ...a], { migrate: () => true }));
  try { return { r: await mod.Dialog({ lib })[fn](...args), resumes, log }; } finally { mod.__bindTierlessMethods(null); }
};
const stays = async (name: string, fn: string, args: unknown[], want: unknown, lib = new Lib()): Promise<void> => {
  const { r, resumes, log } = await run(fn, args, lib);
  check(`stays: ${name} — one crossing, right value`, r === want && resumes === 1 && log.join() === "server:a,server:b", JSON.stringify({ r, resumes, log }));
};
const home = async (name: string, fn: string, args: unknown[], want: unknown, lib = new Lib(), after?: (l: Lib) => boolean, threshold?: number): Promise<void> => {
  const { r, resumes, log } = await run(fn, args, lib, threshold);
  check(`home: ${name} — two crossings, right value${after ? ", the live object changed" : ""}`, r === want && resumes === 2 && log.join() === "server:a,server:b" && (!after || after(lib)), JSON.stringify({ r, resumes, log }));
};

await stays("a named read of nested data", "readNamed", [1], "2/.");
await stays("a computed read moved into a local", "readComputed", [1, "en", "ns", "k"], "2/v");
await stays("an array element and its length", "readArray", [1], "2/2:3");
await home("a prototype getter", "readGetter", [1], "2/30");
await home("a method call", "callMethod", [1], "2/v!");
await home("a write", "write", [1], "2/-", new Lib(), (l) => l.opts.sep === "-");
await home("an array push", "push", [1], "2/4", new Lib(), (l) => l.list.length === 4 && l.list[3] === 9);
await home("the object passed to a native helper", "pass", [1], "2/2", new Lib(), (l) => (l.opts as { touched?: boolean }).touched === true);
await home("an element write through a computed key", "writeComputed", [1, "fr"], "2/w", new Lib(), (l) => l.data.fr?.ns.k === "w");
await home("the instance over the byte budget (a member handle)", "readNamed", [1], "2/.", new Lib(), undefined, 64);

// ---- sync calls of values: a compiled library runs over the view (syncCalls + syncMethods)
// The library's class compiles with every method as a machine and its sync calls as
// pump-dispatched parks; the component's sync calls too. Then `lib.get(k)` mid-chain runs
// ON THE GATEWAY over the instance's view (reads through the view, under the stop rule),
// a method that touches behavior (`this.on()`, a listener) parks that call home, and a
// shipped closure (`const t = (k) => this.get(k)`) runs there too — no copy of the
// instance anywhere.
{
  const SRC2 = `"use tierless";
export class Lib2 {
  constructor() { this.opts = { sep: "." }; this.data = { en: { ns: { k: "v", j: "w" } } }; this.list = [1, 2, 3]; this.hits = 0; this.on = () => { this.hits++; return "listened"; }; }
  get(k) { const row = this.data.en.ns; const v = row[k]; return this.join(v, this.opts.sep); }
  join(v, sep) { return v + sep + this.list.length; }
  spread(...args) { return this.join?.(...args); }
  each(xs) { const out = []; xs.forEach((x, i) => { if (i > 2) return; out.push(this.join(x, "+")); }); return out.join(",") + "/" + xs.map((x) => x.length).filter((n) => n > 1).some((n) => n > 1); }
  notify(k) { const r = this.on(); return r + ":" + k; }
  fixed() { const t = (k) => this.get(k); return t; }
}
function useClient() { return { client: globalThis.__probeClient }; }
export function Dialog2(props) {
  const { client } = useClient();
  const { lib, t } = props;
  async function viaMethod(id) { const a = await client.scopes.a(id); const r = lib.get("k"); return await client.scopes.b(a, r); }
  async function viaListener(id) { const a = await client.scopes.a(id); const r = lib.notify("k"); return await client.scopes.b(a, r); }
  async function viaClosure(id) { const a = await client.scopes.a(id); const r = t("j"); return await client.scopes.b(a, r); }
  async function viaSpread(id) { const a = await client.scopes.a(id); const r = lib.spread("v", "-"); return await client.scopes.b(a, r); }
  async function viaEach(id) { const a = await client.scopes.a(id); const r = lib.each(["p", "qq", "r", "s"]); return await client.scopes.b(a, r); }
  return { viaMethod, viaListener, viaClosure, viaSpread, viaEach };
}`;
  const out2 = compile(SRC2, { filename: "views2.js", closures: true, syncClosures: true, syncCalls: true, syncMethods: true });
  const ms2 = out2.meta.methods as Array<{ class: string; method: string; program: string | null; error?: string }>;
  check("the library's six methods and its closure compiled, the component's five chains too", ["Lib2$get", "Lib2$join", "Lib2$notify", "Lib2$fixed", "Lib2$spread", "Lib2$each", "Lib2$fixed$t", "Dialog2$viaMethod", "Dialog2$viaListener", "Dialog2$viaClosure", "Dialog2$viaSpread", "Dialog2$viaEach"].every((n) => ms2.some((m) => m.program === n)), JSON.stringify(ms2.filter((m) => !m.program)));
  check("a sync call of a value lowers to a pump-dispatched park, a call of module code stays plain", out2.code.includes('op: "dyn", sync: 1, recv: F.args[0], path: ["lib"], member: "get"') && out2.code.includes('op: "callv", recv: F.args[0], path: ["t"]'), out2.code.match(/op: "(?:dyn|callv)"[^}]*/g)?.slice(0, 6).join("\n"));
  writeFileSync(join(GEN, "views2.mjs"), out2.code);
  const m2 = await import(pathToFileURL(join(GEN, "views2.mjs")).href);
  const b2 = { PROGRAMS: m2.PROGRAMS, __unwind: m2.__unwind, __slots: m2.__slots };
  const run2 = async (fn: string, lib: InstanceType<typeof m2.Lib2>, t?: unknown): Promise<{ r: unknown; resumes: number; log: string[] }> => {
    const log: string[] = []; let resumes = 0;
    const cbs: Array<((obj: unknown, bin: Uint8Array | null) => void) | null> = [null, null];
    const mkPort = (me: number): Port => ({
      send(obj: any, bin?: Uint8Array): void { if (me === 0 && obj.kind === "request" && obj.payload?.type === "resume") resumes++; const m = decodeMessage(encodeMessage(obj, bin)); queueMicrotask(() => cbs[1 - me]?.(m.obj, m.bin)); },
      onMessage(cb): void { cbs[me] = cb; }, onClose(): void { /* in-process */ }, close(): void { /* in-process */ },
    });
    const twin = new Client("server", log);
    makeHost({ bundle: b2 as never, tier: "server", exec: (() => { throw new Error("none"); }) as never, twins: (cls) => (cls === "Client" ? twin : undefined) }).answer(makePeer(mkPort(1)));
    const peer = makePeer(mkPort(0));
    const bhost = makeHost({ bundle: b2, tier: "browser", exec: (() => { throw new Error("none"); }) as never });
    (globalThis as Record<string, unknown>).__probeClient = new Client("browser", log);
    m2.__bindTierlessMethods((prog: string, caps: object, a: unknown[]) => bhost.runLocal(peer, prog, [caps, ...a], { migrate: () => true }));
    try { return { r: await m2.Dialog2({ lib, t })[fn](1), resumes, log }; } finally { m2.__bindTierlessMethods(null); }
  };
  const lib = new m2.Lib2();
  check("at home the compiled sync methods behave as written", lib.get("k") === "v.3" && lib.notify("x") === "listened:x" && lib.hits === 1 && lib.fixed()("j") === "w.3" && lib.spread("v", "-") === "v-3", lib.get("k"));
  const l4 = new m2.Lib2();
  const r4 = await run2("viaSpread", l4);
  check("a rest-parameter method (`...args`, a frame-field name) with a guarded optional call runs over the view — one crossing, right value", r4.r === "2/v-3" && r4.resumes === 1 && r4.log.join() === "server:a,server:b", JSON.stringify(r4));
  const l5 = new m2.Lib2();
  check("at home, inline array callbacks (forEach with an early return, map/filter/some) behave as written", l5.each(["p", "qq", "r", "s"]) === "p+3,qq+3,r+3/true", l5.each(["p", "qq", "r", "s"]));
  const r5 = await run2("viaEach", new m2.Lib2());
  check("a method whose work is inside forEach/map/filter callbacks runs over the view as loops — one crossing, right value", r5.r === "2/p+3,qq+3,r+3/true" && r5.resumes === 1 && r5.log.join() === "server:a,server:b", JSON.stringify(r5));
  const l1 = new m2.Lib2();
  const r1 = await run2("viaMethod", l1);
  check("a method call mid-chain runs on the gateway over the instance's view — one crossing, right value", r1.r === "2/v.3" && r1.resumes === 1 && r1.log.join() === "server:a,server:b", JSON.stringify(r1));
  const l2 = new m2.Lib2();
  const r2 = await run2("viaListener", l2);
  check("a method that calls a listener parks that call home — right value, the listener ran at home (hits=1), two crossings", r2.r === "2/listened:k" && l2.hits === 1 && r2.resumes === 2 && r2.log.join() === "server:a,server:b", JSON.stringify({ ...r2, hits: l2.hits }));
  const l3 = new m2.Lib2();
  const r3 = await run2("viaClosure", l3, l3.fixed());
  check("a shipped closure over the instance (no copy: its view) runs on the gateway — one crossing, right value", r3.r === "2/w.3" && r3.resumes === 1 && r3.log.join() === "server:a,server:b", JSON.stringify(r3));
}

// ---- fidelity over random objects: what a view carries reads as the original ------------
// Random plain/array/instance graphs with functions, host objects and big strings mixed in,
// excised under random budgets: every own data member of the original is, in the view,
// either the same primitive, a nested view (recursively so), or a member handle whose path
// resolves at home to that very member; arrays keep their length; an instance view carries
// no member its original lacks; and the view goes home as the original object.
{
  const { encodeWireBinary, decodeWireBinary } = await import("tierless/wire");
  const { makeTier } = await import("tierless/heap");
  const { isHandle, VIEW } = await import("tierless/graph");
  const rng = (seed: number): (() => number) => { let st = (seed >>> 0) || 1; return () => { st = (st * 1103515245 + 12345) & 0x7fffffff; return st / 0x7fffffff; }; };
  class Inst { constructor(f: Record<string, unknown>) { Object.assign(this, f); } get g(): number { return 1; } }
  shareClass("probe:Inst", Inst);
  let fails: string[] = [], members = 0, handles = 0;
  for (let seed = 1; seed <= 300 && fails.length < 5; seed++) {
    const rnd = rng(seed * 31); const rint = (n: number): number => Math.floor(rnd() * n);
    const value = (depth: number): unknown => {
      const c = rint(depth > 3 ? 4 : 11);
      switch (c) {
        case 0: return rint(100); case 1: return "s" + rint(9); case 2: return rnd() < 0.5; case 3: return null;
        case 4: { const o: Record<string, unknown> = {}; for (let i = rint(4); i >= 0; i--) o["k" + i] = value(depth + 1); return o; }
        case 5: { const a: unknown[] = []; for (let i = rint(4); i >= 0; i--) a.push(value(depth + 1)); return a; }
        case 6: { const f: Record<string, unknown> = {}; for (let i = rint(3); i >= 0; i--) f["p" + i] = value(depth + 1); return new Inst(f); }
        case 7: return (): number => 1;
        case 8: return rnd() < 0.5 ? new Map([["m", 1]]) : new Date(0);
        case 9: return "x".repeat(50 + rint(400));
        default: return undefined;
      }
    };
    const root: Record<string, unknown> = {}; for (let i = rint(5); i >= 0; i--) root["r" + i] = value(1);
    const threshold = [64, 256, 2048][rint(3)];
    const browser = makeTier("browser"), server = makeTier("server");
    const far = decodeWireBinary(encodeWireBinary([{ fn: "F", pc: 0, args: [], o: root }], null, { tier: browser, excise: (v) => v === root, threshold }), { tier: server }).stack[0] as unknown as { o: unknown };
    const resolve = (h: { id: string; path?: string[] }): unknown => { let v = browser.heapGet(h.id); for (const k of h.path ?? []) v = (v as Record<string, unknown>)[k]; return v; };
    const same = (orig: unknown, got: unknown, path: string): void => {
      if (isHandle(got)) { handles++; if (resolve(got) !== orig) fails.push(`seed ${seed}: member handle at ${path} resolves to another member`); return; }
      if (orig === null || typeof orig !== "object") { members++; if (!Object.is(orig, got)) fails.push(`seed ${seed}: primitive at ${path} differs`); return; }
      const vh = (got as { [VIEW]?: { inst?: true; path?: string[] } })?.[VIEW];
      if (!vh) { fails.push(`seed ${seed}: object at ${path} arrived as neither view nor handle`); return; }
      if (resolve(vh as { id: string; path?: string[] }) !== orig) { fails.push(`seed ${seed}: view at ${path} stands for another object`); return; }
      if (Array.isArray(orig)) { if (!Array.isArray(got) || got.length !== orig.length) { fails.push(`seed ${seed}: array at ${path} changed shape`); return; } orig.forEach((x, i) => same(x, got[i], path + "[" + i + "]")); return; }
      const isInst = Object.getPrototypeOf(orig) !== Object.prototype;
      if (isInst !== !!vh.inst) fails.push(`seed ${seed}: instance mark wrong at ${path}`);
      for (const k of Object.keys(got as object)) if (!(k in (orig as object))) fails.push(`seed ${seed}: view at ${path} carries ${k}, which the original lacks`);
      for (const [k, x] of Object.entries(orig as object)) {
        if (x === undefined) { if (isInst ? !(k in (got as object)) || (got as Record<string, unknown>)[k] !== undefined : k in (got as object)) fails.push(`seed ${seed}: undefined member ${k} at ${path} misrepresented`); continue; }
        if (!(k in (got as object))) { fails.push(`seed ${seed}: member ${k} at ${path} missing from the view`); continue; }
        same(x, (got as Record<string, unknown>)[k], path + "." + k);
      }
    };
    same(root, far.o, "o");
    const back = decodeWireBinary(encodeWireBinary([far as never], null, { tier: server, excise: () => false, threshold }), { tier: browser }).stack[0] as unknown as { o: unknown };
    if (back.o !== root) fails.push(`seed ${seed}: the view didn't come home as the original`);
  }
  check(`300 random objects under random budgets: ${members} members read as the original, ${handles} member handles resolve at home, views come home as the original`, fails.length === 0, fails.slice(0, 3).join("; "));
}

console.log(`\n${ok() ? "PASS" : "FAIL"} — a borrowed instance is readable off-tier: data reads stay, behavior and writes park home`);
process.exit(ok() ? 0 : 1);
