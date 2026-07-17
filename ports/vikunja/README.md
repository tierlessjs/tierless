# Vikunja port (v1.0.0, sha 3ba5192b)

Their newest release (tagged 2026-01-27; GitHub's "latest release" page shows v2.3.0
because it sorts by semver and Vikunja renumbered). Verified from source: Vite 7.3.1 +
Vue 3.5.27 frontend with a 31-spec Playwright e2e suite; Go backend, SQLite default —
**never modified**.

This is a NATIVE port: their real application code — services, models, stores,
interceptors — runs compiled, not shadowed. An earlier revision of this port answered
the app's XHRs from a hand-written "route workflow" that mirrored what the app would
have asked; that reproduces intent, not code, and was retired (git history has it and
its numbers). The cut point now is the I/O bottom: the axios adapter slot, the lowest
app-owned frame before host machinery.

## The diff to their app

    patches/0005-tierless-axios-adapter.patch   fetcher.ts +14, main.ts +5 (the adapter; session preconnect at bootstrap)
    patches/0006-compile-services.patch         vite.config.ts: +10 lines (2 code: import + compile:'auto' plugin entry)
    patches/0007-session-twins.patch            2 new files (~50 lines): the audited twin list

plus `pnpm add tierless` (a dependency install, not a diff). What the patches do:

1. **The adapter** replaces axios's XHR bottom with tierless resource requests.
   Everything above it — their interceptor chains, snake-case conversion, auth
   headers, model hydration — runs untouched. Requests whose config only the browser
   can honor (blob/stream responses, FormData/Blob bodies, progress callbacks) fall
   through to axios's own XHR adapter, decided per request by declared semantics plus
   an ownership scan, never by serialization failure alone.
2. **The plugin line** sets `compile: 'auto'`: eligibility is the compiler's verdict
   over every candidate module — 17 modules / 59 programs on this app (the build
   writes what compiled and why to `dist-tierless/tierless.compile-coverage.json`;
   a copy is committed at `results/compile-coverage-auto.json`). Acceptance: their
   full suite scores identically to the stock exclusion set on both the old 4-file
   hand list and auto (COMPILING.md records the four tierless defects the widening
   surfaced, all fixed with probes). The service HTTP methods (getAll/get/create/update/delete...)
   become serializable state machines; all ~40 service classes inherit them, so every
   service call site in the app can park at the session socket. Compiled STORE
   functions suspend on method calls (dynamic call parks), so a store chain can
   migrate whole. **Patch 0007** declares the classes safe to run as session TWINS
   server-side (real instances, real interceptors; their state changes ride the reply
   home so the browser instance reads its writes). On the server a TWIN of their axios instance
   (same call surface, fetch-backed, session token attached per connection) services
   `http.*` requests against the backend over localhost. Authority travels with the
   request; the gateway holds no credentials.

A compiled method's request-interceptor chain still runs browser-side — the config
that crosses the wire is exactly what axios would hand its adapter, JSON pass
included (toJSON, Dates→ISO). The session socket negotiates permessage-deflate WITH
context takeover: one deflate window for the whole session, so every crossing
compresses against everything the session has already said.

## Reproduce

    node ports/run.mts vikunja                      # fetch + verify + apply the patches
    cd ports/work/vikunja/src/frontend
    corepack pnpm install --frozen-lockfile && corepack pnpm add tierless@link:<repo>/packages/tierless
    corepack pnpm run build
    cd .. && go build -o vikunja .

Baseline arm: `node ports/run.mts vikunja --baseline`, then install + build WITHOUT
`pnpm add tierless` (the backend binary is byte-identical — copy it).

## Suite benchmark — their whole e2e suite, at the socket

