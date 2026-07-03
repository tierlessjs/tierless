// Probe: the compiler as a LIBRARY — require("transform.cjs") gives compile()/analyze(),
// the allow-list is configurable (opts.resources / --resource=ns:tier), and a real module
// shape compiles: `export function` becomes a named PROGRAM (the actions surface), imports
// and top-level state are preserved, pure exported helpers stay exported. This is the
// surface the Vite plugin and the tierless CLI build on.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeCounter } from "../lib/check.mts";
import type Transform = require("../../packages/tierless/types/compiler.cjs");
type FunctionReport = ReturnType<(typeof Transform)["analyze"]>["functions"][number];

const require = createRequire(import.meta.url);
// transform.cjs stays CommonJS (own conversion pass — see ROADMAP); require() through
// createRequire is untyped at the call site, so pin it to the real declared signature.
const { compile, analyze, DEFAULT_RESOURCES } = require("../../packages/tierless/src/transform.cjs") as
  { compile: (typeof Transform)["compile"]; analyze: (typeof Transform)["analyze"]; DEFAULT_RESOURCES: (typeof Transform)["DEFAULT_RESOURCES"] };
const TX = fileURLToPath(new URL("../../packages/tierless/src/transform.cjs", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "capi-"));

const { check, counts } = makeCounter();

const drive = (mod: any, entry: string, args: unknown[], exec: (r: any) => unknown): unknown => {
  const stack = [{ fn: entry, pc: 0, args }];
  for (let i = 0; i < 10000; i++) {
    const top = stack[stack.length - 1] as any;
    const r = mod.PROGRAMS[top.fn](top);
    if (r.op === "return") { stack.pop(); if (!stack.length) return r.value; (stack[stack.length - 1] as any).ret = r.value; }
    else if (r.op === "call") stack.push({ fn: r.fn, pc: 0, args: r.args });
    else if (r.op === "throw") throw r.value;
    else top.ret = exec(r);
  }
  throw new Error("did not terminate");
};

console.log("Probe: the compiler as a library — compile()/analyze(), configurable resources, module shapes\n");

// ---- a real "use tierless" module: exports, imports, top-level state, a custom resource ----
const SRC = `"use tierless";
import { helper } from "./helper.mjs";
const RATE = 3;
export function quote(x) { const q = db.lookup(x); return helper(q) * RATE; }
export function fmt(v) { return "$" + v; }
function inner(x) { const r = db.lookup(x); return r + 1; }
export function outer(x) { const r = inner(x); return r; }
`;
const { code, meta } = compile(SRC, { resources: { db: "server" }, filename: "quote.mjs" });

check("exported suspendable fns compile to PROGRAMS", meta.programs.includes("quote") && meta.programs.includes("outer") && meta.programs.includes("inner"), meta.programs);
check("meta.exported lists the module's action surface (not the private helper)", meta.exported.includes("quote") && meta.exported.includes("outer") && !meta.exported.includes("inner"), meta.exported);
check("a pure exported helper passes through, still exported", meta.pure.includes("fmt") && code.includes("export function fmt"), meta.pure);
check("imports and top-level state are preserved in the output", code.includes('import { helper } from "./helper.mjs"') && code.includes("const RATE = 3"));
check("the custom db.* namespace compiled to server-tier suspensions", code.includes('"db.lookup"') && code.includes('"server"'));

// run it: write the module + its import next to each other
writeFileSync(join(dir, "helper.mjs"), "export const helper = (x) => x + 100;\n");
writeFileSync(join(dir, "quote.gen.mjs"), code);
const mod = await import(pathToFileURL(join(dir, "quote.gen.mjs")).href);
const v = drive(mod, "quote", [7], (r) => { if (r.name !== "db.lookup" || r.tier !== "server") throw new Error("bad request " + r.name); return r.args[0] * 2; });
check("the compiled module runs: import + top-level const + custom resource all live", v === (7 * 2 + 100) * 3, v);
const o = drive(mod, "outer", [5], (r) => r.args[0] * 2);
check("an exported fn calling a private suspendable helper pushes a sub-frame", o === 11, o);

// ---- analyze(): the suspendability report (what `tierless explain` prints) -------------
const rep = analyze(SRC, { resources: { db: "server" } });
const by: Record<string, FunctionReport> = Object.fromEntries(rep.functions.map((f) => [f.name, f]));
check("analyze marks direct resource touches", by.quote.suspendable && by.quote.direct && by.quote.suspensions.some((s) => s.name === "db.lookup" && s.tier === "server"));
check("analyze marks transitive suspendability with the path", by.outer.suspendable && !by.outer.direct && by.outer.callsSuspendable.includes("inner"));
check("analyze marks pure fns", by.fmt.suspendable === false);
check("analyze reports the effective resource map", rep.resources.db === "server" && rep.resources.api === "server", rep.resources);
check("defaults still exported for callers", DEFAULT_RESOURCES.api === "server" && DEFAULT_RESOURCES.commit === "browser");

// ---- the CLI flag drives the same thing --------------------------------------------
writeFileSync(join(dir, "cli.src.js"), "function go(x) { const r = db.get(x); return r; }");
execFileSync(process.execPath, [TX, join(dir, "cli.src.js"), join(dir, "cli.gen.mjs"), "--bare", "--resource=db:server"]);
const cli = await import(pathToFileURL(join(dir, "cli.gen.mjs")).href);
const cv = drive(cli, "go", [4], (r) => r.args[0] + 1);
check("--resource=db:server pins a custom namespace from the CLI", cv === 5, cv);

const { pass, fail } = counts();
const ok = fail === 0;
console.log(ok
  ? `\nOK — the compiler is an importable library: configurable resources, module-shaped input (exports/imports/state preserved), and an analyze() report (${pass} checks)`
  : `\nFAILED (${pass} passed, ${fail} failed)`);
process.exit(ok ? 0 : 1);
