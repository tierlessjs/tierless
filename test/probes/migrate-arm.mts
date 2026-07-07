// PROBE: the §6 migrate arm's slice-1 mechanics (docs/migrate-arm.md). A compiled class
// method ships its continuation to the server at the first http.* park instead of
// exec-carrying: tier-owned locals excise into the run's mini-heap and cross as §5
// handles; the server pumps the chain with its own exec; the stop rule parks the stack
// home BEFORE any segment that references a slot currently holding a handle. Asserted
// here over an in-process peer pair with real message encoding and per-type counters:
//   - a 2-call chain = ONE resume crossing, zero execs, both calls serviced server-side
//   - a self-mutating method comes home by the stop rule and mutates the REAL instance
//   - a try/finally whose finally calls a function local runs that finally at home
//   - a prototyped argument returns by IDENTITY (same object, methods intact)
//   - a server-side http error unwinds into the compiled catch over there
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { makeHost } from "tierless";
import { makePeer, encodeMessage, decodeMessage, type Port } from "tierless/transport";
import type { Peer } from "tierless";

const require = createRequire(import.meta.url);
const { compile } = require("../../packages/tierless/src/transform.cjs");

let failed = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  console.log(`${ok ? "ok" : "FAIL"}  ${name}${ok || !detail ? "" : " — " + detail}`);
  if (!ok) failed++;
};

const SRC = `"use tierless";
export class Svc {
  constructor(http) { this.http = http; this.total = 0; }
  async chain(id) {
    const a = await this.http.get("/a/" + id);
    const b = await this.http.get("/b/" + a.body.next);
    return b.body.value;
  }
  async getAllish() {
    const response = await this.http.get("/things");
    this.total = Number(response.headers["x-total"]);
    return response.body;
  }
  async guarded(cancel) {
    try {
      const a = await this.http.get("/a/1");
      const b = await this.http.get("/b/" + a.body.next);
      return b.body.value;
    } finally {
      cancel();
    }
  }
  async withModel(m) {
    const a = await this.http.get("/a/9");
    const b = await this.http.get("/b/" + a.body.next);
    return m.tag(b.body.value);
  }
  async caught() {
    try {
      await this.http.get("/boom");
      return "unreachable";
    } catch (e) {
      return "caught:" + e.message;
    }
  }
}`;

const { code, meta } = compile(SRC, { resources: { "this.http": "server" }, filename: "svc.js" });
check("all five methods compiled", meta.methods.filter((m: any) => !m.error).length === 5, JSON.stringify(meta.methods));

const dir = mkdtempSync(join(tmpdir(), "tlmig-"));
writeFileSync(join(dir, "svc.mjs"), code);
const mod = await import(pathToFileURL(join(dir, "svc.mjs")).href);

check("__slots emitted", !!mod.__slots && !!mod.__slots["Svc$chain"], Object.keys(mod.__slots || {}).join(","));
const slotNames = new Set(Object.values(mod.__slots["Svc$getAllish"] as Record<string, string[]>).flat());
check("getAllish's table names args[0] (this — the stop-rule trigger)", slotNames.has("args[0]"), [...slotNames].join(","));
const chainMid = new Set(Object.values(mod.__slots["Svc$chain"] as Record<string, string[]>).flat());
check("chain's table keeps element precision (args[1], never bare args)", chainMid.has("args[1]") && !chainMid.has("args"), [...chainMid].join(","));

// ---- in-process peer pair with real message encoding + per-type counters ---------------
const counts: Record<string, number> = {};
function pair(): [Port, Port] {
  const cbs: Array<((obj: unknown, bin: Uint8Array | null) => void) | null> = [null, null];
  const mk = (me: number, count: boolean): Port => ({
    send(obj: any, bin?: Uint8Array): void {
      if (count && obj.kind === "request" && obj.payload?.type) counts[obj.payload.type] = (counts[obj.payload.type] || 0) + 1;
      const m = decodeMessage(encodeMessage(obj, bin));                 // the real frame codec, end to end
      queueMicrotask(() => cbs[1 - me]?.(m.obj, m.bin));
    },
    onMessage(cb): void { cbs[me] = cb; },
    onClose(): void { /* in-process: never */ },
    close(): void { /* in-process: never */ },
  });
  return [mk(0, true), mk(1, false)];                                   // count on the browser side only
}
const [browserPort, serverPort] = pair();

