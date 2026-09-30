// PROBE: a chain through a BORROWED service runs on a session twin in one crossing.
//
// Real app code rarely constructs its API client inside the function that uses it: a React
// component gets `adminClient` from a hook, a Pinia store captures a service from setup
// scope. Those reach the compiled function through its caps, and caps excise whole (so
// writes to shared state stay on the live object at home). Before this, every call through
// a borrowed service went home — one crossing per call, no batching (store-compile probe,
// viaCaptured). Asserted here:
//   - the compiler ships `client.scopes.a()` as slot + path, not a scanned path read
//   - fetch arm: nothing migrates, the live client serves every call
//   - migrate: the browser offers at the first borrowed call (the migrate decision sees
//     "dyn:client.scopes.a"), the caps arrive as a view whose `client` is a member handle
//     of class Client, the server's twin serves all three dependent calls, ONE crossing
//   - the twin's data-field writes land on the live client (member-path delta)
//   - a twin call that throws unwinds into the compiled catch on the server, and an error of
//     a shared class keeps that class when the catch finishes at home
//   - traced fetch-arm runs record the borrowed calls, and a profile built from them
//     migrates the chain (the run protocol) while leaving a one-call function alone
//   - a server without a twin sends the call home with its path: correct, just unbatched
//   - with the `closures` option, a component's `const loader = async () => {...}` and a
//     hook's `async function` compile (2+ awaits only) and run the same way
//   - a dependent chain that reads borrowed PRIMITIVES between calls, with a branch not
//     taken that calls a borrowed function, still runs in ONE crossing (member-precise
//     stop rule + checkpoint branches); taking that branch goes home and is still right
//   - a FAN-OUT (list, then Promise.all over an inline async map calling the borrowed
//     client) runs in ONE crossing: the server hydrates the borrowed client to its twin, so
//     the plain inner closure calls it natively; the twin's writes are diffed per crossing,
//     and a twin that escaped into a local goes home as the live client
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { makeHost } from "tierless";
import { makePeer, encodeMessage, decodeMessage, type Port } from "tierless/transport";
import { memorySink, buildProfile, loadProfile, methodMigrate } from "tierless/trace";
import { shareClass } from "tierless/graph";

const require = createRequire(import.meta.url);
const { compile } = require("../../packages/tierless/src/transform.cjs");

let failed = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  console.log(`${ok ? "ok" : "FAIL"}  ${name}${ok || !detail ? "" : " — " + detail}`);
  if (!ok) failed++;
};

// the library's own error class (keycloak-admin-client's NetworkError): shared, so an error a
// twin throws on the gateway is still `instanceof NetErr` when the app's catch runs at home
class NetErr extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
shareClass("NetErr", NetErr);

// a LIBRARY client, never compiled: resources hang off sub-objects (keycloak-admin-client's
// shape — adminClient.clientScopes.find()). The port opts it into twinning by stamping it.
class Client {
  calls = 0;
  where: string;
  scopes: Record<string, (x: number) => Promise<number>>;
  constructor(where: string, log: string[]) {
    this.where = where;
    const io = async (name: string, v: number): Promise<number> => { this.calls++; log.push(this.where + ":" + name); return v; };
    this.scopes = {
      a: (x) => io("a", x + 1),
      b: (x) => io("b", x * 10),
      c: (x) => io("c", x - 3),
      fail: async () => { this.calls++; log.push(this.where + ":fail"); throw new NetErr("nope", 409); },
      list: async (n) => { this.calls++; log.push(this.where + ":list"); return [...Array(n).keys()] as unknown as number; },
    };
  }
}
(Client.prototype as unknown as { __tierless_cls: string }).__tierless_cls = "Client";

const SRC = `"use tierless";
export function defineStore(key, setup) { return () => setup(); }
export const useScopes = defineStore("scopes", () => {
  const client = globalThis.__probeClient;       // borrowed, like useAdminClient()
  const label = "n";
  async function load() {
    const a = await client.scopes.a(1);
    const b = await client.scopes.b(a);           // each call needs the one before it
    const c = await client.scopes.c(b);
    return label + ":" + [a, b, c].join(",");
  }
  const onError = globalThis.__probeOnError;     // the app's alert helper: a borrowed function
  async function report() {
    try { await client.scopes.fail(); return "no"; }
    catch (e) { return onError(e); }              // touches caps: this catch finishes at HOME
  }
  async function guarded() {
    try { await client.scopes.fail(); return "no"; }
    catch (e) { return "caught:" + e.message; }
  }
  return { load, guarded, report };
});`;

