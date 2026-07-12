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
import { makeHost, batchExec, execOver } from "tierless";
import { makePeer, encodeMessage, decodeMessage, type Port } from "tierless/transport";
import { memorySink, buildProfile, loadProfile, methodMigrate } from "tierless/trace";
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
  async boom() {
    const r = await this.http.get("/boom");
    return r.body;
  }
  syncBoom() { throw new Error("sync-nope"); }
  mutateBoom() { this.hits = (this.hits || 0) + 1; throw new Error("after-mutate"); }
  dropMark() { delete this.tempThing; this.dropped = true; return "ok"; }
  get evilGetter() { throw new Error("getter-nope"); }
  async pushThing() {
    const r = await this.http.get("/things");
    this.items = this.items || [];
    this.items.push(r.body[0]);
    return this.items.length;
  }
}
export class Store {
  constructor(svc) { this.svc = svc; }
  async flow(id) {
    const svc = this.svc;
    const a = await svc.chain(id);
    const b = await svc.getAllish();
    return a + ":" + b.length;
  }
  async guardedDyn() {
    const svc = this.svc;
    try {
      await svc.syncBoom();
      return "unreachable";
    } catch (e) {
      return "caught:" + e.message;
    }
  }
  async guardedGetter() {
    const svc = this.svc;
    try {
      await svc.evilGetter();
      return "unreachable";
    } catch (e) {
      return "caught:" + e.message;
    }
  }
  async flowPush(id) {
    const svc = this.svc;
    await svc.chain(id);
    return await svc.pushThing();
  }
  async flowMutateBoom(id) {
    const svc = this.svc;
    await svc.chain(id);
    return await svc.mutateBoom();
  }
  async flowDrop(id) {
    const svc = this.svc;
    await svc.chain(id);
    return await svc.dropMark();
  }
}`;

const { code, meta } = compile(SRC, { resources: { "this.http": "server" }, filename: "svc.js" });
check("all tier-calling methods compiled (store methods suspend on METHOD calls only)", meta.methods.filter((m: any) => !m.error).length >= 9, JSON.stringify(meta.methods.length));

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

// ---- 7. slice 2: the profile decides — chains migrate, single calls stay on fetch -------
// PROFILING pass (run protocol): the fetch arm runs traced; runLocal now records every
// serviced park at its (fn, pc, resource) site plus the end marker, so buildProfile sees
// complete method runs and their same-tier suffixes.
const { sink, records } = memorySink();
const thost = makeHost({ bundle, tier: "browser", exec: browserExec as never, trace: { rate: 1, sink } });
for (let i = 0; i < 3; i++) {
  await thost.runLocal(peer, "Svc$chain", [new mod.Svc({}), i], {});
  await thost.runLocal(peer, "Svc$getAllish", [new mod.Svc({})], {});
}
const profile = loadProfile(buildProfile(records, mod.BUNDLE_HASH), mod.BUNDLE_HASH);
check("profiling fetch runs produced a valid profile", !!profile && profile.runs.complete === 6, JSON.stringify(profile?.runs));

// COMPARISON pass: the locked profile drives migrate — no racing, no exploration
const mig = methodMigrate(profile);
reset();
const v7 = await bhost.runLocal(peer, "Svc$chain", [new mod.Svc({}), 7], { migrate: mig });
check("decide: the chain site migrates on profile evidence (one crossing)", v7 === "got:n7" && counts.resume === 1 && !counts.exec, JSON.stringify(counts));
reset();
const s8 = new mod.Svc({});
const v8 = await bhost.runLocal(peer, "Svc$getAllish", [s8], { migrate: mig });
check("decide: the single-call site stays on the fetch arm (no shipping to bounce home)", Array.isArray(v8) && s8.total === 42 && counts.exec === 1 && !counts.resume, JSON.stringify(counts));
check("decide: cold (no profile) never migrates", methodMigrate(null)({ name: "http.get" }, { fn: "Svc$chain", pc: 5 }) === false);

// ---- 8. slice 3: a STORE method chaining two service-method calls (docs/migrate-arm.md) --
// flow's parks are DYNAMIC (awaited member calls, no http.* of its own). Fetch arm: each
// service call runs as a nested machine at home, its http parks exec-carry — 3 crossings.
reset();
const st1 = new mod.Store(new mod.Svc({}));
const f1 = await bhost.runLocal(peer, "Store$flow", [st1, 7], {});
check("store flow, fetch arm: correct value, nested machines at home, 3 exec crossings", f1 === "got:n7:3" && counts.exec === 3 && !counts.resume, JSON.stringify(counts));

// migrate WITHOUT twins: the whole stack ships at the first http park; the class-stamped
// handle lets the SECOND service call dispatch as a machine ON THE SERVER; only
// getAllish's self-writing tail comes home — the 3-call store chain is ONE crossing.
reset();
const svc2 = new mod.Svc({});
const st2 = new mod.Store(svc2);
const f2 = await bhost.runLocal(peer, "Store$flow", [st2, 7], migrate);
check("store flow, migrate: one crossing for the whole chain", f2 === "got:n7:3" && counts.resume === 1 && !counts.exec, JSON.stringify(counts));
check("store flow, migrate: all three http calls served on the SERVER", served.join(",") === "/a/7,/b/n7,/things" && browserServed.length === 0, `server=${served}`);
check("store flow, migrate: the self-writing tail still hit the REAL instance at home", svc2.total === 42, String(svc2.total));

// migrate WITH a session twin: the server resolves the class-stamped handle to a LOCAL
// instance — the method runs for real over there (its own state, its own interceptors) —
// and the twin's state changes ride the reply home, applied to the LIVE browser instance
// before the awaiting code resumes: read-your-writes, no extra crossing.
reset();
const twinSvc = new mod.Svc({ get: (url: string) => serverExec({ name: "http.get", args: [url] }) });   // the twin's OWN http, server-local
const shostT = makeHost({ bundle, tier: "server", exec: serverExec as never, twins: (cls: string) => (cls === "Svc" ? twinSvc : undefined) });
const [bp2, sp2] = pair();
shostT.answer(makePeer(sp2));
const svc3 = new mod.Svc({});
const f3 = await bhost.runLocal(makePeer(bp2), "Store$flow", [new mod.Store(svc3), 7], migrate);
check("store flow, twin: one crossing, value correct", f3 === "got:n7:3" && counts.resume === 1 && !counts.exec, JSON.stringify({ counts, f3 }));
check("store flow, twin: write-back — the LIVE browser instance reads its writes", twinSvc.total === 42 && svc3.total === 42, JSON.stringify({ twin: twinSvc.total, browser: svc3.total }));

// ---- 9. burst coalescing: concurrent execs merge into ONE execBatch crossing ----------
// Reactive apps fire N independent runs in the same tick (N components mount, each
// parking at its own http.*). The batching peer (host.mts batchExec) holds exec frames
// for one timer turn and merges the burst; per-element results — including shaped
// errors — unwrap exactly as single execs, so each run's own catch sees its own failure.
reset();
const bpeer = batchExec(peer);
const [r1, r2, r3] = await Promise.all([
  bhost.runLocal(bpeer, "Svc$chain", [new mod.Svc({}), 1], {}),
  bhost.runLocal(bpeer, "Svc$caught", [new mod.Svc({})], {}),
  bhost.runLocal(bpeer, "Svc$chain", [new mod.Svc({}), 2], {}),
]);
check("burst: values correct, the failing element isolated in its own compiled catch", r1 === "got:n1" && r2 === "caught:nope" && r3 === "got:n2", JSON.stringify([r1, r2, r3]));
check("burst: each concurrent round is ONE execBatch, zero plain execs", counts.execBatch === 2 && !counts.exec && !counts.resume, JSON.stringify(counts));

// a lone request passes through as a plain exec — no batch framing, no protocol change
reset();
const lone = await bhost.runLocal(bpeer, "Svc$getAllish", [new mod.Svc({})], {});
check("lone exec passes through unbatched", Array.isArray(lone) && counts.exec === 1 && !counts.execBatch, JSON.stringify(counts));

// an UNCAUGHT batched failure rejects its own run with the full shaped error (message +
// response, axios-marked) while the sibling in the same batch completes untouched
reset();
const boomP = bhost.runLocal(bpeer, "Svc$boom", [new mod.Svc({})], {});
const okP = bhost.runLocal(bpeer, "Svc$chain", [new mod.Svc({}), 3], {});
const boomErr: any = await boomP.then(() => null, (e) => e);
const ok3 = await okP;
check("burst error: uncaught element rejects shaped, sibling completes", ok3 === "got:n3" && boomErr?.message === "nope" && boomErr?.response?.status === 400 && boomErr?.isAxiosError === true, JSON.stringify({ ok3, m: boomErr?.message, r: boomErr?.response }));
check("burst error: round 1 batched, the survivor's second call went alone", counts.execBatch === 1 && counts.exec === 1, JSON.stringify(counts));

// ---- 10. execOver: the fetch-arm crossing as a first-class op (the adapter path) -------
reset();
const ev: any = await execOver(peer, { op: "resource", tier: "server", name: "http.get", args: ["/things"] });
check("execOver: value crosses in one exec frame", ev?.body?.join(",") === "1,2,3" && counts.exec === 1 && !counts.resume, JSON.stringify({ ev, counts }));
const ee: any = await execOver(peer, { op: "resource", tier: "server", name: "http.get", args: ["/boom"] }).then(() => null, (e: unknown) => e);
check("execOver: error crosses SHAPED (message + response + axios mark)", ee?.message === "nope" && ee?.response?.status === 400 && ee?.isAxiosError === true, JSON.stringify({ m: ee?.message, r: ee?.response }));

// ---- 11. dyn park, SYNC throw: the thunk settles it into the compiled catch ------------
reset();
const v11 = await bhost.runLocal(peer, "Store$guardedDyn", [new mod.Store(new mod.Svc({}))], {});
check("dyn park: a synchronous member throw lands in the compiled catch", v11 === "caught:sync-nope", String(v11));

// ---- 12. twin write-back sees IN-PLACE mutations (items.push) ---------------------------
reset();
const twinSvc2 = new mod.Svc({ get: (url: string) => serverExec({ name: "http.get", args: [url] }) });
const shostT2 = makeHost({ bundle, tier: "server", exec: serverExec as never, twins: (cls: string) => (cls === "Svc" ? twinSvc2 : undefined) });
const [bp3, sp3] = pair();
shostT2.answer(makePeer(sp3));
const svc4 = new mod.Svc({});
const n12 = await bhost.runLocal(makePeer(bp3), "Store$flowPush", [new mod.Store(svc4), 7], migrate);
check("twin write-back: in-place array mutation ships home", n12 === 1 && Array.isArray((svc4 as any).items) && (svc4 as any).items.length === 1, JSON.stringify({ n12, items: (svc4 as any).items }));

// ---- 13. twin throw AFTER mutation: the delta still ships home on the error reply ------
// plain JS keeps mutations made before a throw; the error reply carries the twin diff
// and the home tier applies it before rethrowing — state converges even when the call fails
reset();
const twinSvc3 = new mod.Svc({ get: (url: string) => serverExec({ name: "http.get", args: [url] }) });
const shostT3 = makeHost({ bundle, tier: "server", exec: serverExec as never, twins: (cls: string) => (cls === "Svc" ? twinSvc3 : undefined) });
const [bp4, sp4] = pair();
shostT3.answer(makePeer(sp4));
const svc5 = new mod.Svc({});
const err13: any = await bhost.runLocal(makePeer(bp4), "Store$flowMutateBoom", [new mod.Store(svc5), 7], migrate).then(() => null, (e: unknown) => e);
check("twin throw after mutation: the error still propagates home", err13?.message === "after-mutate", String(err13?.message));
check("twin throw after mutation: the pre-throw mutation ships home on the error reply", (svc5 as any).hits === 1 && (twinSvc3 as any).hits === 1, JSON.stringify({ home: (svc5 as any).hits, twin: (twinSvc3 as any).hits }));

// ---- 11b. dyn park, THROWING GETTER: the lookup itself unwinds into the compiled catch --
reset();
const v11b = await bhost.runLocal(peer, "Store$guardedGetter", [new mod.Store(new mod.Svc({}))], {});
check("dyn park: a throwing member GETTER lands in the compiled catch", v11b === "caught:getter-nope", String(v11b));

// ---- 14. twin field DELETION ships home (assignment can't express removal) --------------
reset();
const twinSvc4 = new mod.Svc({ get: (url: string) => serverExec({ name: "http.get", args: [url] }) });
(twinSvc4 as any).tempThing = "x";
const shostT4 = makeHost({ bundle, tier: "server", exec: serverExec as never, twins: (cls: string) => (cls === "Svc" ? twinSvc4 : undefined) });
const [bp5, sp5] = pair();
shostT4.answer(makePeer(sp5));
const svc6 = new mod.Svc({});
(svc6 as any).tempThing = "x";
const v14 = await bhost.runLocal(makePeer(bp5), "Store$flowDrop", [new mod.Store(svc6), 7], migrate);
check("twin deletion: the deleted field is gone from the live home instance", v14 === "ok" && !("tempThing" in svc6) && (svc6 as any).dropped === true, JSON.stringify({ v14, has: "tempThing" in svc6, dropped: (svc6 as any).dropped }));

// ---- 15. dyn park with NO meaning at the server (no twin, no machine): the park carries
// the call home and the owner runs it on the LIVE instance — the frame's pc is already
// past the park, so without re-dispatch the resume would read a stale ret ---------------
reset();
const shostNT = makeHost({ bundle, tier: "server", exec: serverExec as never });   // NO twins registry
const [bp6, sp6] = pair();
shostNT.answer(makePeer(sp6));
const svc7 = new mod.Svc({});
(svc7 as any).tempThing = "x";
const v15 = await bhost.runLocal(makePeer(bp6), "Store$flowDrop", [new mod.Store(svc7), 7], migrate);
check("dyn home park: the uncompiled method ran on the LIVE home instance, value correct", v15 === "ok" && (svc7 as any).dropped === true && !("tempThing" in svc7), JSON.stringify({ v15, dropped: (svc7 as any).dropped, has: "tempThing" in svc7 }));

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\na chain migrates in one crossing; the stop rule, identity, and unwind hold; the profile decides");
