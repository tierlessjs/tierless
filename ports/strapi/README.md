# Strapi port (v5.50.1, sha e2c7129f)

Third corpus app (docs/corpus.md rung 3): the porting recipe on a CMS ADMIN workload —
the request shapes the first two apps lacked. Strapi's admin is an RTK-Query app:
navigations fire bursts of small settings/permissions/init GETs, the content manager
mixes list pages with per-document GET/PUT/publish cycles, the content-type builder
edits schemas and RESTARTS the backend mid-flow, and every test seeds through a
node-side DTS reset. It is also the first corpus app that serves its admin assets and
its API on ONE origin, and the first whose client bottom is plain `fetch`, not axios.

## The target

- Frontend: React 18 + Redux/RTK Query admin, built by **Vite** through Strapi's own
  `strapi build`/`develop` machinery (`packages/core/strapi/src/node/vite/`).
- Client I/O bottom: `getFetchClient` (packages/core/admin/admin/src/utils/
  getFetchClient.ts) — four raw `fetch(...)` call sites under everything: default
  headers, token refresh, FetchError shaping, and RTK Query's `baseQuery` all sit
  above it. Auth is a **Bearer header** their client attaches per request (localStorage
  or a JS-readable cookie); the refresh token is an httpOnly cookie used only by the
  auth endpoints.
- Backend: Node (Koa + Knex), **better-sqlite3 lane** for tests (their e2e runner
  generates each test app with `sqlite`).
- Their own workload: **tests/e2e — 87 spec files, ~249 tests** across 9 domains
  (admin, content-manager, content-type-builder, i18n, media-library, search,
  settings + the EE-gated content-releases and review-workflows). The runner
  (`tests/scripts/run-tests.js`) yalc-links the monorepo packages into a generated
  test app, boots `develop --no-watch-admin` per domain (vite-builds the admin at
  boot), and runs Playwright with `workers: 1`.
- License: **MIT** (CE). The recipe runs the CE lane (`STRAPI_E2E_EDITION=ce`, no
  license); EE-gated specs skip.

## The diff to their app

    patches/0002-tierless-fetch-adapter.patch   getFetchClient.ts: 4 call sites -> tierlessFetch
                                                + tierlessFetch.ts (new, ~120 lines): the I/O bottom
    patches/0003-session-socket.patch           tierlessFetch.ts: the exec becomes the session socket
    patches/0006-sealed-cookie-authority.patch  tierlessFetch.ts: auth flows cross too (see below)

plus `yarn workspace @strapi/admin add tierless@link:…` (a dependency install, not a
diff — setup.sh). Test patches (BOTH arms): 0001 measure reporter + relay-able
baseURL, 0004 transport-agnostic waits, 0005 env-gated stock gzip. What the port does:

1. **The adapter** (0002) routes every crossable request through a tierless resource
   request (`api.<method>`, origin-relative path, explicit headers — the Authorization
   bearer their client attached rides in the request; no ambient authority), and
   rebuilds the reply into a real `Response` for their own `responseInterceptor`.
   NOT crossable — stock fetch, decided per request by declared semantics:
   FormData bodies (media uploads), requests not negotiating JSON (their client omits
   `Accept: application/json` exactly when responseType is blob/text/arrayBuffer),
   and URLs leaving the backend origin. **Auth flows cross too** (patch 0006 —
   sealed cookie authority, the session-auth layer the n8n port built): login's reply
   sets the httpOnly refresh cookie, which no script-reconstructed reply can plant,
   so the gateway seals every mediated Set-Cookie into an opaque blob the page
   carries on later crossings, and a short-lived claim ticket's HTTP replay keeps
   the REAL jar current — their raw-fetch token refresh and their suite's own
   `httpOnly: true` assertions read the jar, not the blob. Authority still travels
   per request; the gateway stores none of it and a restart self-heals.
   One deliberate divergence from the axios-adapter posture: **AbortSignal is handled
   browser-side** (abort races the crossing; the caller sees an immediate AbortError,
   the late reply is discarded) instead of pinning to stock — Strapi's RTK Query layer
   attaches a signal to EVERY request, so signal-pins would leave nothing at the
   socket. Stock abort also lets the server finish its handler; the divergence is
   wire-only.
2. **The session socket** (0003): crossings ride ONE websocket to a standalone gateway
   (ports/strapi/gateway.mts, :8180) colocated with the backend; gateway→backend is
   localhost. permessage-deflate WITH context takeover: one deflate window for the
   whole session. The gateway is exec-only (no compiled surfaces yet) and holds no
   credentials. Backend RESTARTS (content-type-builder flows) cost nothing: the
   gateway fetches per request, so a restarted backend just serves the next crossing.