const { code, meta } = compile(SRC, { filename: "scopes.js" });
check("load and guarded compiled", ["load", "guarded"].every((m) => (meta.methods as any[]).some((x) => x.method === m && x.program)), JSON.stringify(meta.methods));
check("the borrowed call ships as slot + path", code.includes('recv: F.args[0], path: ["client","scopes"], member: "a"'), "");

const dir = mkdtempSync(join(tmpdir(), "tltwin-"));
writeFileSync(join(dir, "scopes.mjs"), code);
const mod = await import(pathToFileURL(join(dir, "scopes.mjs")).href);
const bundle = { PROGRAMS: mod.PROGRAMS, __unwind: mod.__unwind, __slots: mod.__slots };

const log: string[] = [];
const counts: Record<string, number> = {};
// one in-process browser<->server pair; `twins` is the server's session registry
const connect = (bundle: object, twins?: (cls: string, h?: { state?: Record<string, unknown> }) => object | undefined) => {
  const cbs: Array<((obj: unknown, bin: Uint8Array | null) => void) | null> = [null, null];
  const mkPort = (me: number, count: boolean): Port => ({
    send(obj: any, bin?: Uint8Array): void {
      if (count && obj.kind === "request" && obj.payload?.type) counts[obj.payload.type] = (counts[obj.payload.type] || 0) + 1;
      const m = decodeMessage(encodeMessage(obj, bin));
      queueMicrotask(() => cbs[1 - me]?.(m.obj, m.bin));
    },
    onMessage(cb): void { cbs[me] = cb; },
    onClose(): void { /* in-process */ },
    close(): void { /* in-process */ },
  });
  makeHost({ bundle: bundle as never, tier: "server", exec: (() => { throw new Error("no resources here"); }) as never, ...(twins ? { twins } : {}) }).answer(makePeer(mkPort(1, false)));
  return makePeer(mkPort(0, true));
};
const bhost = makeHost({ bundle, tier: "browser", exec: (() => { throw new Error("browser owns nothing"); }) as never });
const reset = (): void => { log.length = 0; for (const k of Object.keys(counts)) delete counts[k]; };

const twin = new Client("server", log);
let lastState: Record<string, unknown> | undefined;
const withTwin = connect(bundle, (cls, h) => { lastState = h?.state; return cls === "Client" ? twin : undefined; });
const noTwin = connect(bundle);

// ---- fetch arm: nothing migrates -----------------------------------------------------
{
  reset();
  const live = new Client("browser", log);
  const r = await bhost.runLocal(withTwin, "scopes$load", [{ client: live, label: "n" }], {});
  check("fetch arm: right value, the live client served all three, no crossing",
    r === "n:2,20,17" && log.join(",") === "browser:a,browser:b,browser:c" && !counts.resume, JSON.stringify({ r, log, counts }));
}

// ---- migrate: one crossing, the twin serves the chain ----------------------------------
{
  reset();
  const live = new Client("browser", log);
  const asked: string[] = [];
  const r = await bhost.runLocal(withTwin, "scopes$load", [{ client: live, label: "n" }], {
    migrate: (req) => { asked.push(req.name); return true; },
  });
  check("migrate: offered at the first borrowed call", asked[0] === "dyn:client.scopes.a", JSON.stringify(asked));
  check("migrate: right value; the twin served all three dependent calls in ONE crossing",
    r === "n:2,20,17" && log.join(",") === "server:a,server:b,server:c" && counts.resume === 1, JSON.stringify({ r, log, counts }));
  check("migrate: the twin's field write landed on the live client", live.calls === 3, String(live.calls));
  check("migrate: the twin factory got the live client's data fields as they shipped (no functions)",
    lastState?.where === "browser" && lastState?.calls === 0 && !("scopes" in (lastState ?? {})), JSON.stringify(lastState));
}

// ---- a BIG borrowed client: its graph is far over the codec's 8 KB inline threshold, but
// it ships as a handle anyway — the size estimate must not charge it to the frame's args
// array (Keycloak: the whole args array was excised, the gateway read F.args[0] undefined)
{
  reset();
  const live = new Client("browser", log) as Client & { catalog?: string[] };
  live.catalog = Array.from({ length: 2000 }, (_, i) => "entry-" + i);
  const r = await bhost.runLocal(withTwin, "scopes$load", [{ client: live, label: "n" }], { migrate: () => true });
  check("big client: the chain still runs on the twin in ONE crossing", r === "n:2,20,17" && log.join(",") === "server:a,server:b,server:c" && counts.resume === 1, JSON.stringify({ r, log, counts }));
}

