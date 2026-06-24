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
  { file: "examples/wss/client.mjs",              needs: ["Ran over a real WebSocket (browser<->server)? YES"] },
  { file: "examples/wasm/index.mjs",              needs: ["matches plain JS (2000)? YES", "2 frame(s)"] },
  { file: "examples/wasm-two-process/client.mjs", needs: ["matches plain JS (2000)? YES", "2 frame(s)", "never crossed the socket)? YES"] },
  { file: "examples/policy/index.mjs",            needs: ["informed rule-> FETCH", "verified correct"] },
  { file: "bench/hn.mjs",                          needs: ["2 rt", "identical 254-node threads? YES"] },
  { file: "bench/sweep.mjs",                       needs: ["Correctness across all sizes: YES"] },
  { file: "bench/conduit.mjs",                     needs: ["less data", "identical feeds? YES"] },
  { file: "test/probes/heap.mjs",                 needs: ["Section B: all PASS"] },
  { file: "test/probes/fetch.mjs",                needs: ["all PASS — a migrated continuation"] },
  { file: "test/probes/deref.mjs",                needs: ["Result: ALL PASS"] },
  { file: "test/probes/async.mjs",                needs: ["all PASS — await is just a suspension"] },
  { file: "test/probes/asyncify.mjs",             needs: ["compiled-wasm continuation serialized and resumed in a fresh instance"] },
  { file: "test/probes/wasm-aot.mjs",             needs: ["an IR-compiled continuation serialized and resumed in a fresh instance"] },
  { file: "test/probes/wasm-aot-wss.mjs",         needs: ["a compiled continuation migrated over a real WebSocket and resumed"] },
  { file: "test/probes/wasm-handle.mjs",          needs: ["a big object stayed home while the continuation migrated"] },
  { file: "test/probes/wasm-fetch.mjs",           needs: ["the big object crossed only when the migrated program dereferenced its handle"] },
  { file: "test/probes/wasm-ts.mjs",              needs: ["real TypeScript compiled to native wasm, ran, and migrated"] },
  { file: "test/probes/wasm-diff.mjs",            needs: ["the AOT compiler matches the interpreter (differential oracle)"] },
  { file: "test/probes/wasm-closures.mjs",        needs: ["the AOT compiler runs the real frontend's closures"] },
  { file: "test/probes/wasm-values.mjs",          needs: ["the AOT value model (undefined/null/booleans"] },
  { file: "test/probes/wasm-operators.mjs",       needs: ["the AOT compiler runs the unary and bitwise operators"] },
  { file: "test/probes/wasm-objects.mjs",         needs: ["the AOT compiler runs string-keyed objects"] },
  { file: "test/probes/wasm-index.mjs",           needs: ["the AOT compiler runs computed member access"] },
  { file: "test/probes/wasm-builtins.mjs",        needs: ["the AOT compiler runs the scalar host stdlib"] },
  { file: "test/probes/wasm-string-methods.mjs",  needs: ["the AOT compiler runs string and array instance methods"] },
  { file: "test/probes/wasm-destructure.mjs",     needs: ["the AOT compiler runs array destructuring and object spread"] },
  { file: "test/probes/wasm-keys.mjs",            needs: ["the AOT compiler runs for-in and Object.keys"] },
  { file: "test/probes/wasm-json.mjs",            needs: ["the AOT compiler runs JSON.stringify"] },
  { file: "test/probes/wasm-captures.mjs",        needs: ["the AOT compiler runs capturing closures"] },
  { file: "test/probes/wasm-strings.mjs",         needs: ["the AOT compiler runs strings"] },
  { file: "test/probes/wasm-classes.mjs",         needs: ["the AOT compiler runs classes"] },
  { file: "test/probes/wasm-generators.mjs",      needs: ["the AOT compiler runs generators"] },
  { file: "test/probes/wasm-async.mjs",           needs: ["the AOT compiler runs async/await"] },
  { file: "test/probes/wasm-exceptions.mjs",      needs: ["the AOT compiler runs try/catch/throw"] },
  { file: "test/probes/wasm-render.mjs",          needs: ["the render demo (app.ts) compiled to native wasm, ran, and migrated"] },
  { file: "test/probes/frontend.mjs",             needs: ["all PASS — closures"] },
  { file: "examples/hn-thread/client.mjs",        needs: ["Real TS migrated over a WebSocket and computed correctly? YES"] },
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
