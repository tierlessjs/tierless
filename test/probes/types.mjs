// Probe: the TypeScript surface. Every public entry ships a hand-written .d.ts wired
// through the exports map. tsc type-checks a consumer fixture that exercises the main
// surfaces — and a deliberate misuse must FAIL, proving the types are load-bearing
// rather than any-soup.
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { makeCounter } from "../lib/check.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const dir = join(ROOT, "test", ".types-fixture");
mkdirSync(dir, { recursive: true });
const { check, counts } = makeCounter();
const tsc = (files) => spawnSync(process.execPath, [join(ROOT, "node_modules/typescript/bin/tsc"),
  "--noEmit", "--strict", "--module", "nodenext", "--moduleResolution", "nodenext", "--target", "es2022",
  "--types", "node", ...files], { cwd: ROOT, encoding: "utf8" });

console.log("Probe: the TypeScript surface — every entry typed through the exports map\n");

writeFileSync(join(dir, "ok.ts"), `
import { makeHost, answerWith, type Bundle } from "tierless";
import { makePump, initialStack } from "tierless/runtime";
import { attachTierless, serveApp, WS_PATH } from "tierless/server";
import { connect, bindActions, configureTierless } from "tierless/browser";
import { useAction } from "tierless/react";
import tierlessPlugin from "tierless/vite";
import { defineApi, PUBLIC, DENY, JwtApi, startSidecar, makeApiExec, sidecarMain } from "tierless/api";
import { compile, analyze, DEFAULT_RESOURCES } from "tierless/compiler";
import { encodeWireBinary, decodeWireBinary } from "tierless/wire";
import { makePeer, wsPort, onEvent, encodeMessage, decodeMessage } from "tierless/transport";
import { encodeGraph, decodeGraph, isHandle, approxExceeds, GLOBALS } from "tierless/graph";
import { hashOf, ContentStore, newPeerView } from "tierless/content";
import { Heap, Channel } from "tierless/fetch";
import {
  makeDeltaSession, encodeDelta, applyDelta,
  makeTrackedSession, touch, planDelta, encodeDeltaTracked, applyDeltaTracked,
  adoptBaseline, subForFullWire, exciseForCapture,
  openSnapshot, diffSnapshot, wholeSnapshot, applySnapshot,
} from "tierless/delta";
import { makeTier, encodeWire, decodeWire, wireHandles, writeBack, commitWrite, makeCoherentHost } from "tierless/heap";

const bundle: Bundle = { PROGRAMS: {}, __unwind: () => false };
const pump = makePump(bundle);
void pump(initialStack("App"), (t) => t === "server", async () => 1);
const host = makeHost({ bundle, tier: "server", exec: () => 0 });
void host.call;
void answerWith; void attachTierless; void serveApp; void WS_PATH;
const conn = connect({ url: "ws://x", bundle });
void conn.call("f", [1]);
void bindActions(bundle, { module: "m" }); void configureTierless({});
const a = useAction((x: number) => Promise.resolve(x + 1));
void a.run(2); const r: boolean = a.running; void r;
const plugin = tierlessPlugin({ api: "./api.server.mjs" });
void plugin.transform("code", "id");
const def = defineApi((api) => ({
  login: { authorize: PUBLIC, run: () => api.issue({ sub: "u" }, 60) },
  drop: { authorize: DENY, run: () => 1 },
  add: { authorize: (p) => p != null, run: (args, p) => p && p.sub },
}), { maxArgsBytes: 1024 });
const j: JwtApi = def.create("secret");
void j.fns(); void startSidecar; void makeApiExec; void sidecarMain;
const { code, meta } = compile("function f(){}", { resources: { db: "server" } });
void code; void meta.exported;
void analyze("function f(){}"); void DEFAULT_RESOURCES.api;
const wbin = encodeWireBinary([{ fn: "F", pc: 0, x: 1 }], { op: "start", tier: "server", name: "x", args: [1] });   // op:"start", not "resource" — must NOT require the ResourceRequest literal
const wbout = decodeWireBinary(wbin);
void wbout.stack;
if (wbout.request && wbout.request.op === "start") void 0;   // only compiles if request.op is string, not pinned to the "resource" literal
const msgBytes = encodeMessage({ hello: 1 }, new Uint8Array([1, 2]));
void decodeMessage(msgBytes).obj;
const port = wsPort({ binaryType: "", send() {}, close() {}, on() {} });
void port.onMessage(() => {});
const rpcPeer = makePeer(port);
void rpcPeer.request({ a: 1 });
onEvent({ on: () => {} }, "open", () => {});   // was entirely missing from the old hand-written .d.ts
const g = encodeGraph([1, { a: 1 }]);
const back = decodeGraph(g);
void isHandle(back[0]); void approxExceeds(back, 1000);
const mathRef = GLOBALS.Math;   // only compiles if GLOBALS is the real object literal, not Map<string, unknown>
void mathRef;
const store = new ContentStore();
const h = store.register({ a: 1 });
void store.get(h); void store.has(h); void store.hashFor({ a: 1 });
const peer = newPeerView(); peer.add(h);   // 0-arg factory returning a Set, not newPeerView(store)
void hashOf({ a: 1 });
const heap = new Heap("t1");
const handle = heap.put({ a: 1 }); void heap.get(handle.id); void heap.version(handle.id);
void new Channel({ t1: { heap } });
const dA = makeDeltaSession("server");
const dStack = [{ fn: "F", pc: 0, x: 1 }];
const denc = encodeDelta(dA, dStack, null);
void applyDelta(makeDeltaSession("z"), denc.bytes);
const dB = makeTrackedSession("browser");
const tenc = encodeDeltaTracked(dB, dStack, null, { exact: true });
void applyDeltaTracked(makeTrackedSession("z"), tenc.bytes);
void touch(dB, { n: 1 }, dStack[0]);          // variadic — must accept 2+ objects, not just 1
adoptBaseline(dB, dStack, null);
planDelta(dB, dStack, null).commit();
const rebuilt = subForFullWire(dB, dStack, null);
void rebuilt.stack; void rebuilt.request;
exciseForCapture(dB, dStack, null, { id: "server", heapPut: () => "h1" }, 1024);
const snap = openSnapshot("server", { a: 1 });
void diffSnapshot(snap, { a: 2 }).byteLength;
const wholeBytes = wholeSnapshot("server", { a: 1 });
void applySnapshot("server", { a: 1 }, wholeBytes);
const hTier = makeTier("server");
const hWire = encodeWire(dStack, null, { tier: hTier, threshold: 8192 });
const hDecoded = decodeWire(hWire);
void hDecoded.stack; void hDecoded.request;
const hHandles = wireHandles(hWire); if (hHandles.length) void hHandles[0].owner;
const hHandle = hTier.heap.put({ big: true });
const wb = writeBack(hTier.heap, hHandle.id, hTier.heap.version(hHandle.id), { big: false });
void wb.ok; void wb.version;
const hChannel = new Channel({ [hTier.id]: { heap: hTier.heap } });
const cw = commitWrite(hChannel, hHandle, (copy) => { void copy; }, { tries: 3 });
void cw.ok; void cw.tries;
const chost = makeCoherentHost(hTier, hChannel);
void chost.stats.fetches; void chost.deref(hHandle); void chost.writeBack({});
`);
const ok = tsc([join("test", ".types-fixture", "ok.ts")]);
check("a consumer exercising every main entry type-checks under --strict", ok.status === 0, (ok.stdout || "").split("\n").slice(0, 3).join(" | "));

