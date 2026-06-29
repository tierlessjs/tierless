// Stackmix — regression runner. Executes every demo and probe and asserts the headline
// claims actually hold (not just exit 0). Paths resolve against the repo root, so it runs
// the same from any working directory.
//
//   node test/run.mjs        (or: npm test)

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const node = (rel, extra = []) => spawnSync(process.execPath, [rel, ...extra], { cwd: ROOT, encoding: "utf8" });

const cases = [
  { file: "test/probes/codec.mjs",       needs: ["wire codec: identity, cycles"] },
  { file: "test/probes/wire-binary.mjs", needs: ["binary wire: identical decode"] },
  { file: "test/probes/wire-fuzz.mjs",   needs: ["property round-trips, differential vs JSON, boundaries, and decode robustness"] },
  { file: "src/verify.mjs",         needs: ["PASS — auto-compiled tier-split continuation produced the correct session"] },
  { file: "src/control-flow.mjs",   needs: ["extended control flow survives migration"] },
  { file: "src/heap-probe.mjs",     needs: ["big locals stay home, fetched on deref, single-writer coherent"] },
  { file: "src/heap-live.mjs",      needs: ["the dataset stayed on the server, crossing only when the browser derefed it"] },
  { file: "src/heap-auto.mjs",      needs: ["transparent deref: ordinary member access on a handle auto-fetches"] },
  { file: "src/heap-writeback.mjs", needs: ["optimistic CAS, conflicts detected and retried, no lost updates"] },
  { file: "src/heap-write.mjs",     needs: ["transparent write-back: an ordinary member assignment propagated to the owning master"] },
  { file: "src/policy-live.mjs",    needs: ["informed FETCH", "priced migrate vs fetch from real bytes and steered the socket"] },
];

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
