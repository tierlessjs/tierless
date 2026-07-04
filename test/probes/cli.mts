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
writeFileSync(join(dir, "svc.mjs"), `
import { defineApi, PUBLIC } from ${JSON.stringify(pathToFileURL(join(SRC, "api/api.mjs")).href)};
export default defineApi({ ping: { authorize: PUBLIC, run: () => "pong" }, drop: { authorize: (p) => p != null, run: () => 1 } });
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
check("types emits the declare-const-api surface", ty.status === 0 && ty.stdout.includes("declare const api") && ty.stdout.includes("ping(...args: any[]): any;") && ty.stdout.includes("authorize: per-call"), ty.stdout.split("\n")[1]);
const tyOut = run(["types", join(dir, "svc.mjs"), join(dir, "api.d.ts")]);
check("types writes a file when given a target", tyOut.status === 0 && tyOut.stdout.includes("wrote"), tyOut.stdout);

// ---- usage ------------------------------------------------------------------------------
const u = run([]);
check("bare invocation prints usage and exits 0", u.status === 0 && (u.stdout + u.stderr).includes("tierless build"), u.status);

const { pass, fail } = counts();
const ok = fail === 0;
console.log(ok
  ? `\nOK — the tierless CLI works end to end: build (custom resources), explain (the analysis made visible), api (load-time pre-ship check), types (the api surface as a declaration) (${pass} checks)`
  : `\nFAILED (${pass} passed, ${fail} failed)`);
process.exit(ok ? 0 : 1);
