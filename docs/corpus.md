# The corpus program — a statistical claim, not a demo

Goal: a defensible sentence of the form "across N real apps' own user journeys:
median X× less network wait, Y% less IO." One curated demo can't produce it; a
population of other people's apps can. Four rungs, each independently useful:

1. **Measurement harness** (`bench/harness/` — built). Playwright + CDP measures a
   scripted journey's real network behavior: per-request HTTP wire bytes, per-frame
   websocket bytes both directions, round trips, raw wall. Verified against socket
   ground truth (`bench/harness/verify.mts`: ws within a few bytes, HTTP within ~1%).
   Journeys are plain Playwright functions, so an app's existing e2e tests adapt in
   minutes.

2. **REST-proxy adapter + gateway** (folds into rung 3). Resources are an allow-listed
   namespace with an exec, so an adapter can declare an app's existing REST endpoints as
   `api.*` — no backend rewrite. The server host deploys as a thin gateway colocated
   with the backend: client↔server RTTs collapse into one migration; gateway↔backend
   hops are localhost. Both halves ship packaged (hardened on the first four ports,
   which carried them as per-app patches): the gateway is `tierless gateway --backend
   <url> [--cookie-authority]`; the browser side is `autoSession()`
   (tierless/adapt-auto — ws-URL convention, shaped-run override, same-origin/external
   split, force-browser seam, cookie authority auto-engaged by the gateway's hello
   declaration) feeding `axiosAdapter` (tierless/adapt-axios) or `fetchAdapter`
   (tierless/adapt-fetch, the crossability policy Strapi's port hand-wrote). Proven
   live by `test/e2e/auto-session-live.mts`.

3. **Porting recipe.** Per workflow, the client-side fetch/thunk orchestration becomes
   one plain sequential function entering through the Vite seam. Mechanical enough for
   an agent-assisted codemod; hardened on 2–3 real open-source apps end to end. What
   breaks here (auth flows, uploads, optimistic UI) is the compiler/runtime's
   requirements list.

4. **Corpus study.** 10–20 popular open-source apps **with e2e suites** — their tests
   define the journeys, not us. Port with the rung-3 tool, measure before/after with
   the rung-1 harness, report the **median and the full distribution per journey**,
   losers included. A journey dominated by backend compute won't move; showing that is
   what makes the rest credible.

## Run protocol (three runs, one job each)

A port is benchmarked by running the target's own e2e suite three times, never mixing
roles within a run:

1. **Baseline** — stock build + the measurement patch only (`ports/run.mts <name>
   --baseline`, separate work tree). Emits the per-test control JSONL.
2. **Profile** — ported build with recording on. This run gathers ALL adaptive
   evidence: the trajectory profile that prices workflow suffixes, and the shim's
   route evidence (which keys each route's envelope contains, when the app's XHRs
   fire relative to navigation, measured crossing times). Exploration policies —
   e.g. racing a held XHR against the network to learn which wins — are allowed in
   THIS run only. Its numbers are DISCARDED.
3. **Comparison** — ported build, recording off, exploration off. Every adaptive
   decision (hold vs network per key, migrate vs fetch) is FROZEN from the loaded
   profile artifact; a key the profile doesn't cover takes the deterministic
   fallback (straight to network — behaves like stock, never manufactures a wait).
   No racing, no learning, nothing self-modifying: two comparison runs of the same
   build and profile make the same decisions — the browser HOLDS the first
   compiled-method call until the profile fetch settles, so decisions cannot
   depend on fetch timing. Emits the measured JSONL that
   `ports/report.mts` joins against the baseline.

Measurement and certification never share a stack: each run gets a freshly booted
app (`boot.mts` kills whole process groups) and nothing else may touch its database
mid-run — a stray seed invalidates every test that was live.

**Every port reports BOTH halves of the headline — bytes AND network wait.** Bytes
alone (`report.mts` over the two TCP-true `truth` arms) is only half the claim; network
wait is the part a flow rewrite actually targets, and it needs shaped arms. So the
measured result of a port is SIX arms, not two, driven by one command
(`node ports/drive-arms.mts <name>` — idempotent, checkpoint-commits each arm, prints
both reports):

- **floor** (RTT0, no relay) — plain `suite.mts`, both variants → the timing baseline.
- **truth** (`TIERLESS_WIRE_TRUTH=1`, counting relay) — TCP-true bytes, both variants.
- **rtt** (`TIERLESS_RTT_MS=<n>`, latency proxy) — shaped timing, both variants.

`report-time.mts` then decomposes `net = dur(rtt) − dur(floor)` per test per arm — the
only component transport can move — and compares it across arms. A port whose numbers
are quoted without the network-wait decomposition is quoted incomplete.

**Test accommodations.** Some upstream tests assert the transport, not the UI —
`waitForResponse(...)` for a request the port eliminates can never fire. The MECHANICAL
case is now generic: `installTransportWaits(page)` (`tierless/playwright`, proven by
`test/e2e/pw-waits-live.mts`) patches `waitForResponse`/`waitForRequest` in place to
race the HTTP wait against the session's exec log, running the test's own predicate
(or glob/RegExp) unchanged against a truthful facade of each crossing — one fixture
line per suite, zero edits to spec files. A wait it can't satisfy honestly (a predicate
reading what a crossing doesn't carry) warns and falls back to HTTP-only rather than
fabricate a match. Its companions are generic too: `recordForceBrowserRoutes(context)`
(same module) auto-registers every `page.route()` pattern on the force-browser seam so
upstream mocks keep firing, and the measure reporter ships as
`tierless/playwright-reporter`. What remains hand-patched in the recipe's `testPatches`
is the SEMANTIC case: a test asserting behavior the port deliberately changes (waits
whose removal reorders the app, transport-shape assertions). Rules
unchanged: applied to BOTH arms (on stock the log never exists, so every wait reduces
to the original exactly); may relocate a wait but never weaken what the test asserts
about the page; each hand hunk carries a comment saying why. Failures that remain
(e.g. a login provider whose container we don't run) fail identically in both arms and
fall out of the report's pass-parity gate, listed with both statuses.

## Honesty constraints (bind all rungs)

- **Bytes, trips, and latency are all measured — never via CDP throttling.** CDP's
  network throttling does not apply to websockets (long-standing Chromium limitation),
  so it would bias exactly the before(HTTP)/after(ws) comparison. RTT is instead
  injected for real by a TCP delay relay in front of both origins
  (`ports/latency-proxy.mts`), which shapes websockets and CORS preflights identically
  to plain HTTP. The declared RTT is printed beside every number; the settled timing
  metric is network wait = duration@RTT − duration@unshaped-floor.
- **Workload selection is not ours.** Journeys come from the target app's own e2e
  suite, by a fixed rule (e.g. every journey tagged smoke/critical), chosen before
  measurement.
- **Distributions, not means.** Per-journey numbers, median highlighted, no aggregation
  across apps without the spread.
