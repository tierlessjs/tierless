// Probe: the tierless CLI — the four subcommands against real fixtures.
//   build    compiles a module to a runnable bundle (custom resources included)
//   explain  prints the suspendability analysis with real line numbers
//   api      pre-ship check: lists the authorized surface; an endpoint with NO authorize
//            fails at load time with the monitor's own message
//   types    emits a declare-const-api surface from the service's registered endpoints
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeCounter } from "../lib/check.mts";
import type { Frame } from "tierless/runtime";

const BIN = fileURLToPath(new URL("../../packages/tierless/bin/tierless.mjs", import.meta.url));
const SRC = fileURLToPath(new URL("../../packages/tierless/src/", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "cli-"));
const { check, counts } = makeCounter();
const run = (args: string[]) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });

console.log("Probe: the tierless CLI — build / explain / api / types\n");

// ---- build (with a custom resource) ---------------------------------------------------
writeFileSync(join(dir, "flow.js"), 'function go(x) { const r = db.get(x); return r + 1; }\n');
const b = run(["build", join(dir, "flow.js"), join(dir, "flow.gen.mjs"), "--bare", "--resource=db:server"]);
check("build compiles a module", b.status === 0 && b.stdout.includes("wrote"), b.stderr);
// compiler output generated at test time — no static declaration to check against
const mod: any = await import(pathToFileURL(join(dir, "flow.gen.mjs")).href);
const F: Frame = { fn: "go", pc: 0, args: [4] };
const req = mod.PROGRAMS.go(F);
check("the built machine runs and pins the custom namespace", req.op === "resource" && req.name === "db.get" && req.tier === "server", req);

// ---- explain ----------------------------------------------------------------------------
writeFileSync(join(dir, "acts.js"), '"use tierless";\nexport function fetchAll(xs) { let s = 0; for (const x of xs) { const r = api.get(x); s = s + r; } return s; }\nfunction helper(x) { const r = api.get(x); return r; }\nexport function via(x) { const r = helper(x); return r; }\nexport function pure(x) { return x + 1; }\n');
const e = run(["explain", join(dir, "acts.js")]);
check("explain marks compiled fns with their resource touches", e.status === 0 && e.stdout.includes("fetchAll (exported) — compiled") && e.stdout.includes("api.get → server tier"), e.stdout.split("\n")[2]);
check("explain shows real line numbers", /line 2: api\.get/.test(e.stdout), (e.stdout.match(/line \d+/) || [])[0]);
check("explain shows the transitive path and the pure fn", e.stdout.includes("calls suspendable helper") && e.stdout.includes("pure (exported) — pure"), undefined);
check("explain totals", e.stdout.includes("3 compiled, 1 pure."), undefined);
const ej = run(["explain", join(dir, "acts.js"), "--json"]);
const rep = ej.status === 0 ? JSON.parse(ej.stdout) : null;
check("explain --json emits the machine-readable report (for agents/tooling)",
  rep !== null && rep.functions.some((f: any) => f.name === "fetchAll" && f.suspendable && f.suspensions[0].name === "api.get"), rep && rep.functions.length);
// explain must reject exactly what build rejects — a tier call in a callback — cleanly, not report it compilable
writeFileSync(join(dir, "callback.js"), "export function A(xs) { return xs.map(x => api.get(x)); }\n");
const cbBad = run(["explain", join(dir, "callback.js")]);
const cbOut = cbBad.stderr + cbBad.stdout;
check("explain rejects a callback tier-call cleanly (clear message, non-zero, no V8 stack)",
  cbBad.status !== 0 && cbOut.includes("inside a nested function / callback is not supported") && !/\n\s+at /.test(cbOut), cbOut.split("\n")[0]);

// ---- api (pre-ship check) ---------------------------------------------------------------
// svc.mjs covers every run-signature style `tierless types` reads: zero-arg (ping/drop),
// destructured with default + rest (send), the raw-args style it must NOT guess at (raw),
// an async run (stamp — the monitor awaits, so the caller sees the resolved value), a
// structural object return (pair), and a service-local class a standalone d.ts can't
// express (make — must downgrade to any, not emit a broken declaration).
writeFileSync(join(dir, "svc.mjs"), `
import { defineApi, PUBLIC } from ${JSON.stringify(pathToFileURL(join(SRC, "api/api.mjs")).href)};
class Store { x = 1 }
export default defineApi({
  ping: { authorize: PUBLIC, run: () => "pong" },
  drop: { authorize: (p) => p != null, run: () => 1 },
  send: { authorize: (p) => p != null, run: ([to, msg, n = 1, ...tags], p) => tags.length + n },
  raw:  { authorize: PUBLIC, run: (args) => args.length },
  stamp: { authorize: PUBLIC, run: async () => 42 },
  pair: { authorize: PUBLIC, run: ([a, b]) => ({ a, b, when: "now" }) },
  make: { authorize: PUBLIC, run: () => new Store() },
});
`);
const a = run(["api", join(dir, "svc.mjs")]);
check("api lists the surface with authorization kinds", a.status === 0 && a.stdout.includes("PUBLIC   ping") && a.stdout.includes("per-call drop") && a.stdout.includes("the service ships"), a.stdout);

