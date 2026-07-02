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
  { file: "test/probes/wire-delta.mjs",  needs: ["fidelity, locality, bounce, floor, write-tracked≡rescan, Map/Set, and orphan-correctness all hold"] },
  { file: "test/probes/wire-delta-compiled.mjs", needs: ["--track-writes drives write-tracked delta on plain source, matching the rescan oracle"] },
  { file: "test/probes/wire-delta-fuzz.mjs", needs: ["property round-trips, differential, boundaries, and decode robustness all hold"] },
  { file: "test/probes/wire-delta-fields.mjs", needs: ["per-field/element granularity: object/array/Map/Set ship only the slots that changed, both directions of an oscillation, and it is opt-in"] },
  { file: "test/probes/wire-delta-handle.mjs", needs: ["the dataset stayed home as a handle while only UI deltas crossed — the two wire optimizations compose"] },
  { file: "test/probes/wire-content.mjs", needs: ["content-addressed immutable subgraphs ship once then by hash, resolving to the held copy"] },
  { file: "test/demos/verify.mjs",         needs: ["PASS — auto-compiled tier-split continuation produced the correct session"] },
  { file: "test/demos/conduit-verify.mjs", needs: ["the multi-view Conduit app (routing, forms, favorite, try/catch over a resource) runs correctly as one compiled continuation"] },
  { file: "test/probes/define-api.mjs", needs: ["defineApi is sugar, not a bypass: mandatory authorize at create, default-deny, budgets all hold"] },
  { file: "test/demos/api-verify.mjs",     needs: ["the api is an external reference monitor: authority is verified and enforced in a separate process on every call"] },
  { file: "test/demos/api-pump.mjs",       needs: ["the live pump services api.* through the trusted monitor: a migrating continuation is authorized per principal in a separate process on every call"] },
  { file: "test/demos/api-live.mjs",       needs: ["the default api.* path IS the reference monitor: the runtime pump serviced every api call over the pipe"] },
  { file: "test/probes/host.mjs",   needs: ["serveApp/connect assemble the full host: client-started actions (with mid-flight bounces and concurrency) and server-started sessions both run over one socket"] },
  { file: "test/demos/control-flow.mjs",   needs: ["extended control flow survives migration"] },
  { file: "test/probes/deref-liveness.mjs", needs: ["the --auto-deref liveness pass prunes redundant guards within a straight-line run and re-guards after any hop"] },
  { file: "test/probes/source-maps.mjs", needs: ["--source-map carries each frame's source position through the transform, so a migrated continuation reports a portable file:line"] },
  { file: "test/probes/lang-coverage.mjs", needs: ["desugar and migrate correctly; un-migratable tier calls are rejected with a clear error"] },
  { file: "test/probes/compiler-api.mjs", needs: ["the compiler is an importable library: configurable resources, module-shaped input (exports/imports/state preserved), and an analyze() report"] },
  { file: "test/probes/cli.mjs", needs: ["the stackmix CLI works end to end: build (custom resources), explain (the analysis made visible), api (load-time pre-ship check), types (the api surface as a declaration)"] },
  { file: "test/probes/vite-plugin.mjs", needs: ["the Vite plugin turns a \"use mix\" module into monitor-backed actions: transform + dev-server endpoint + ssr-loaded machine + sidecar authorization, end to end"] },
  { file: "test/probes/create-app.mjs", needs: ["create-stackmix scaffolds a WORKING two-tier app: build, boot (api sidecar forked), seeded render, authorized write, monitor denial caught across the tier, clean end"] },
  { file: "test/demos/heap-probe.mjs",     needs: ["big locals stay home, fetched on deref, single-writer coherent"] },
  { file: "test/demos/heap-live.mjs",      needs: ["the dataset stayed on the server, crossing only when the browser derefed it"] },
  { file: "test/demos/heap-auto.mjs",      needs: ["transparent deref: ordinary member access on a handle auto-fetches"] },
  { file: "test/demos/heap-writeback.mjs", needs: ["optimistic CAS, conflicts detected and retried, no lost updates"] },
  { file: "test/demos/heap-write.mjs",     needs: ["transparent write-back: an ordinary member assignment propagated to the owning master"] },
  { file: "test/demos/heap-write-delta.mjs", needs: ["a §5 write-back ships only the changed objects (member edits and collection mutations alike), far smaller than the whole snapshot, and min(delta, whole) is never larger"] },
  { file: "test/demos/policy-live.mjs",    needs: ["informed FETCH", "priced migrate vs fetch from real bytes and steered the socket"] },
  { file: "test/demos/delta-live.mjs",     needs: ["bounce + min(delta,full) + §5 excision + deref all compose, end to end"] },
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
