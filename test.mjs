// Waso — regression runner. Executes every demo and asserts the headline
// claims hold (not just exit 0). Run: node test.mjs   (or: npm test)

import { spawnSync } from "node:child_process";

const cases = [
  { file: "waso-spike.mjs",          needs: ["matches plain JS result? YES", "x smaller"] },
  { file: "waso-2p-client.mjs",      needs: ["Dataset never crossed the pipe? YES"] },
  { file: "waso-wasm.mjs",           needs: ["matches plain JS (2000)? YES", "2 frame(s)"] },
  { file: "waso-wasm-2p-client.mjs", needs: ["matches plain JS (2000)? YES", "2 frame(s)", "Dataset never crossed the pipe? YES"] },
  { file: "waso-policy.mjs",         needs: ["informed rule-> FETCH", "verified correct"] },
  { file: "bench-hn.mjs",            needs: ["2 rt", "identical 254-node threads? YES"] },
  { file: "bench-sweep.mjs",         needs: ["Correctness across all sizes: YES"] },
  { file: "bench-conduit.mjs",       needs: ["less data", "identical feeds? YES"] },
  { file: "probe-heap.mjs",          needs: ["Section B: all PASS"] },
  { file: "probe-fetch.mjs",         needs: ["all PASS — a migrated continuation"] },
  { file: "probe-async.mjs",         needs: ["all PASS — await is just a suspension"] },
  { file: "waso-fetch-2p-client.mjs", needs: ["On-demand (big data crossed only on deref)? YES"] },
];

// Build the wasm once up front.
const build = spawnSync(process.execPath, ["build-wasm.mjs"], { encoding: "utf8" });
if (build.status !== 0) { console.error("build failed:\n" + build.stderr); process.exit(1); }

let failed = 0;
for (const { file, needs } of cases) {
  const r = spawnSync(process.execPath, [file], { encoding: "utf8" });
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