// ---- a twin call that throws unwinds into the compiled catch over there ----------------
{
  reset();
  const live = new Client("browser", log);
  const r = await bhost.runLocal(withTwin, "scopes$guarded", [{ client: live }], { migrate: () => true });
  check("error: caught by the compiled catch, served by the twin", r === "caught:nope" && log.join(",") === "server:fail" && counts.resume === 1, JSON.stringify({ r, log, counts }));
}

// ---- the PROFILE decides: traced fetch-arm runs record the borrowed calls, the method
// boundary rule reads a stable 3-call chain at the first site, and the locked profile
// migrates it — the run protocol, with no hand-set migrate callback ----------------------
{
  const { sink, records } = memorySink();
  const thost = makeHost({ bundle, tier: "browser", exec: (() => { throw new Error("browser owns nothing"); }) as never, trace: { rate: 1, sink } });
  for (let i = 0; i < 3; i++) await thost.runLocal(withTwin, "scopes$load", [{ client: new Client("browser", []), label: "n" }], {});
  const touches = records.filter((r: any) => r.t === "res");
  check("profiling: every borrowed call recorded as a touch (unsized), in order",
    touches.length === 9 && touches.slice(0, 3).map((r: any) => r.resource).join(",") === "dyn:client.scopes.a,dyn:client.scopes.b,dyn:client.scopes.c" && touches.every((r: any) => r.resultBytes === -1),
    JSON.stringify(touches.slice(0, 3)));
  const profile = loadProfile(buildProfile(records, mod.BUNDLE_HASH), mod.BUNDLE_HASH);
  const mig = methodMigrate(profile);
  reset();
  const live = new Client("browser", log);
  const r = await bhost.runLocal(withTwin, "scopes$load", [{ client: live, label: "n" }], { migrate: mig });
  check("profiled: the locked profile migrates the chain — ONE crossing, twin-served",
    r === "n:2,20,17" && log.join(",") === "server:a,server:b,server:c" && counts.resume === 1, JSON.stringify({ r, log, counts }));
  reset();
  const r1 = await bhost.runLocal(withTwin, "scopes$guarded", [{ client: new Client("browser", log) }], { migrate: mig });
  check("profiled: a one-call function the profile never saw chain stays on the fetch arm", r1 === "caught:nope" && !counts.resume && log.join(",") === "browser:fail", JSON.stringify({ r1, log, counts }));
}

// ---- an error the twin throws keeps its class when the catch finishes at home ---------
{
  (globalThis as Record<string, unknown>).__probeOnError = (e: unknown) =>
    (e instanceof NetErr ? `net:${e.status}:${e.message}` : `other:${e instanceof Error}`);
  reset();
  const r = await bhost.runLocal(withTwin, "scopes$report", [{ client: new Client("browser", log), onError: (globalThis as Record<string, unknown>).__probeOnError }], { migrate: () => true });
  check("error class: the twin's NetErr reaches the app's catch at home as a NetErr (status, message intact)", r === "net:409:nope" && log.join(",") === "server:fail", JSON.stringify({ r, log }));
}

// ---- no twin on the server: the call goes home with its path ---------------------------
{
  reset();
  const live = new Client("browser", log);
  const r = await bhost.runLocal(noTwin, "scopes$load", [{ client: live, label: "n" }], { migrate: () => true });
  check("no twin: right value, the live client served every call (correct, unbatched)",
    r === "n:2,20,17" && log.join(",") === "browser:a,browser:b,browser:c", JSON.stringify({ r, log, counts }));
}

