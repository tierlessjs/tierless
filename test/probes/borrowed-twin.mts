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
//     "dyn:client.scopes.a"), the server resolves caps.client to its session twin through
//     the handle's member classes, serves all three dependent calls, ONE crossing
//   - the twin's data-field writes land on the live client (member-path delta)
//   - a twin call that throws unwinds into the compiled catch on the server
//   - a server without a twin sends the call home with its path: correct, just unbatched
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { makeHost } from "tierless";
import { makePeer, encodeMessage, decodeMessage, type Port } from "tierless/transport";

const require = createRequire(import.meta.url);
const { compile } = require("../../packages/tierless/src/transform.cjs");

let failed = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  console.log(`${ok ? "ok" : "FAIL"}  ${name}${ok || !detail ? "" : " — " + detail}`);
  if (!ok) failed++;
};

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
      fail: async () => { this.calls++; log.push(this.where + ":fail"); throw new Error("nope"); },
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
  async function guarded() {
    try { await client.scopes.fail(); return "no"; }
    catch (e) { return "caught:" + e.message; }
  }
  return { load, guarded };
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
const connect = (twins?: (cls: string) => object | undefined) => {
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
  makeHost({ bundle, tier: "server", exec: (() => { throw new Error("no resources here"); }) as never, ...(twins ? { twins } : {}) }).answer(makePeer(mkPort(1, false)));
  return makePeer(mkPort(0, true));
};
const bhost = makeHost({ bundle, tier: "browser", exec: (() => { throw new Error("browser owns nothing"); }) as never });
const reset = (): void => { log.length = 0; for (const k of Object.keys(counts)) delete counts[k]; };

const twin = new Client("server", log);
const withTwin = connect((cls) => (cls === "Client" ? twin : undefined));
const noTwin = connect();

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
}

// ---- a twin call that throws unwinds into the compiled catch over there ----------------
{
  reset();
  const live = new Client("browser", log);
  const r = await bhost.runLocal(withTwin, "scopes$guarded", [{ client: live }], { migrate: () => true });
  check("error: caught by the compiled catch, served by the twin", r === "caught:nope" && log.join(",") === "server:fail" && counts.resume === 1, JSON.stringify({ r, log, counts }));
}

// ---- no twin on the server: the call goes home with its path ---------------------------
{
  reset();
  const live = new Client("browser", log);
  const r = await bhost.runLocal(noTwin, "scopes$load", [{ client: live, label: "n" }], { migrate: () => true });
  check("no twin: right value, the live client served every call (correct, unbatched)",
    r === "n:2,20,17" && log.join(",") === "browser:a,browser:b,browser:c", JSON.stringify({ r, log, counts }));
}

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\na chain through a borrowed service runs on a session twin in one crossing");
