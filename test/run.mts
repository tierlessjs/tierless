// Tierless — regression runner. Executes every demo and probe and asserts the headline
// claims actually hold (not just exit 0). Paths resolve against the repo root, so it runs
// the same from any working directory.
//
//   node test/run.mts        (or: npm test)

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const node = (rel: string, extra: string[] = []) => spawnSync(process.execPath, [rel, ...extra], { cwd: ROOT, encoding: "utf8" as const });

interface Case { file: string; needs: string[] }
const cases: Case[] = [
  { file: "test/probes/codec.mts",       needs: ["wire codec: identity, cycles"] },
  { file: "test/probes/wire-binary.mts", needs: ["binary wire: identical decode"] },
  { file: "test/probes/wire-fuzz.mts",   needs: ["property round-trips, differential vs JSON, boundaries, and decode robustness"] },
  { file: "test/probes/wire-delta.mts",  needs: ["fidelity, locality, bounce, floor, write-tracked≡rescan, Map/Set, and orphan-correctness all hold"] },
  { file: "test/probes/wire-delta-compiled.mts", needs: ["--track-writes drives write-tracked delta on plain source, matching the rescan oracle"] },
  { file: "test/probes/wire-delta-fuzz.mts", needs: ["property round-trips, differential, boundaries, and decode robustness all hold"] },
  { file: "test/probes/wire-delta-fields.mts", needs: ["per-field/element granularity: object/array/Map/Set ship only the slots that changed, both directions of an oscillation, and it is opt-in"] },
  { file: "test/probes/wire-delta-handle.mts", needs: ["the dataset stayed home as a handle while only UI deltas crossed — the two wire optimizations compose"] },
  { file: "test/probes/wire-content.mts", needs: ["content-addressed immutable subgraphs ship once then by hash, resolving to the held copy"] },
  { file: "test/e2e/verify.mts",         needs: ["PASS — auto-compiled tier-split continuation produced the correct session"] },
  { file: "test/e2e/conduit-verify.mts", needs: ["the multi-view Conduit app (routing, forms, favorite, try/catch over a resource) runs correctly as one compiled continuation"] },
  { file: "test/probes/define-api.mts", needs: ["defineApi is sugar, not a bypass: mandatory authorize at create, default-deny, budgets all hold"] },
  { file: "test/e2e/api-verify.mts",     needs: ["the api is an external reference monitor: authority is verified and enforced in a separate process on every call"] },
  { file: "test/e2e/api-pump.mts",       needs: ["the live pump services api.* through the trusted monitor: a migrating continuation is authorized per principal in a separate process on every call"] },
  { file: "test/e2e/api-live.mts",       needs: ["the default api.* path IS the reference monitor: the runtime pump serviced every api call over the pipe"] },
  { file: "test/probes/host.mts",   needs: ["serveApp/connect assemble the full host: client-started actions (with mid-flight bounces and concurrency) and server-started sessions both run over one socket"] },
  { file: "test/probes/session-auth.mts", needs: ["sealed cookie authority: blob crossings, in-band rotation, claim/reseal, expiry, and the two-tab 401 recovery all hold"] },
  { file: "test/e2e/control-flow.mts",   needs: ["extended control flow survives migration"] },
  { file: "test/probes/deref-liveness.mts", needs: ["the --auto-deref liveness pass prunes redundant guards within a straight-line run and re-guards after any hop"] },
  { file: "test/probes/source-maps.mts", needs: ["--source-map carries each frame's source position through the transform, so a migrated continuation reports a portable file:line"] },
  { file: "test/probes/lang-coverage.mts", needs: ["desugar and migrate correctly; un-migratable tier calls are rejected with a clear error"] },
  { file: "test/probes/ts-mix-module.mts", needs: ["strip to plain JS before parsing and compile+run identically to .src.js; a non-erasable construct is rejected with a clear error; plain .js is unaffected"] },
  { file: "test/probes/compiler-api.mts", needs: ["the compiler is an importable library: configurable resources, module-shaped input (exports/imports/state preserved), and an analyze() report"] },
  { file: "test/probes/types.mts", needs: ["the public surface is typed end to end: every exports-map entry resolves a declaration under strict nodenext, and misuse is rejected"] },
  { file: "test/probes/cli.mts", needs: ["the tierless CLI works end to end: build (custom resources), explain (the analysis made visible), api (load-time pre-ship check), types (the api surface as a declaration)"] },
  { file: "test/probes/vite-plugin.mts", needs: ["the Vite plugin turns a \"use tierless\" module into monitor-backed actions: transform + dev-server endpoint + ssr-loaded machine + sidecar authorization, end to end"] },
  { file: "test/probes/vite-build.mts", needs: ["`vite build` emits the server machine + manifest and a prod server mounts it end to end, no second compile and no hand-written resolver"] },
  { file: "test/probes/vite-build-compile.mts", needs: ["vite build emits a machine-only server bundle for compiled app modules; the gateway resumes a migrated chain from it"] },
  { file: "test/probes/create-app.mts", needs: ["create-tierless scaffolds a WORKING two-tier app: build, boot (api sidecar forked), seeded render, authorized write, monitor denial caught across the tier, clean end"] },
  { file: "test/e2e/heap-probe.mts",     needs: ["big locals stay home, fetched on deref, single-writer coherent"] },
  { file: "test/e2e/heap-live.mts",      needs: ["the dataset stayed on the server, crossing only when the browser derefed it"] },
  { file: "test/e2e/heap-auto.mts",      needs: ["transparent deref: ordinary member access on a handle auto-fetches"] },
  { file: "test/e2e/heap-writeback.mts", needs: ["optimistic CAS, conflicts detected and retried, no lost updates"] },
  { file: "test/e2e/heap-write.mts",     needs: ["transparent write-back: an ordinary member assignment propagated to the owning master"] },
  { file: "test/e2e/heap-write-delta.mts", needs: ["a §5 write-back ships only the changed objects (member edits and collection mutations alike), far smaller than the whole snapshot, and min(delta, whole) is never larger"] },
  { file: "test/e2e/evict-safety.mts",   needs: ["the served cache is byte-bounded: a long session of distinct derefs stays within a memory budget, LRU-evicts by recency, and every eviction costs at most a correct refetch"] },
  { file: "test/e2e/heap-serve.mts",     needs: ["the full §5 heap is wired into the real serving path: excision, deref-over-socket, CAS write-back in place, byte-bounded pinned cache, per-continuation owner-heap release, per-bundle gating on mixed endpoints — all through makeHost/serveApp/connect"] },
  { file: "test/e2e/connection-cap.mts", needs: ["the per-process connection cap refuses over-cap upgrades with 503, spares live sessions, and recycles freed slots"] },
  { file: "test/e2e/ws-auth-live.mts",   needs: ["the session token rides a bearer subprotocol — read by the gateway, absent from URLs, never echoed — and protocol-less clients connect unchanged"] },
  { file: "test/e2e/preboot-live.mts",   needs: ["the ws-upgrade hello folded the reseal round trip into the handshake and pre-delivered a boot GET the first crossing joined"] },
  { file: "test/e2e/pw-waits-live.mts",  needs: ["installTransportWaits made UNMODIFIED upstream waits transport-agnostic"] },
  { file: "test/e2e/h2-connect-live.mts", needs: ["a websocket rode an HTTP/2 Extended CONNECT stream (RFC 8441) and carried a full tierless exec"] },
  { file: "test/e2e/webtransport-live.mts", needs: ["the WebTransport adapter length-frames tierless messages over a WHATWG byte duplex and carries full execs"] },
  { file: "test/e2e/policy-live.mts",    needs: ["informed FETCH", "priced migrate vs fetch from real bytes and steered the socket"] },
  { file: "test/probes/trace.mts",       needs: ["run-level sampling, a wire-borne trace flag with one cross-tier order, truncation-safe profiles with per-feature size models, and a stability-gated trajectory rule over a greedy floor"] },
  { file: "test/e2e/trio-live.mts",      needs: ["traces recorded through the real host priced fetchA's whole suffix and flipped a locally-losing hop", "the hash gate refuses stale history"] },
  { file: "test/e2e/sink-throw.mts",     needs: ["a throwing sink is contained and counted: observability never changes the observed run's outcome"] },
  { file: "test/e2e/delta-live.mts",     needs: ["bounce + min(delta,full) + §5 excision + deref all compose, end to end"] },
  { file: "test/probes/axios-adapter.mts", needs: ["all adapter translations hold"] },
  { file: "test/probes/method-compile.mts", needs: ["class methods compile, park, and fall back correctly"] },
  { file: "test/e2e/method-live.mts",      needs: ["frame and instance stay put, resources fetch, errors unwind, unbound falls back"] },
  { file: "test/probes/migrate-arm.mts",   needs: ["a chain migrates in one crossing; the stop rule, identity, and unwind hold; the profile decides"] },
  { file: "test/e2e/migrate-live.mts",     needs: ["the migrate arm runs live: a chain is one crossing, home segments see the real instance"] },
  { file: "test/probes/store-compile.mts", needs: ["setup-store functions compile with call-time caps; captures rewrite precisely; the chain still batches"] },
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
