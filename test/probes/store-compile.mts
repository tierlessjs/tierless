// PROBE: Pinia-style setup-store functions as compilation units (docs/migrate-arm.md
// slice 3). Functions declared inside defineStore(key, () => {...}) whose awaits reach
// tier calls compile into PROGRAMS with their free setup-scope bindings rewritten to
// __caps.<name>; the kept function is the routing stub over a CALL-TIME caps snapshot,
// falling back to the untouched original. Asserted here:
//   - captures found precisely (shadowed names keep their local meaning)
//   - unbound module imports stay as-is (the kept import serves the machine copy)
//   - a function assigning to a captured binding is kept original, with the reason
//   - the stub routes (program, caps, args); unbound falls back to stock behavior
//   - the compiled chain runs via runLocal: fetch arm AND one-crossing migrate
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

const SRC = `"use tierless";
export function defineStore(key, setup) { return () => setup(); }   // pinia stand-in: same shape
export class Svc {
  constructor(http) { this.http = http; this.total = 0; }
  async create(m) {
    const r = await this.http.put("/things", m);
    return r.body;
  }
  async reload() {
    const r = await this.http.get("/things");
    return r.body;
  }
}
export const useThings = defineStore("things", () => {
  const state = { items: [], flips: 0 };
  const svc = new Svc(globalThis.__probeHttp);
  async function toggleAndReload(item) {
    const s = new Svc(globalThis.__probeHttp);   // fn-local service, their stores' shape
    state.flips++;
    const created = await s.create(item);
    const items = await s.reload();
    state.items = items;
    return created.id + ":" + items.length;
  }
  async function viaCaptured(item) {             // captured service: correct, fence-per-call
    const created = await svc.create(item);
    const items = await svc.reload();
    return created.id + ":" + items.length;
  }
  async function plain(x) { return x + state.flips; }               // no tier calls: untouched
  let counter = 0;
  async function bad(m) { counter++; const r = await svc.create(m); return r; }   // assigns a capture
  return { state, svc, toggleAndReload, viaCaptured, plain, bad };
});`;

const { code, meta } = compile(SRC, { resources: { "this.http": "server" }, filename: "store.js" });
const storeEntries = meta.methods.filter((m: any) => m.class === "store:things");
check("toggleAndReload compiled; bad kept original with the capture-write reason",
  storeEntries.some((m: any) => m.method === "toggleAndReload" && m.program === "things$toggleAndReload")
  && storeEntries.some((m: any) => m.method === "bad" && m.program === null && /assigns to captured binding 'counter'/.test(m.error || "")),
  JSON.stringify(storeEntries));
check("plain stays out entirely (no tier-reaching awaits)", !storeEntries.some((m: any) => m.method === "plain"), JSON.stringify(storeEntries));
check("machine rewrites captures through the caps frame slot", code.includes("F.args[0].state") && code.includes("F.args[0].svc"), "");

const dir = mkdtempSync(join(tmpdir(), "tlstore-"));
writeFileSync(join(dir, "store.mjs"), code);
const mod = await import(pathToFileURL(join(dir, "store.mjs")).href);

// ---- unbound: the stub falls back to the untouched original ----------------------------
const served: string[] = [];
(globalThis as Record<string, unknown>).__probeHttp = {
  put: async (url: string) => { served.push("put:" + url); return { body: { id: 9 } }; },
  get: async (url: string) => { served.push("get:" + url); return { body: [1, 2] }; },
};
const store1 = mod.useThings();
const r1 = await store1.toggleAndReload({ t: "x" });
check("unbound stub falls back to stock behavior", r1 === "9:2" && store1.state.flips === 1 && served.join(",") === "put:/things,get:/things", JSON.stringify({ r1, served }));

// ---- bound: runLocal fetch arm, then one-crossing migrate ------------------------------
const counts: Record<string, number> = {};
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
const twinServed: string[] = [];
const serverExec = async (req: { name: string; args: unknown[] }): Promise<unknown> => {
  twinServed.push(req.name + ":" + req.args[0]);
  return req.name === "http.put" ? { status: 200, headers: {}, body: { id: 42 } } : { status: 200, headers: {}, body: [1, 2, 3] };
};
const bundle = { PROGRAMS: mod.PROGRAMS, __unwind: mod.__unwind, __slots: mod.__slots };
makeHost({ bundle, tier: "server", exec: serverExec as never }).answer(makePeer(mkPort(1, false)));
const bhost = makeHost({ bundle, tier: "browser", exec: (() => { throw new Error("browser owns nothing"); }) });
const peer = makePeer(mkPort(0, true));
const reset = (): void => { twinServed.length = 0; for (const k of Object.keys(counts)) delete counts[k]; };

// what the stub would pass: a call-time caps snapshot from a live store instance
const store2 = mod.useThings();
const caps = { state: store2.state, svc: store2.svc };

reset();
const r2 = await bhost.runLocal(peer, "things$toggleAndReload", [caps, { t: "y" }], {});
check("fetch arm: correct value, both service calls exec-carried", r2 === "42:3" && counts.exec === 2 && !counts.resume, JSON.stringify({ r2, counts }));
check("fetch arm: state mutations landed on the live store", store2.state.flips === 1 && store2.state.items.length === 3, JSON.stringify(store2.state));

reset();
const store3 = mod.useThings();
const r3 = await bhost.runLocal(peer, "things$toggleAndReload", [{ state: store3.state, svc: store3.svc }, { t: "z" }], { migrate: () => true });
check("migrate: the 2-method store chain is ONE crossing", r3 === "42:3" && counts.resume === 1 && !counts.exec, JSON.stringify({ r3, counts }));
check("migrate: both calls served server-side; live state still mutated at home", twinServed.join(",") === "http.put:/things,http.get:/things" && store3.state.flips === 1 && store3.state.items.length === 3, JSON.stringify({ twinServed, state: store3.state }));

// captured-service receivers are PATHS through the caps handle: every dispatch fences
// home — correct (value, no divergence), just unbatched. Their stores construct services
// fn-locally, so this is the exception path, asserted for the record.
reset();
const store4 = mod.useThings();
const r4 = await bhost.runLocal(peer, "things$viaCaptured", [{ svc: store4.svc }, { t: "w" }], { migrate: () => true });
check("captured-service chain: correct but fenced (one crossing per method)", r4 === "42:3" && (counts.resume || 0) >= 2 && !counts.exec, JSON.stringify({ r4, counts }));

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nsetup-store functions compile with call-time caps; captures rewrite precisely; the chain still batches");