## Reproduce

    bash ports/strapi/setup.sh              # fetch at the pinned sha, verify tree hash,
                                            # yarn install + build, link tierless, browsers
    node ports/strapi/suite.mts             # ported arm -> ports/work/strapi/measure.jsonl
    bash ports/strapi/setup.sh --baseline   # stock variant (test patches only)
    node ports/strapi/suite.mts --baseline

    TIERLESS_WIRE_TRUTH=1 node ports/strapi/suite.mts [--baseline]   # byte accounting
    TIERLESS_RTT_MS=20 node ports/strapi/suite.mts [--baseline]      # shaped timing
    TIERLESS_DOMAINS="admin" TIERLESS_SPEC="login.spec.ts" ...       # subset iteration

`node ports/drive-arms.mts strapi --rtt 80` is the STANDARD result: all six arms
(floors, truth, RTT 80), idempotent with per-arm checkpoint commits, ending in both
reports — bytes AND network wait. `drive-truth.sh` remains the first-time path (it
adds the sealed-auth smoke gate before the long arms); `drive-gzip.sh` adds the
compressed-stock pair. Transport note: this sandbox's proxy blocks
codeload zips for out-of-scope repos; the recipe's `git` transport (shallow clone at
the release tag, checkout verified against the pinned sha) is the one that works
here. The tree hash pins content either way.

Runtime facts, verified in this sandbox (2026-07-12):

- Their vendored yarn 4.12.0 (`.yarn/releases`, via corepack). `yarn build:code` is
  NOT enough — `strapi develop` loads `@strapi/types/dist` at runtime; full
  `yarn build` is required.
