// Probe: the TypeScript surface. Every public entry ships a hand-written .d.ts wired
// through the exports map. tsc type-checks a consumer fixture that exercises the main
// surfaces — and a deliberate misuse must FAIL, proving the types are load-bearing
// rather than any-soup.
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const dir = join(ROOT, "test", ".types-fixture");
mkdirSync(dir, { recursive: true });
let pass = 0, fail = 0;
const check = (label, cond, got) => { if (cond) { pass++; console.log(`  PASS  ${label}`); } else { fail++; console.log(`  FAIL  ${label}${got === undefined ? "" : `  (got ${JSON.stringify(got)})`}`); } };
const tsc = (files) => spawnSync(process.execPath, [join(ROOT, "node_modules/typescript/bin/tsc"),
  "--noEmit", "--strict", "--module", "nodenext", "--moduleResolution", "nodenext", "--target", "es2022",
  "--types", "node", ...files], { cwd: ROOT, encoding: "utf8" });

console.log("Probe: the TypeScript surface — every entry typed through the exports map\n");

writeFileSync(join(dir, "ok.ts"), `
import { makeHost, answerWith, type Bundle } from "stackmix";
import { makePump, initialStack } from "stackmix/runtime";
import { attachStackmix, serveApp, WS_PATH } from "stackmix/server";
import { connect, bindActions, configureStackmix } from "stackmix/browser";
import { useAction } from "stackmix/react";
import stackmixPlugin from "stackmix/vite";
import { defineApi, PUBLIC, DENY, JwtApi, startSidecar, makeApiExec, sidecarMain } from "stackmix/api";
import { compile, analyze, DEFAULT_RESOURCES } from "stackmix/compiler";
import { encodeWireBinary, decodeWireBinary } from "stackmix/wire";
import { makePeer, wsPort } from "stackmix/transport";

const bundle: Bundle = { PROGRAMS: {}, __unwind: () => false };
const pump = makePump(bundle);
void pump(initialStack("App"), (t) => t === "server", async () => 1);
const host = makeHost({ bundle, tier: "server", exec: () => 0 });
void host.call;
void answerWith; void attachStackmix; void serveApp; void WS_PATH;
const conn = connect({ url: "ws://x", bundle });
void conn.call("f", [1]);
void bindActions(bundle, { module: "m" }); void configureStackmix({});
const a = useAction((x: number) => Promise.resolve(x + 1));
void a.run(2); const r: boolean = a.running; void r;
const plugin = stackmixPlugin({ api: "./api.server.mjs" });
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
void encodeWireBinary; void decodeWireBinary; void makePeer; void wsPort;
`);
const ok = tsc([join("test", ".types-fixture", "ok.ts")]);
check("a consumer exercising every main entry type-checks under --strict", ok.status === 0, (ok.stdout || "").split("\n").slice(0, 3).join(" | "));

writeFileSync(join(dir, "bad.ts"), `
import { useAction } from "stackmix/react";
import { defineApi, PUBLIC } from "stackmix/api";
useAction("not a function");
defineApi({ leak: { authorize: PUBLIC, run: () => 1, extra: true } });
`);
const bad = tsc([join("test", ".types-fixture", "bad.ts")]);
check("deliberate misuse FAILS to type-check (the types are load-bearing)", bad.status !== 0 && (bad.stdout || "").includes("error TS"), bad.status);

const okAll = fail === 0;
console.log(okAll
  ? `\nOK — the public surface is typed end to end: every exports-map entry resolves a hand-written declaration under strict nodenext, and misuse is rejected (${pass} checks)`
  : `\nFAILED (${pass} passed, ${fail} failed)`);
process.exit(okAll ? 0 : 1);