writeFileSync(join(dir, "bad.mjs"), `
import { defineApi, PUBLIC } from ${JSON.stringify(pathToFileURL(join(SRC, "api/api.mjs")).href)};
export default defineApi({ leak: { run: () => 42 } });
`);
const bad = run(["api", join(dir, "bad.mjs")]);
check("an endpoint with no authorize FAILS the pre-ship check at load time", bad.status !== 0 && (bad.stderr + bad.stdout).includes("authorize is required"), (bad.stderr || "").split("\n")[0]);

// ---- types ------------------------------------------------------------------------------
const ty = run(["types", join(dir, "svc.mjs")]);
check("types emits the declare-const-api surface", ty.status === 0 && ty.stdout.includes("declare const api") && ty.stdout.includes("authorize: per-call"), ty.stdout.split("\n")[1]);
check("a zero-arg run emits a zero-arg endpoint with its INFERRED return type", ty.stdout.includes("ping(): string;"), ty.stdout.split("\n").find((l) => l.includes("ping")));
check("a destructured run emits its real names, default -> optional, rest -> variadic", ty.stdout.includes("send(to: any, msg: any, n?: any, ...tags: any[]):"), ty.stdout.split("\n").find((l) => l.includes("send")));
check("a raw-args run falls back to (...args: any[]) rather than a guessed signature", ty.stdout.includes("raw(...args: any[]):"), ty.stdout.split("\n").find((l) => l.includes("raw")));
check("an async run's return unwraps the Promise — the monitor awaits before answering", ty.stdout.includes("stamp(): number;"), ty.stdout.split("\n").find((l) => l.includes("stamp")));
check("a structural object return is emitted in full", /pair\(a: any, b: any\): \{ .*when: string.* \};/.test(ty.stdout), ty.stdout.split("\n").find((l) => l.includes("pair")));
check("a return naming a service-local class downgrades to any — never a broken declaration", ty.stdout.includes("make(): any;") && !ty.stdout.includes("Store"), ty.stdout.split("\n").find((l) => l.includes("make")));
const tyOut = run(["types", join(dir, "svc.mjs"), join(dir, "api.d.ts")]);
check("types writes a file when given a target", tyOut.status === 0 && tyOut.stdout.includes("wrote"), tyOut.stdout);
// the emitted declaration is load-bearing: a correct call type-checks; a wrong-arity call
// and a wrong RETURN-type use both FAIL
writeFileSync(join(dir, "use-ok.ts"), `/// <reference path="./api.d.ts" />\napi.send("a", "b");\napi.send("a", "b", 2, "t1", "t2");\nconst s: string = api.ping();\nconst n: number = api.stamp();\nconst w: string = api.pair(1, 2).when;\n`);
writeFileSync(join(dir, "use-bad.ts"), `/// <reference path="./api.d.ts" />\napi.send("only-one-arg");\n`);
writeFileSync(join(dir, "use-bad-ret.ts"), `/// <reference path="./api.d.ts" />\nconst n: number = api.ping();\n`);
const tscJs = fileURLToPath(new URL("../../node_modules/typescript/bin/tsc", import.meta.url));   // spawn via node, same as types.mts
const tOk = spawnSync(process.execPath, [tscJs, "--noEmit", "--strict", join(dir, "use-ok.ts")], { encoding: "utf8" as const });
const tBad = spawnSync(process.execPath, [tscJs, "--noEmit", "--strict", join(dir, "use-bad.ts")], { encoding: "utf8" as const });
const tBadRet = spawnSync(process.execPath, [tscJs, "--noEmit", "--strict", join(dir, "use-bad-ret.ts")], { encoding: "utf8" as const });
check("a correct call against the emitted surface type-checks (return types included)", tOk.status === 0, (tOk.stdout || "").split("\n")[0]);
check("a wrong-arity call against the emitted surface is REJECTED", tBad.status !== 0 && (tBad.stdout || "").includes("error TS"), tBad.status);
check("misusing a RETURN value is REJECTED — impossible when returns were any", tBadRet.status !== 0 && (tBadRet.stdout || "").includes("TS2322"), (tBadRet.stdout || "").split("\n")[0]);

// ---- usage ------------------------------------------------------------------------------
const u = run([]);
check("bare invocation prints usage and exits 0", u.status === 0 && (u.stdout + u.stderr).includes("tierless build"), u.status);

const { pass, fail } = counts();
const ok = fail === 0;
console.log(ok
  ? `\nOK — the tierless CLI works end to end: build (custom resources), explain (the analysis made visible), api (load-time pre-ship check), types (the api surface as a declaration) (${pass} checks)`
  : `\nFAILED (${pass} passed, ${fail} failed)`);
process.exit(ok ? 0 : 1);