// ---- the React shape: async functions declared in a component body (closures option) ---
// `const loader = async () => {...}` inside a function component, the client from a hook:
// Keycloak admin-ui's ClientScopesSection loader, reduced. Opt-in, and only functions
// with 2+ tier-reaching awaits — a one-call function has no chain to fold.
{
  const COMP = `"use tierless";
function useClient() { return { client: globalThis.__probeClient }; }
export function Section(props) {
  const { client } = useClient();
  const label = props.label;
  const loader = async (n) => {
    const a = await client.scopes.a(n);
    const b = await client.scopes.b(a);
    const c = await client.scopes.c(b);
    return label + ":" + [a, b, c].join(",");
  };
  async function one() { return await client.scopes.a(1); }
  return { loader, one };
}
export const Hooked = () => {
  const { client } = useClient();
  async function two() { const a = await client.scopes.a(0); return await client.scopes.b(a); }
  return { two };
};
function useFetch(fn) { (globalThis.__probeFetches ||= []).push(fn); }
export function Fetched() {
  const { client } = useClient();
  useFetch(async () => { const a = await client.scopes.a(2); return await client.scopes.b(a); });
  useFetch(async () => await client.scopes.a(9));
}
function useT() { return { t: (k) => "t:" + k }; }
export function Perms() {
  const { client } = useClient();
  useFetch(async () => {                         // Keycloak's permissions tabs: list, then per item
    const ps = await client.scopes.list(3);      // a dependent pair, fanned out in parallel
    return await Promise.all(ps.map(async (p) => { const a = await client.scopes.a(p); return await client.scopes.b(a); }));
  });
  const report = globalThis.__probeReport;
  useFetch(async () => {                         // the twin escapes into a local, then the run goes home
    const xs = await client.scopes.list(2);      // migrates here; on the server client is the twin
    const c = client;
    await c.scopes.a(0);
    return report(c, xs.length);                 // a borrowed function: runs at home, sees c
  });
}
export function Details(props) {
  const { client } = useClient();
  const { id, step } = props;
  const { t } = useT();
  useFetch(async () => {                         // FlowDetails: the second call needs the first's result
    const a = await client.scopes.a(id);         // and borrowed primitives between the calls
    const b = await client.scopes.b(a + step);
    if (b < 0) throw new Error(t("notFound"));   // a borrowed FUNCTION, on a branch not taken
    return await client.scopes.c(b);
  });
}`;
  const off = compile(COMP, { filename: "comp.js" });
  check("closures off: component functions stay plain", !(off.meta.methods as any[]).some((m) => m.class.startsWith("fn:")), JSON.stringify(off.meta.methods));
  const { code: ccode, meta: cmeta } = compile(COMP, { filename: "comp.js", closures: true });
  const ms = cmeta.methods as any[];
  check("closures on: a const arrow and a declaration compile; the one-call function stays plain",
    ms.some((m) => m.program === "Section$loader") && ms.some((m) => m.program === "Hooked$two") && !ms.some((m) => m.method === "one"), JSON.stringify(ms));
  check("closures on: an async callback passed to a hook compiles as <Component>$<hook><n>; a one-call callback stays plain",
    ms.some((m) => m.program === "Fetched$useFetch0") && !ms.some((m) => m.program === "Fetched$useFetch1"), JSON.stringify(ms));
  check("server code carries the program, not the component it was declared in (Section$loader is not a use of Section)",
    typeof cmeta.serverCode === "string" && cmeta.serverCode.includes("Section$loader") && !/function Section\(/.test(cmeta.serverCode), String(cmeta.serverCode).slice(0, 200));
  writeFileSync(join(dir, "comp.mjs"), ccode);
  const dslots = (await import(pathToFileURL(join(dir, "comp.mjs")).href)).__slots["Details$useFetch0"] as Record<string, string[]>;
  const dall = Object.values(dslots).flat();
  check("stop rule: borrowed primitives are recorded by member, and the throw branch is a checkpoint (its t() call needs the whole caps only on that side)",
    dall.includes("args[0].id") && dall.includes("args[0].step") && /if \(F\.b < 0\) \{ F\.pc = \d+; \} else \{ F\.pc = \d+; \} return \{ op: "check" \};/.test(ccode)
      && Object.values(dslots).filter((r) => r.includes("args[0]")).length === 1, JSON.stringify(dslots));
  const cmod = await import(pathToFileURL(join(dir, "comp.mjs")).href);
  const cbundle = { PROGRAMS: cmod.PROGRAMS, __unwind: cmod.__unwind, __slots: cmod.__slots };
  const cpeer = connect(cbundle, (cls) => (cls === "Client" ? twin : undefined));
  const chost = makeHost({ bundle: cbundle as never, tier: "browser", exec: (() => { throw new Error("browser owns nothing"); }) as never });

  reset();
  (globalThis as Record<string, unknown>).__probeClient = new Client("browser", log);
  const sec = cmod.Section({ label: "n" });
  check("the stub carries the program stamp", sec.loader.__tierless_program === "Section$loader", String(sec.loader.__tierless_program));
  const r0 = await sec.loader(1);
  check("unbound: the original runs on the live client", r0 === "n:2,20,17" && log.join(",") === "browser:a,browser:b,browser:c", JSON.stringify({ r0, log }));

  reset();
  cmod.__bindTierlessMethods((prog: string, caps: object, args: unknown[]) => chost.runLocal(cpeer, prog, [caps, ...args], { migrate: () => true }));
  const r1 = await cmod.Section({ label: "n" }).loader(1);
  const r2 = await cmod.Hooked().two();
  cmod.Fetched();
  const r3 = await ((globalThis as Record<string, unknown>).__probeFetches as Array<() => Promise<number>>)[0]();
  cmod.__bindTierlessMethods(null);
  check("bound + migrate: the component loader's three calls ran on the twin in ONE crossing",
    r1 === "n:2,20,17" && log.slice(0, 3).join(",") === "server:a,server:b,server:c", JSON.stringify({ r1, log, counts }));
  check("bound + migrate: the hook declaration form and the anonymous hook callback too (one crossing each run)", r2 === 10 && r3 === 30 && counts.resume === 3, JSON.stringify({ r2, r3, counts }));

  cmod.__bindTierlessMethods((prog: string, caps: object, args: unknown[]) => chost.runLocal(cpeer, prog, [caps, ...args], { migrate: () => true }));
  reset();
  cmod.Details({ id: 1, step: 5 });
  const r4 = await ((globalThis as Record<string, unknown>).__probeFetches as Array<() => Promise<number>>)[2]();
  const dcounts = { ...counts };
  reset();
  cmod.Details({ id: -9, step: 5 });
  let r5: unknown;
  try { await ((globalThis as Record<string, unknown>).__probeFetches as Array<() => Promise<number>>)[3](); } catch (e) { r5 = (e as Error).message; }
  cmod.__bindTierlessMethods(null);
  cmod.__bindTierlessMethods((prog: string, caps: object, args: unknown[]) => chost.runLocal(cpeer, prog, [caps, ...args], { migrate: () => true }));
  reset();
  (globalThis as Record<string, unknown>).__probeClient = new Client("browser", log);
  cmod.Perms();
  const fans = (globalThis as Record<string, unknown>).__probeFetches as Array<() => Promise<number[]>>;
  const r6 = await fans[fans.length - 2]();          // Perms registers two: the fan-out, then the escape case
  cmod.__bindTierlessMethods(null);
  check("fan-out (list, then Promise.all over an async map of dependent calls): all 7 calls on the twin in ONE crossing",
    JSON.stringify(r6) === "[10,20,30]" && counts.resume === 1 && log.length === 7 && log.every((x) => x.startsWith("server:")), JSON.stringify({ r6, counts, log }));
  const liveFan = (globalThis as Record<string, unknown>).__probeClient as Client;
  check("the twin's field writes from plain code ride the reply home (diffed once per crossing)", liveFan.calls === twin.calls, `${liveFan.calls} vs ${twin.calls}`);
  const seen: unknown[] = [];
  (globalThis as Record<string, unknown>).__probeReport = (c: unknown, n: number) => { seen.push(c); return n; };
  cmod.__bindTierlessMethods((prog: string, caps: object, args: unknown[]) => chost.runLocal(cpeer, prog, [caps, ...args], { migrate: () => true }));
  reset();
  (globalThis as Record<string, unknown>).__probeClient = new Client("browser", log);
  cmod.Perms();
  const r7 = await (fans[fans.length - 1] as unknown as () => Promise<number>)();
  cmod.__bindTierlessMethods(null);
  check("a hydrated twin that escaped into a local goes home as the LIVE client, not a copy of the twin",
    r7 === 2 && seen[0] === (globalThis as Record<string, unknown>).__probeClient && log.join(",") === "server:list,server:a", JSON.stringify({ r7, log, same: seen[0] === (globalThis as Record<string, unknown>).__probeClient }));
  check("dependent chain reading borrowed primitives: all three calls on the twin in ONE crossing",
    r4 === 67 && dcounts.resume === 1, JSON.stringify({ r4, dcounts }));
  check("the branch that calls a borrowed function still runs it at home: right error",
    r5 === "t:notFound", JSON.stringify({ r5, log, counts }));
}

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\na chain through a borrowed service runs on a session twin in one crossing");
