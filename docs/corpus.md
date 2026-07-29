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

## Reading a byte number (start here)

One run yields several legitimate numbers that differ by 100x. They are not competing
results — they are the SAME bytes over different denominators, and only the last one
says anything about the transport.

    what you count                          n8n              grafana
    1. everything the suite downloaded      -0.6%            +0.1%
    2. the small API calls that recur        -51%             -81%

(1) is dominated by things the harness re-downloads because Playwright gives every test
a clean browser: bundles, fonts, and on n8n a 12 MB node catalogue fetched ~510 times.
A real user does not pay that repeatedly, and the response headers prove it rather than
our inference — every one of those paths ships an ETag (bundles `public, max-age=0`,
`/types/*.json` `no-cache, must-revalidate`, the catalogue etag-only), so a warm browser
REVALIDATES and receives a 0-byte 304. The harness never does: fresh contexts hold no
cached copy, so zero 304s appear in either arm and both pay full price for everything.

(2) is what remains once those are modelled away — the traffic a real session actually
re-fetches. On n8n that is ~46 MB of small `/rest/*`; on grafana ~22 MB of
dashboard/plugin/settings JSON. This is the number to quote.

Why the win differs so much between the two: **request shape**. A session deletes
per-request overhead (half of n8n's small-API bytes are request headers, repeated across
6605 requests) and compresses bodies against a shared window, so it wins big on many
small responses (grafana, -81%) and much less on a few huge ones. n8n's -51% is measured
with its catalogue kept off the socket; blended with the catalogue the same slice reads
-6.7%, which is a compression delta on one payload and must not be quoted as a
request-shape result (`ports/report-marginal.mts` refuses that label automatically).

Caveats that travel with these numbers: grafana's arms differed in pass count (93 vs 97),
so its figures want a parity re-run; and n8n's -51% is a bound, since a few catalogue
crossings still occurred before the browse advisory was learned.

## What a byte headline actually reports

Two ports produced very different numbers on the same transport — vikunja cut suite IO,
n8n came out at parity — and the difference is the WORKLOAD, not the port quality. The
decomposition (n8n measured 2026-07-25, `ports/n8n/report-anatomy.mts`):

    byte win  ~=  addressable share  x  per-slice win

- **Addressable share** — the fraction of the app's browser bytes on paths the session
  can serve at all. On n8n that is **15.0%**: 918 MB of `/rest/*` against 5,214 MB of
  bundles, fonts and `/types/nodes.json` that are plain HTTP in BOTH arms and can only
  dilute a percentage. A transport choice cannot reach 85% of this app's bytes.
- **Per-slice win** — how much cheaper the session is on the traffic it does carry. On
  n8n, **7.0%** (918 MB HTTP -> 854 MB session).

Product: ~1% suite-wide, and the measured arm pair is -0.6%. Parity, and predictable.

The per-slice win is where the interesting variation lives, and it is driven by REQUEST
SHAPE rather than byte volume. A persistent session eliminates per-request overhead and
compresses across calls, so it wins where traffic is MANY SMALL responses. n8n's
addressable traffic is the opposite: **96.9% of its 918 MB sits in 511 responses over
1 MB**, while 15,056 small calls averaging 1.8 KB carry only 3.1%. Request headers —
the overhead a socket removes outright — are **1.57%** of addressable traffic there.
There is simply little for the transport to win on a few huge, already-compressed
bodies. Vikunja's addressable traffic is small-and-many, and its per-slice win is
several times larger on a similar addressable share (re-derived 2026-07-26 under the
conserving reporter: 8-10% suite IO, 30-32% median per-test — the originally published
13%/35% carried the biased reporter).

### The harness inflates the denominator (marginal bytes, 2026-07-28)

A Playwright suite gives every test a fresh context, so each test re-downloads from cold
everything a real browser would already hold: bundles, fonts, icons — and static DATA.
Suite totals therefore understate what a transport can reach. `ports/report-marginal.mts`
re-derives the comparison over the bytes a warm cache would still have to fetch:

    n8n, same committed arms                         baseline    ported    delta
      suite total (what we published)                6132 MB    6095 MB    -0.6%
      marginal (warm cache)                           934 MB     873 MB    -6.6%
      elided as static repeats                       5198 MB    5223 MB
      session carried                                            850 MB  = 97.4% of marginal

