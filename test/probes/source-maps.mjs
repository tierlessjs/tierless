// Probe: --source-map. The compiled machine is a `switch (F.pc)`; a migrated continuation is just
// frames `{ fn, pc }`, which says nothing about WHERE in the source it is. With --source-map the
// transform stamps each block with the line of the statement it lowered and emits a per-program pc->line
// table plus a `frameSite` helper, so a parked frame reports a portable `file:line`. It is gated, so a
// bundle built without the flag is byte-for-byte unchanged (checked at the end here, against a committed
// bundle).
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TX = fileURLToPath(new URL("../../src/transform.cjs", import.meta.url));
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "srcmap-"));

let pass = 0, fail = 0;
const check = (label, cond, got) => { if (cond) { pass++; console.log(`  PASS  ${label}`); } else { fail++; console.log(`  FAIL  ${label}${got === undefined ? "" : ` (got ${got})`}`); } };

console.log("Probe: --source-map — a migrated frame reports a portable file:line, not just a pc\n");

// line 1: function Flow() {
// line 2:   const a = api.one();   <- suspends
// line 3:   const b = api.two();   <- suspends
// line 4:   return a + b;
const SRC = "function Flow() {\n  const a = api.one();\n  const b = api.two();\n  return a + b;\n}\n";
const inF = join(dir, "flow.src.js"), outF = join(dir, "flow.gen.mjs");
writeFileSync(inF, SRC);
execFileSync(process.execPath, [TX, inF, outF, "--bare", "--source-map"], { cwd: ROOT });
const { PROGRAMS, SITES, SOURCE_FILE, frameSite, stackSites } = await import(pathToFileURL(outF));

check("SOURCE_FILE points at the original source", SOURCE_FILE === inF, SOURCE_FILE);
check("a pc->line table is emitted for the suspendable fn", SITES.Flow && Object.keys(SITES.Flow).length > 0, JSON.stringify(SITES.Flow));

// Drive the machine to each suspension; F.pc then points at the resume block, whose site is the line of
// the suspending statement.
let F = { fn: "Flow", pc: 0, args: [] };
const seen = [];
for (let i = 0; i < 8; i++) { const r = PROGRAMS.Flow(F); if (r.op === "return") break; seen.push(frameSite({ fn: "Flow", pc: F.pc })); F.ret = i; }

check("the frame parked at the first suspension maps to api.one()'s line", seen[0] === inF + ":2", seen[0]);
check("the frame parked at the second suspension maps to api.two()'s line", seen[1] === inF + ":3", seen[1]);
const whole = stackSites([{ fn: "Flow", pc: 0 }, { fn: "Flow", pc: 1 }]);
check("stackSites maps every frame of a stack to a file:line", Array.isArray(whole) && whole.length === 2 && whole.every((s) => s.startsWith(inF + ":")), JSON.stringify(whole));

// Gating: the SAME input without --source-map reproduces the committed bundle byte-for-byte (zero cost
// when off). cf-fixtures is a --bare bundle; rebuild it (relative path, so the header matches) and compare.
const cfOut = join(dir, "cf.gen.mjs");
execFileSync(process.execPath, [TX, "src/cf-fixtures.src.js", cfOut, "--bare"], { cwd: ROOT });
check("without --source-map the bundle is byte-for-byte unchanged", readFileSync(cfOut, "utf8") === readFileSync(join(ROOT, "src/cf-fixtures.gen.mjs"), "utf8"));

const ok = fail === 0;
console.log(ok
  ? `\nPASS — --source-map carries each frame's source position through the transform, so a migrated continuation reports a portable file:line, and it is zero-cost when off (${pass} checks)`
  : `\nFAIL (${pass} passed, ${fail} failed)`);
process.exit(ok ? 0 : 1);
