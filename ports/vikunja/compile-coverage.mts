// Compiler-coverage diagnostic: run REAL Vikunja frontend files through the tierless
// transform and enumerate what blocks compilation — the checklist for making their
// actual code migratable (no shadow workflows). TypeScript is stripped with esbuild
// (their own toolchain) first; the transform sees plain ESM the way the Vite plugin
// would after the TS pass.
//
//   node ports/vikunja/compile-coverage.mts
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../work/vikunja/src/frontend/", import.meta.url));
const require = createRequire(import.meta.url);
const esbuild = require(path.join(SRC, "node_modules/esbuild"));
const { compile, analyze } = require("../../packages/tierless/src/transform.cjs");

// the service layer bottom-up: the natural migration units first, then the layers above
const TARGETS = [
  "src/services/abstractService.ts",
  "src/services/task.ts",
  "src/services/taskCollection.ts",
  "src/services/project.ts",
  "src/composables/useTaskList.ts",
];

for (const rel of TARGETS) {
  const ts = readFileSync(path.join(SRC, rel), "utf8");
  const { code: js } = esbuild.transformSync(ts, { loader: "ts", format: "esm", target: "es2022" });
  const src = '"use tierless";\n' + js;
  process.stdout.write(`\n== ${rel} (${js.split("\n").length} lines after type-strip) ==\n`);
  try {
    const { meta } = compile(src, { filename: rel, resources: { "this.http": "server" } });
    console.log(`  programs=[${meta.programs.join(", ") || "-"}]`);
    for (const m of meta.methods) console.log(`  ${m.program ? "compiled " : "KEPT     "} ${m.class}.${m.method}${m.error ? " — " + m.error : ""}`);
    try {
      const report = analyze(src, { filename: rel, resources: { "this.http": "server" } });
      for (const f of report.functions.filter((f: { suspendable: boolean }) => f.suspendable))
        console.log(`  suspendable fn: ${f.name} (${f.suspensions.length} suspension site(s))`);
    } catch { /* analyze is best-effort on top of a successful compile */ }
  } catch (e) {
    console.log(`  BLOCKED: ${(e as Error).message.split("\n")[0]}`);
  }
}