- `@playwright/test` 1.56.1 wants chromium-1194 — exactly this sandbox's preinstalled
  set (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`); no download needed.
- The runner's yalc push→app propagation missed `@strapi/admin` (absent from yalc's
  installations registry), silently serving a STALE admin bundle. suite.mts passes
  their `-f` (force test-app regeneration) so every arm re-links from the store the
  run just published.

## Measurement design (differs from vikunja/nocodb where the app differs)

- **One origin.** Strapi serves admin assets AND the API on one port, so wire truth
  cannot split traffic by origin. The browser rides an HTTP-MESSAGE counting proxy
  (:28000 → :8000) that classifies per response: JSON content-type = API, everything
  else (HTML/JS/CSS/media) = assets. API bytes are serialized request+response
  messages (start line + headers + body as transmitted) — message-true, not TCP-true;
  chunked framing (~a few bytes per response) is the only wire cost it misses,
  identically on both arms. Session ws bytes ARE TCP-true, counted inside the gateway
  (deflate included). report.mts's "TCP-TRUE" provenance line therefore overstates
  slightly for this port's HTTP side — the ws side, where the port's traffic lives,
  is socket-level.
- **Assets are excluded from the comparison** (report.mts sums wireApi* + wireWs*
  only). Each test's fresh browser context refetches the ~6.4 MB admin bundle; both
  arms pay it identically, and counting it would drown the API signal.
- **Node-side seeding is never counted**: the per-test DTS reset talks to :8000
  directly; only the browser uses the counting proxy (TIERLESS_BASE_URL, test patch
  0001 routes Playwright's baseURL and the storage-state origin through it).

## Status

- Recipe pinned and fetched (git transport, tree hash verified); patch series applies
  cleanly to a pristine tree and reproduces the measured work tree byte-for-byte.
- Adapter (0002) certified at smoke level: admin/login green with crossings on a
  direct-fetch exec. Session socket (0003): the full CE suite below.

## What the suite caught (the requirements list this app contributes)

Three real boundary defects, each fixed at the right layer rather than worked around:

1. **Cookie-writing responses cannot cross — without a cookie-authority layer.**
   Login's reply sets the httpOnly refresh cookie; a Response reconstructed from a
   crossing cannot write the cookie jar. Their own suite asserts the cookie after
   login and caught it. First treatment: auth flows browser-pinned by MEANING.
   Final treatment (patch 0006): sealed cookie authority — the layer the n8n port
   built — lets them cross while the claim replay keeps the real jar current; the
   pin is gone and the same assertions pass.
2. **Harness waits can assert the REQUEST, not just the reply.** Their i18n specs
   match `waitForRequest(...).postDataJSON()` on `uid/generate` — the exec log
   recorded only replies, so the accommodation had nothing to race. Fix in the
   RUNTIME: the opt-in exec log now records each crossing's own payload (`reqBody`),
   and test patch 0004 grew `waitForTransportRequestBody` (assertions preserved
   intact).
3. **A ported app reaches network-quiet earlier, and load-state waits notice.** This
   sandbox MITMs outbound TLS, so the admin's github release check dies with a cert
   error Playwright never sees finish; the phantom in-flight request wedges
   `networkidle` waits once their preview page's (stock-CSP-refused) iframe forces a
   lifecycle recalculation. Stock kept passing only because it loses the race more
   slowly. Fix: `TIERLESS_IGNORE_HTTPS_ERRORS` (test patch 0001, both arms) lets the
   proxied request complete; a normal network never hits this.

## The suite at the socket (2026-07-13, results/*-truth.jsonl; ported arm re-run
## under sealed cookie authority — patch 0006)

Both arms by one command each (`TIERLESS_WIRE_TRUTH=1 node ports/strapi/suite.mts
[--baseline]`, orchestrated end-to-end by drive-truth.sh). 289 paired tests; 225
pass-parity pairs (62 symmetric skips — EE- and future-flag-gated specs on the CE
lane — plus the two flakes below); 216 of 225 touch the session socket (the rest are
reporter-attribution dropouts, see caveat).

    API+ws bytes   97.7 MB -> 7.9 MB   (92% less IO)
    per test       median 92% fewer bytes (p10 91%, p90 94%)
    ported split   7.65 MB session ws (deflate included) + 0.22 MB residual HTTP —
                   with auth flows on the socket (patch 0006) the residual is only
                   the by-design pins: FormData uploads, non-JSON responses, and
                   their raw-fetch token refresh. (Auth-pinned, the residual was
                   0.92 MB; that arm's suite-wide number was the same 92%.)
    best case      1,335 KB -> 194 KB (admin home: the key-statistics widget flow)
    asset traffic  ~6.4 MB per test (each test's fresh context refetches the admin
                   bundle) — identical on both arms, excluded from the comparison
    uncounted      reseal/claim ride plain HTTP to the gateway (a claim must be an
                   HTTP response — that is where httpOnly can be planted): ~1 KB per
                   login, outside both counters, port-side overhead if counted

Why the number matches NocoDB's 92-94% rather than Vikunja's 13-35%: their Koa
backend serves raw, uncompressed JSON (no compression middleware in their template or
CI lane), the admin's init/permissions/settings payloads repeat heavily across a
session, and one deflate window amortizes all of it.

### Apples-to-apples: against a COMPRESSED stock (results/truth-*-gzip.jsonl)

Test patch 0005 enables Strapi's own shipped compression middleware
(`strapi::compression`, koa-compress) under `STRAPI_TIERLESS_GZIP=1`. The default
measured stack stays what their CI runs (raw); this pair answers "what if they
deployed compression":

    stock, gzip              98.3 MB -> 32.6 MB api bytes (gzip cuts stock's API 67%)
    ported+gzip vs it        32.5 MB -> 8.1 MB   (75% less IO; median per-test 72%)
                             — the SYMMETRIC pair; ported(raw) vs it is the same 75%
                             (the ported arm's residual direct HTTP barely compresses)

Compression captures about two thirds of the raw gap; the port's win over a
compressed stock is structural — bodies that never repeat across a session-long
deflate window, headers that never re-send — the same shape as NocoDB (where gzip
captured a third) and Vikunja (half): payload-size distribution decides how much of
the win is compressible.

Pass sets: every test that runs on the CE lane passes on BOTH arms, except two
UI-timing flakes excluded by the pass-parity gate: blocks.spec.ts:13 (the Blocks
editor fill — has failed single runs on EACH arm across the four full pairings) and
rbac/permissions-enforcement.spec.ts:14 (a toast wait; failed one ported full run,
then passed three consecutive re-runs including its full domain). Neither failure is
at a transport seam; the sealed-auth flows themselves (login/logout/re-login as a
second user, cookie assertions incl. httpOnly) pass everywhere.

Caveats:

- HTTP bytes are message-true (serialized request+response, headers included), not
  raw-TCP; session ws bytes ARE TCP-true, counted inside the gateway. See
  "Measurement design" above.
- Per-test wire attribution is best-effort (Playwright does not await async reporter
  hooks): a handful of rows credit a test's bytes to its neighbor — visible as
  0-byte outliers, excluded from the covered subset; medians and the suite totals
  are the robust numbers.
- Wall clock from the truth runs is NOT quotable on its own: the counting proxy adds
  a hop per HTTP request, which taxes the request-heavy stock arm — the shaped runs
  below are the timing instrument (their proxy-free floors reproduce the wall gap,
  so it is real, but quote it from there).

## Shaped timing (2026-07-14, results/floor-*.jsonl, rtt80-*.jsonl — sealed-authority build)

The standard result is now produced by the generic driver — all six arms, both
reports, one command (`node ports/drive-arms.mts strapi --rtt 80`): bytes alone is
half the headline; network wait is the half a flow rewrite actually targets. RTT is
injected for real on both browser-facing hops (raw TCP relays, TCP_NODELAY), the
gateway->backend hop stays undelayed localhost, and the settled metric is NETWORK
WAIT = dur@RTT − dur@unshaped-floor per test (`node ports/report-time.mts`). The
RTT-20 arms from the first pass were dropped with the auth-pinned build: at 20 ms
this suite's decomposition was fully variance-dominated (the baseline pool itself
measured negative) — 80 ms is the instrument.

At RTT 80, over 212 tests passing in all four runs:

    unimprovable floor    2,640 s baseline / 2,665 s ported — PARITY
    network-wait pool     ~300 s baseline; pool share of wall 10% — the ceiling ANY
                          transport work has here. The pool-total comparison is
                          variance-dominated (96 of 212 tests measure a negative net
                          component; the ported pool total lands below zero).
    median per test       1,411 -> 1,290 ms network wait (9% less)
    wall clock            49.5 -> 44.5 min total (median per-test 1% — tail-dominated)

The verdict, third app in a row: per-interaction crossings pay per-interaction RTTs
(this app's stock API was already same-origin keep-alive HTTP — no preflights to
eliminate), so the 92% byte win buys single-digit network-wait medians, not
wall-clock wins. Restructuring flows (§6 chains / migrations — not shipped in this
port) is where the timing ceiling moves; the pool it would work against is 10% of
wall.

CORRECTION (2026-07-14): the first shaped pass measured the auth-pinned ported
floor ~18% below baseline's, and this README attributed the gap to per-request
processing overhead. The re-run on the sealed-authority build does not replicate it
(floors are parity, and the sealed-auth blob work cannot account for a 25% floor
swing) — the gap was single-run sandbox variance. Wall-clock differences at RTT 0
between single runs are not attributable on this rig; the per-test network-wait
MEDIAN under injected RTT is the defensible timing metric, and it reads 9% less.

## The suite at the socket (2026-07-13, results/*-truth.jsonl; ported arm re-run
## under sealed cookie authority — patch 0006)

Both arms by one command each (`TIERLESS_WIRE_TRUTH=1 node ports/strapi/suite.mts
[--baseline]`, orchestrated end-to-end by drive-truth.sh). 289 paired tests; 225
pass-parity pairs (62 symmetric skips — EE- and future-flag-gated specs on the CE
lane — plus the two flakes below); 216 of 225 touch the session socket (the rest are
reporter-attribution dropouts, see caveat).

    API+ws bytes   97.7 MB -> 7.9 MB   (92% less IO)
    per test       median 92% fewer bytes (p10 91%, p90 94%)
    ported split   7.65 MB session ws (deflate included) + 0.22 MB residual HTTP —
                   with auth flows on the socket (patch 0006) the residual is only
                   the by-design pins: FormData uploads, non-JSON responses, and
                   their raw-fetch token refresh. (Auth-pinned, the residual was
                   0.92 MB; that arm's suite-wide number was the same 92%.)
    best case      1,335 KB -> 194 KB (admin home: the key-statistics widget flow)
    asset traffic  ~6.4 MB per test (each test's fresh context refetches the admin
                   bundle) — identical on both arms, excluded from the comparison
    uncounted      reseal/claim ride plain HTTP to the gateway (a claim must be an
                   HTTP response — that is where httpOnly can be planted): ~1 KB per
                   login, outside both counters, port-side overhead if counted

Why the number matches NocoDB's 92-94% rather than Vikunja's 13-35%: their Koa
backend serves raw, uncompressed JSON (no compression middleware in their template or
CI lane), the admin's init/permissions/settings payloads repeat heavily across a
session, and one deflate window amortizes all of it.

### Apples-to-apples: against a COMPRESSED stock (results/truth-*-gzip.jsonl)

Test patch 0005 enables Strapi's own shipped compression middleware
(`strapi::compression`, koa-compress) under `STRAPI_TIERLESS_GZIP=1`. The default
measured stack stays what their CI runs (raw); this pair answers "what if they
deployed compression":

    stock, gzip              98.3 MB -> 32.6 MB api bytes (gzip cuts stock's API 67%)
    ported+gzip vs it        32.5 MB -> 8.1 MB   (75% less IO; median per-test 72%)
                             — the SYMMETRIC pair; ported(raw) vs it is the same 75%
                             (the ported arm's residual direct HTTP barely compresses)

Compression captures about two thirds of the raw gap; the port's win over a
compressed stock is structural — bodies that never repeat across a session-long
deflate window, headers that never re-send — the same shape as NocoDB (where gzip
captured a third) and Vikunja (half): payload-size distribution decides how much of
the win is compressible.

Pass sets: every test that runs on the CE lane passes on BOTH arms, except two
UI-timing flakes excluded by the pass-parity gate: blocks.spec.ts:13 (the Blocks
editor fill — has failed single runs on EACH arm across the four full pairings) and
rbac/permissions-enforcement.spec.ts:14 (a toast wait; failed one ported full run,
then passed three consecutive re-runs including its full domain). Neither failure is
at a transport seam; the sealed-auth flows themselves (login/logout/re-login as a
second user, cookie assertions incl. httpOnly) pass everywhere.

Caveats:

- HTTP bytes are message-true (serialized request+response, headers included), not
  raw-TCP; session ws bytes ARE TCP-true, counted inside the gateway. See
  "Measurement design" above.
- Per-test wire attribution is best-effort (Playwright does not await async reporter
  hooks): a handful of rows credit a test's bytes to its neighbor — visible as
  0-byte outliers, excluded from the covered subset; medians and the suite totals
  are the robust numbers.
- Wall clock from the truth runs is NOT quotable on its own: the counting proxy adds
  a hop per HTTP request, which taxes the request-heavy stock arm — the shaped runs
  below are the timing instrument (their proxy-free floors reproduce the wall gap,
  so it is real, but quote it from there).

## Shaped timing (2026-07-13, results/floor-*.jsonl, rtt20-*.jsonl, rtt80-*.jsonl)

`TIERLESS_RTT_MS=<n> node ports/strapi/suite.mts [--baseline]` — real RTT on both
browser-facing hops (the app origin and the session ws; raw TCP relays, TCP_NODELAY),
gateway→backend on undelayed localhost, as deployed. The settled metric is NETWORK
WAIT = dur@RTT − dur@unshaped-floor per test (`node ports/report-time.mts`).

At 20 ms (225 pass-parity pairs): wall clock 39.6 -> 39.4 min — parity — and the
decomposition is fully variance-dominated (the baseline pool itself measures
NEGATIVE: run-to-run noise exceeds the 20 ms signal). Same verdict as NocoDB at
20 ms. At 80 ms (213 tests passing in all four runs):

    unimprovable floor    2,580 s baseline / 2,123 s ported (see below)
    network-wait pool     318.3 s -> 298.5 s   (6% of the POOL removed)
    median per test       1,412 -> 1,338 ms network wait
    pool share of wall    11% (baseline) — the ceiling ANY transport work has here
    wall clock            48.7 -> 40.5 min (17% less; median per-test 7%)

(The shaped arms measured the auth-pinned build — patch 0006 landed after. Auth
flows were under 1% of suite bytes and their crossings pay the same per-request RTT
as their pinned HTTP did, so neither verdict below moves.)

Two separate timing facts, named separately:

1. **Network wait is parity within noise.** Per-interaction crossings pay
   per-interaction RTTs, and this app's stock API was already same-origin keep-alive
   HTTP (no preflights to eliminate). The 92% byte win does not become RTT wins
   without restructuring flows (§6 chains / migrations — not shipped in this port).
   Third app, same verdict: the timing ceiling lives in the request-per-interaction
   structure.
2. **The wall-clock win is real but it is not network wait — it is per-request
   overhead.** The ported arm's UNSHAPED floor is ~18% faster (2,123 vs 2,580 s), and
   the gap replicates across all four ported runs (floors, both RTTs, and the
   proxy-taxed truth arms agree). Collapsing hundreds of HTTP request lifecycles per
   test into websocket frames saves browser request scheduling and Koa
   per-request middleware work — localhost CPU, visible at RTT 0, linear in request
   count, and honestly attributed to neither bytes nor latency.
