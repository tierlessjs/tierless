// Stackmix — regression runner. Executes every demo, example, and probe and
// asserts the headline claims actually hold (not just exit 0). Paths resolve
// against the repo root, so it runs the same from any working directory.
//
//   node test/run.mjs        (or: npm test)

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const node = (rel, extra = []) => spawnSync(process.execPath, [rel, ...extra], { cwd: ROOT, encoding: "utf8" });

const cases = [
  { file: "examples/spike/index.mjs",             needs: ["matches plain JS result? YES", "x smaller"] },
  { file: "examples/two-process/client.mjs",      needs: ["Dataset never crossed the pipe? YES"] },
  { file: "examples/wasm/index.mjs",              needs: ["matches plain JS (2000)? YES", "2 frame(s)"] },
  { file: "examples/wasm-two-process/client.mjs", needs: ["matches plain JS (2000)? YES", "2 frame(s)", "Dataset never crossed the pipe? YES"] },
  { file: "examples/policy/index.mjs",            needs: ["informed rule-> FETCH", "verified correct"] },
  { file: "bench/hn.mjs",                          needs: ["2 rt", "identical 254-node threads? YES"] },
  { file: "bench/sweep.mjs",                       needs: ["Correctness across all sizes: YES"] },
  { file: "bench/conduit.mjs",                     needs: ["less data", "identical feeds? YES"] },
  { file: "test/probes/heap.mjs",                 needs: ["Section B: all PASS"] },
  { file: "test/probes/fetch.mjs",                needs: ["all PASS — a migrated continuation"] },
  { file: "test/probes/deref.mjs",                needs: ["Result: ALL PASS"] },
  { file: "test/probes/async.mjs",                needs: ["all PASS — await is just a suspension"] },
  { file: "examples/handle-fetch/client.mjs",     needs: ["On-demand (big data crossed only on deref)? YES"] },
  { file: "test/probes/frontend.mjs",             needs: ["all PASS — closures"] },
  { file: "examples/hn-thread/client.mjs",        needs: ["Real TS migrated across processes and computed correctly? YES"] },
  { file: "test/probes/realts.mjs",               needs: ["all PASS — Stackmix compiles real JS"] },
  { file: "test/conformance.mjs",                 needs: ["Result: ALL PASS"] },
  { file: "test/difftest.mjs",                    needs: ["NO DIVERGENCES"] },
  { file: "test/decorators.mjs",                  needs: ["Result: ALL PASS"] },
  { file: "test/multimodule.mjs",                 needs: ["Result: ALL PASS"] },
];

// Build the wasm once up front.
const build = node("src/wasm/build.mjs");
if (build.status !== 0) { console.error("build failed:\n" + build.stderr); process.exit(1); }

let failed = 0;
for (const { file, needs } of cases) {
  const r = node(file);
  const out = (r.stdout || "") + (r.stderr || "");
  const missing = needs.filter((s) => !out.includes(s));
  const ok = r.status === 0 && missing.length === 0;
  console.log(`${ok ? "PASS" : "FAIL"}  ${file}`);
  if (!ok) {
    failed++;
    if (r.status !== 0) console.log(`        exit ${r.status}`);
    missing.forEach((s) => console.log(`        missing: "${s}"`));
  }
}

console.log(`\n${failed === 0 ? "all green" : failed + " failed"}`);
process.exit(failed === 0 ? 0 : 1);