// server: services http.* by URL; counts touches so we can assert WHERE calls ran
const served: string[] = [];
const serverExec = async (req: { name: string; args: unknown[] }): Promise<unknown> => {
  const url = String(req.args[0]);
  served.push(url);
  if (url === "/boom") { const e: any = new Error("nope"); e.response = { status: 400 }; throw e; }
  if (url.startsWith("/a/")) return { status: 200, headers: {}, body: { next: "n" + url.slice(3) } };
  if (url.startsWith("/b/")) return { status: 200, headers: {}, body: { value: "got:" + url.slice(3) } };
  if (url === "/things") return { status: 200, headers: { "x-total": "42" }, body: [1, 2, 3] };
  throw new Error("unknown url " + url);
};
const bundle = { PROGRAMS: mod.PROGRAMS, __unwind: mod.__unwind, __slots: mod.__slots };
makeHost({ bundle, tier: "server", exec: serverExec as never }).answer(makePeer(serverPort));

// browser: its own exec must NEVER run in migrated cases
const browserServed: string[] = [];
const browserExec = async (req: { name: string; args: unknown[] }): Promise<unknown> => {
  browserServed.push(String(req.args[0]));
  return serverExec(req);                                               // same data, wrong tier — the counters tell them apart
};
const bhost = makeHost({ bundle, tier: "browser", exec: browserExec as never });
const peer: Peer = makePeer(browserPort);

const reset = (): void => { served.length = 0; browserServed.length = 0; for (const k of Object.keys(counts)) delete counts[k]; };
const migrate = { migrate: () => true };

// ---- 1. the chain: two calls, one crossing --------------------------------------------
reset();
const self1 = new mod.Svc({ marker: true });   // a REAL prototyped instance — ownedUnit excises it
const v1 = await bhost.runLocal(peer, "Svc$chain", [self1, 7], migrate);
check("chain value correct", v1 === "got:n7", String(v1));
check("chain: both calls served on the SERVER", served.join(",") === "/a/7,/b/n7" && browserServed.length === 0, `server=${served} browser=${browserServed}`);
check("chain: ONE resume crossing, zero execs", counts.resume === 1 && !counts.exec, JSON.stringify(counts));

// ---- 2. stop rule: self-write comes home and hits the real instance --------------------
reset();
const self2 = new mod.Svc({});
const v2 = await bhost.runLocal(peer, "Svc$getAllish", [self2], migrate);
check("getAllish value correct", Array.isArray(v2) && (v2 as number[]).join(",") === "1,2,3", JSON.stringify(v2));
check("getAllish: the REAL instance was mutated at home", self2.total === 42, String(self2.total));
check("getAllish: one crossing (out + home), zero execs", counts.resume === 1 && !counts.exec, JSON.stringify(counts));

// ---- 3. finally with a function local: chain still batches, finally runs at home -------
reset();
let cancelled = 0;
const v3 = await bhost.runLocal(peer, "Svc$guarded", [new mod.Svc({}), () => { cancelled++; }], migrate);
check("guarded value correct", v3 === "got:n1", String(v3));
check("guarded: chain ran on the server", served.join(",") === "/a/1,/b/n1" && browserServed.length === 0, `server=${served} browser=${browserServed}`);
check("guarded: the finally's function local ran AT HOME", cancelled === 1, String(cancelled));
check("guarded: one crossing", counts.resume === 1 && !counts.exec, JSON.stringify(counts));

// ---- 4. a prototyped argument keeps its identity across the round trip ------------------
reset();
class Model { tag(v: unknown) { return { by: this, v }; } }
const m = new Model();
const v4: any = await bhost.runLocal(peer, "Svc$withModel", [new mod.Svc({}), m], migrate);
check("withModel: prototype method ran on the SAME object", v4 && v4.by === m && v4.v === "got:n9", JSON.stringify({ same: v4?.by === m, v: v4?.v }));

// ---- 5. a server-side http error unwinds into the compiled catch over there -------------
reset();
const v5 = await bhost.runLocal(peer, "Svc$caught", [new mod.Svc({})], migrate);
check("caught: compiled catch saw the server-side error", v5 === "caught:nope", String(v5));
check("caught: handled without coming home mid-flight", counts.resume === 1 && !counts.exec, JSON.stringify(counts));

// ---- 6. the fetch arm is untouched: same methods, no migrate opt ------------------------
reset();
const self6 = new mod.Svc({});
const v6 = await bhost.runLocal(peer, "Svc$chain", [self6, 7], {});
check("fetch arm still works (no migrate opt)", v6 === "got:n7", String(v6));
check("fetch arm: TWO exec crossings, no resume — the stack stayed home", counts.exec === 2 && !counts.resume, JSON.stringify(counts));

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\na chain migrates in one crossing; the stop rule, identity, and unwind hold");