writeFileSync(join(dir, "bad.ts"), `
import { useAction } from "tierless/react";
import { defineApi, PUBLIC } from "tierless/api";
import { ContentStore } from "tierless/content";
import { Heap } from "tierless/fetch";
import { exciseForCapture, makeTrackedSession } from "tierless/delta";
import { makeTier } from "tierless/heap";
useAction("not a function");
defineApi({ leak: { authorize: PUBLIC, run: () => 1, extra: true } });
new ContentStore().resolve("x");   // no such method — the real one is get(); this must fail, not silently pass
new Heap(42);                      // the real constructor takes a string tierId
exciseForCapture(makeTrackedSession("x"), [{ fn: "F", pc: 0 }], null);   // missing the required tier argument (4th) — no default
makeTier("server", {});            // the real function takes 1 argument (id); there is no options param
`);
const bad = tsc([join("test", ".types-fixture", "bad.ts")]);
check("deliberate misuse FAILS to type-check (the types are load-bearing)", bad.status !== 0 && (bad.stdout || "").includes("error TS"), bad.status);

const { pass, fail } = counts();
const okAll = fail === 0;
console.log(okAll
  ? `\nOK — the public surface is typed end to end: every exports-map entry resolves a declaration under strict nodenext, and misuse is rejected (${pass} checks)`
  : `\nFAILED (${pass} passed, ${fail} failed)`);
process.exit(okAll ? 0 : 1);