A repeat is elided only when BOTH hold: (1) STATIC BY EVIDENCE — every 2xx fetch of that
exact path returned the same size within 1% (an on-the-fly compressor is not
byte-deterministic: nodes.json came back 1456264 B on 677 of 694 fetches and 1456842 B on
16); and (2) ON HTTP IN BOTH ARMS — compared on the hash-stripped filename, since a chunk
is renamed between builds. Rule 2 is what keeps the delta honest: a path the port moved
onto the socket is invisible to the HTTP log, so eliding it would subtract from one arm
what the other still pays. n8n's `/rest/community-node-types` is exactly that case and
keeps its full price on both sides.

Rule 1 deliberately catches static DATA as well as assets — the point of the exercise.
n8n serves `/types/nodes.json` (1.46 MB compressed, 694 fetches) and
`/types/credentials.json` from disk; both are byte-identical in both arms and together
were 53% of the first marginal figure.

**The corrected picture is not a headline — it is a dead end, and that is the finding.**
Marginal comes out at 934 MB -> 873 MB (-6.6%), decomposing as 97.4% addressable x 6.7%
per-slice, which matches the 7.0% `report-anatomy.mts` derived from request shape alone.
But **95.1% of that 934 MB is ONE endpoint**: `/rest/community-node-types`, 888 MB — and
that endpoint is static by the very evidence used to elide everything else, **1 distinct
body size across all 510 fetches**, across different test users.

It escapes elision only through rule 2, because it moved onto the session where bytes are
a SINGLE COUNTER rather than a per-path log — eliding its repeats on the baseline side
alone would flatter the port. That is an instrument limitation, not a principle. A warm
cache fetches this payload ONCE in BOTH arms, so excluding it from both is what the model
demands, and the baseline then splits:

    baseline marginal                                934 MB
      the catalogue (/rest/community-node-types)     888 MB
      byte-stable small API                           10 MB
      genuinely varying                               36 MB
      -> non-catalogue remainder (many-small slice)   46 MB
    ported equivalent                                NOT DERIVABLE from the artifacts

Note the 10 MB: "byte-identical on every fetch" proves a file never changes, it does NOT
prove a browser may reuse it. `/rest/module-settings` is stable and still re-fetched on
every page load in production, so folding it into "static" understated the many-small
slice as 36 MB when it is 46 MB. The fix is to stop guessing — `http-log-proxy.mts` now
records `cache-control` and `etag`, so cacheability comes from the server's own
declaration; logs written before that change carry the size heuristic and its caveat.