The workload is their own 199-test Playwright suite, both arms run by one command
each (no by-hand step can diverge). Byte accounting is TCP-TRUE: session ws bytes
are counted inside the gateway (deflate included), the browser's API HTTP bytes go
through a counting TCP relay, and node-side test seeding is split onto a separate
URL so only what the PAGE puts on the wire is counted. CDP cannot do this job — it
reports ws frames post-inflate and silently uncompresses the ported arm.

    TIERLESS_WIRE_TRUTH=1 node ports/vikunja/suite.mts --baseline
    TIERLESS_WIRE_TRUTH=1 node ports/vikunja/suite.mts
    node ports/report.mts ports/work/vikunja-baseline/measure.jsonl ports/work/vikunja/measure.jsonl

The report pairs tests by id, drops pairs that don't pass in BOTH arms (listed,
never silent), and states its byte provenance. Both arms' JSONL is committed under
`results/truth-*.jsonl`, so the report reruns without the two ~9-minute suite runs.

Measured 2026-07-17 on the `compile: 'auto'` build (195 pass-parity pairs — the
3 stock exclusions plus one single-run flake the report lists; all 195 pairs
touch the port):

    suite-wide      31.2 MB -> 26.9 MB   (14% less IO)
                    6,181  -> 5,432 round trips   (12% fewer)
    per test        median 34% fewer bytes · 17% fewer trips (covered subset)
    best case       240 KB -> 18 KB, 117 -> 14 trips (comment-pagination spec:
                    the per-comment avatar refetch antipattern collapses)

No batching is in those numbers: there, every service call was its own crossing.
The savings are preflights gone (same-origin socket), envelope headers trimmed to
what their code reads (content-type + x-*), and the session-long deflate window.
Two batching mechanisms landed after, each measured against the ported build
itself — same build, one variable per pair:

- **§6 chain migration** (sequential structure — a compiled method's call chain
  runs server-side as one crossing): see Timing below.
- **Burst coalescing** (concurrent structure — the shape reactive apps actually
  produce: N components mount, N service calls fire in the same tick). The
  browser holds exec crossings for one timer turn and merges same-module bursts
  into one `execBatch` frame; the gateway fans out concurrently and returns
  per-element results, errors shaped exactly as a lone call's. Safe by
  construction: only requests already in flight together merge.

  Measured 2026-07-17 on the `compile: 'auto'` build (results/truth-batch-*
  .jsonl; 194 shared passed pairs): session ws frames 1,326 -> 1,058 out and
  1,300 -> 1,039 in (20% fewer each), and NO test sent more frames. TCP-true
  ws bytes only 0.4% less — the win is frame count, not bytes (deflate already
  amortizes payload repetition). Wall time parity at RTT 0 and at RTT 20
  (results/rtt20-batch-*.jsonl, 195 shared passed, per-test median delta
  0 ms): the one-timer-turn hold costs nothing measurable, and concurrent
  crossings already overlapped their RTTs, so fewer frames does not mean
  fewer round-trip waits.

  Verdict: neutral on every metric this suite prices — DEFAULT OFF
  (`__TIERLESS_EXEC_BATCH__` page global / `TIERLESS_EXEC_BATCH=1` suite env
  opts in). ROADMAP.md carries the review-or-remove item: revisit once more
  ports show whether any app pays per frame.

## Timing — measured under real injected RTT, and honest about it