Those 46 MB are the many-small-requests slice — the number that would actually test the
request-shape predictor — and it is now MEASURED (`ports/n8n/report-smallslice.mts`,
editor chunk, budget mode, advisory on). The advisory is what made it measurable: with
the 12.66 MB catalogue back on browser HTTP, the session's TCP counter contains only the
small calls.

    baseline, small /rest/* over HTTP     12.17 MB  in 6605 requests
      of which request headers             6.10 MB  (50.2%)
      of which response bodies             6.07 MB
    ported, same traffic                    5.94 MB
      over the session                      4.19 MB  (TCP-true, deflate included)
      still on browser HTTP                 1.74 MB  in 592 requests
    -> AT LEAST 51.2% cheaper

Two corrections are baked into that figure, both found by challenging it rather than
publishing the first number. Counting only the session's counter compares baseline's
WHOLE small-API against a fraction of the ported one — 592 small calls never cross (the
force-browser seam, mocked routes) and omitting their 1.74 MB overstated the win by 14
points, 65.5% -> 51.2%. And the delta is not a pure per-call comparison: the ported arm
makes **3078 small-API calls against the baseline's 6605, 53% fewer**, because
conditional crossings serve repeats from the session's own cache. So the result is call
ELIMINATION plus cheaper calls, and quoting it as evidence for per-request overhead
alone would be wrong.

It is a BOUND rather than a point estimate: 5 crossings of the catalogue still occurred
in the run's first 13 seconds, because the advisory is learned and only declared in
hellos issued after the first oversize reply completes — sessions opening inside that
window miss it. Those frames inflate the ported side only, so the true win is larger.
That window is a real product gap on a cold gateway, not just a measurement nuisance.

The mechanism is visible in the split: **half the baseline's small-API bytes are request
headers** — cookies, UA, accept, repeated across 6605 requests — which a persistent
session removes outright, before any body compression against a shared window. This is
the request-shape predictor holding up under direct measurement, and it is invisible in
the suite headline: -65% on a 46 MB slice reads as -0.6% once ~5 GB of harness-repeated
bundles are in the denominator.

Two further facts finish n8n off as a byte story. There were **zero 304s in either arm** —
fresh contexts hold no cached copy to revalidate, so the harness cannot exercise caching
at all, and in production this payload would be fetched once rather than 510 times. And it
is on the socket only because `autoSession` routes the app's whole REST client there; no
per-endpoint decision was ever made about it. The **browse advisory** (the wall-regression
fix) now returns >1 MB replies to browser HTTP, removing it from the session and with it
essentially the whole measured delta — traded to remove a 12-14% wall regression. That is
the right trade for a transport that must not cost time, and n8n should not be quoted as a
byte win at all.
PENDING: a post-advisory truth pair to measure that collapse rather than infer it.

Two consequences for the study:

- Report the decomposition, not just the headline. "Parity" on an app whose bytes are
  85% unreachable is a different fact from "parity" on an app the transport fully
  serves, and only the decomposition distinguishes them.
- Expect the distribution across 10–20 apps to be bimodal by workload shape, and say so
  in advance rather than discovering it in the median. Chat/CRUD/dashboard apps with
  chatty small APIs should land near vikunja; apps that ship large static catalogues to
  the browser should land near n8n.

## Candidate pipeline (selection is a constraint problem, and the constraints are hard)

Ported: vikunja (win), strapi, nocodb, n8n (parity). What actually eliminates candidates,
learned by checking rather than guessing:

- **No Docker daemon.** The sandbox has the client, not the daemon, so any app whose e2e
  stack is docker-compose is out regardless of merit: Ghost (Caddy/MySQL/Redis/Mailpit),
  immich, outline, plane, cal.com, mattermost, rocket.chat.
- **A BROWSER suite, not an API suite.** The workload must be the app's own browser
  journeys, since that is what we measure. Directus's `tests/e2e` is Vitest against the
  API — no browser, so nothing to port.
- **A convertible data path.** GraphQL-only (twenty) and socket.io-only (uptime-kuma)
  apps give the REST adapter nothing to serve; a local-first app (actual budget) barely
  talks to a server at all. These are not failures of the transport, they are
  out-of-scope workloads, and saying so up front beats discovering it after a port.

**Next: Grafana.** Go backend on SQLite by default, React frontend, Playwright at the
repo root (`yarn e2e:playwright`), no Docker. Its frontend routes every call through one
fetch-based `backendSrv`, so the adapter has a single seam instead of a scatter of call
sites.

It is chosen to TEST THE MODEL, not just to add a row. The decomposition above predicts,
in advance and falsifiably: a **high per-slice win** (dashboard/datasource/search traffic
is many small JSON responses, where per-request overhead is a large fraction — the
opposite of n8n's 511 responses carrying 96.9% of its addressable bytes), against a
**modest addressable share** (Grafana ships large JS bundles that no transport choice
touches). Estimate 15–35% addressable × >30% per-slice, so a **5–10% suite byte win**.
If Grafana instead lands at parity, the model is wrong and the corpus needs a better
predictor than request shape.

## Fresh floors, 2026-07-26 (current runtime, no relay, pass-parity gated)

Wall re-derived after the week's runtime changes (conditional crossings, raw-body
passthrough, storage-advisory cache, twin bearer). Single run per arm:

    vikunja   195 pairs   total -1%,  median -2%   (parity — matches published)
    strapi    225 pairs   total -18%, median -9%, -882 ms/test   (published -13%/-7%: WIDER now)
    nocodb     84 pairs   total +1%,  median 0%,  -125 ms median delta   (parity — matches)
    n8n       673 pairs   total -0.0%, median 0 ms   (2026-07-28, with the browse advisory)

n8n's former +13%/+1.1s-per-session wall regression closed 2026-07-28: it was one
endpoint's 12.66 MB reply crossing the session as a single main-thread ws frame every
session. The general fix is the byte decomposition above turned into a routing rule —
the gateway learns oversize GET replies (TIERLESS_BROWSE_OVER, default 1 MB plaintext)
and later hellos return those paths to stock browser fetch (ports/n8n/README.md).

Incident worth recording: nocodb's stock BASELINE arm wedged at 17/282 for 2.4 h once
(no tierless in the page; no live browser worker; RAM/disk healthy) and passed cleanly
on retry — wall drivers now carry a hard per-arm timeout and a completeness gate so a
wedge costs 95 minutes and a killed run can never checkpoint as an arm.

## Artifact policy

Derived summaries (per-test measure rows, report outputs) commit PLAIN — they are the
numbers quoted. Raw per-request wire logs commit GZIPPED (~10x; they were 505k of a
513k-line branch diff) — they are evidence, re-derivable by re-running a driver.
Analyzers read either form through `ports/read-jsonl.mts`.

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