`TIERLESS_RTT_MS=20 node ports/vikunja/suite.mts [--baseline]` routes the browser
through TCP delay relays (TCP_NODELAY set — Nagle + delayed ACK otherwise reads as
~40 ms per small ws frame and once masqueraded as a ported regression). RTT 20 ms
models residential latency; TIERLESS_BPS adds link bandwidth (1 Gbps, re-measured
2026-07-17: arm deltas within ±0.3 min in OPPOSITE directions — no consistent
effect at this app's payload sizes, results/rtt20-bps1g-*.jsonl).

Measured 2026-07-17 on the `compile: 'auto'` build, three runs per arm with
per-test medians (results/rtt20-{baseline,ported}*.jsonl; single runs on heavy
tests swing by seconds, so no single-run number below). Direct per-test
comparison at RTT 20, ported vs stock: **median −0 ms** (quartiles −62/0/+40),
suite total −1.6 s — parity. The locked profile shipping the app's ONE stable
chain measures the same (results/rtt20-chains-ported.jsonl, median +22 ms vs
plain ported).

That parity is one patch line deep: without `configureTierless({preconnect:
true})` in main.ts (now part of patch 0005), the same comparison reads median
+35 ms, total +4.6 s — one to two RTTs per test, the fresh page's TCP +
ws-upgrade handshake landing on the first service call's critical path, which
stock never pays (its first XHR reuses the pool afterwards). Preconnect folds
the handshake into app bootstrap, where it overlaps asset loading
(results/rtt20-preconnect-r*.jsonl vs rtt20-ported*/rtt20-batch-off).

Floor-subtracted "network wait" (dur@RTT20 minus an unshaped floor run,
results/floor-*.jsonl) is only valid where the workload is latency-STABLE: 36
of 189 tests change their request COUNT with timing — comment-pagination stock
issues 117 requests at 0 ms but 15 at RTT 20 (the avatar-refetch storm is
latency-gated), while the ported arm issues 9 at every latency — so
subtracting floors there compares different workloads (in one single-run cut
it read as 30 s of phantom ported wait; in another, as parity). Over the 153
latency-stable tests, medians of 3: network wait stock 55.3 s total / 379 ms
median vs ported 59.6 s / 389 ms — the same near-parity as the direct
comparison, before preconnect.

The census, re-run on the widened auto surface (7,615 trace records, 6,493/6,493
complete runs, 36 sites): their suite still has exactly ONE stable chain —
project$toggleSavedFilterFavorite > getM, stability 100% — and the profile folds
it as before (5-run medians on the 2026-07-07 hand-list build measured the fold
at 52 ms per occurrence, wsOut 7 -> 6; same chain, same machine code). The RTT tail above is a DIFFERENT structure the
method-boundary profile cannot ship — sequential parks INSIDE one method's run —
and this decomposition is what prices that open §6 item.

## Correctness — their own suite as the judge

Full suite, stock and ported arms run identically: **196 pass on both, and the 3
failures are the same 3 tests in both arms** — the two drag-to-project specs that
upstream's own CI retries for (`retries: process.env.CI ? 2 : 0`; both pass in
isolation on both builds), and the OpenID login that needs the Dex container their
CI boots. Nothing fails on the ported build that passes on stock. Re-verified
2026-07-17 on the `compile: 'auto'` surface (17 modules / 59 programs): same 196
passing, same 3 exclusions. The four additional tierless defects the widening
surfaced — and fixed — are recorded in COMPILING.md.

The suite caught four real boundary defects on the way, each fixed in tierless
rather than worked around: the interceptor chain must run browser-side (backend
rejected un-snake-cased models), the wire body must be axios's JSON pass (Dates
crossed as {}), exec errors must carry error.response whole (their services read
status codes), and relative URLs must resolve against the instance's baseURL.
Test accommodations (patch 0004, applied to BOTH arms) replace
`page.waitForResponse(...)` waits — the exact HTTP requests the port eliminates —
with equivalent UI-condition waits; every replacement was verified individually,
and no assertion was weakened.

## Caveats (read before quoting)

- Bytes and trips are socket-level wire measurements. Timing is real elapsed time
  under relay-injected RTT (bandwidth unshaped; connection handshakes undelayed —
  a keep-alive assumption that favors the stock arm).
- 11 of 199 tests (login-failure/email-confirmation flows) never inject the
  browser API override; their page traffic bypasses the byte counters on both arms
  symmetrically.
- Async request interceptors and browser-pinned configs (blobs, FormData, progress)
  fall through to stock XHR by design — those requests are in the baseline's column
  on both arms.
- Their service-worker registration fails under `vite preview` in both variants
  (upstream workbox path issue) — no effect on the comparison.
- One app: this is the recipe's first native data point, not the corpus median.
