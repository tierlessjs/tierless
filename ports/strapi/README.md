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

    patches/0002-tierless-auto-session.patch    getFetchClient.ts: fetchAdapter + autoSession
                                                at the same 4 call sites (61 lines)

plus `yarn workspace @strapi/admin add tierless@link:…` (a dependency install, not a
diff — setup.sh). One test patch (BOTH arms): 0001 measure-config (34 lines —
baseURL + sandbox-TLS flag, generation-time env reads their runner JSON.stringifies).
Everything else arrives from OUTSIDE the tree: the transport-agnostic waits ride
NODE_OPTIONS (`tierless/playwright-register`), the reporter rides their runner's own
`--reporter` passthrough, stock-arm gzip is a relay (ports/gzip-proxy.mts), and the
gateway is `tierless gateway --cookie-authority` on :8100. What the port does:

1. **The adapter** (`fetchAdapter` from tierless/adapt-fetch) routes every crossable
   request through a tierless resource request (origin-relative path, explicit
   headers — the Authorization bearer their client attached rides in the request; no
   ambient authority), and rebuilds the reply into a real `Response` for their own
   `responseInterceptor`. NOT crossable — stock fetch, decided per request by
   declared semantics: FormData bodies (media uploads), requests not negotiating
   JSON (their client omits `Accept: application/json` exactly when responseType is
   blob/text/arrayBuffer), and URLs leaving the backend origin. **Auth flows cross
   too**: login's reply sets the httpOnly refresh cookie, which no
   script-reconstructed reply can plant, so the gateway seals every mediated
   Set-Cookie into an opaque blob the page carries on later crossings, and a
   short-lived claim ticket's HTTP replay keeps the REAL jar current — their
   raw-fetch token refresh and their suite's own `httpOnly: true` assertions read
   the jar, not the blob. Cookie mediation auto-engages from the gateway's hello
   (`sealed: true`); `autoSession({awaitClaims: true})` holds rotating crossings
   until their claim lands. Authority still travels per request; the gateway stores
   none of it and a restart self-heals.
   One deliberate divergence from the axios-adapter posture: **AbortSignal is handled
   browser-side** (abort races the crossing; the caller sees an immediate AbortError,
   the late reply is discarded) instead of pinning to stock — Strapi's RTK Query layer
   attaches a signal to EVERY request, so signal-pins would leave nothing at the
   socket. Stock abort also lets the server finish its handler; the divergence is
   wire-only.
2. **The session socket** (`autoSession`): crossings ride ONE websocket to the CLI
   gateway (`tierless gateway`, :8100 — page origin + 100, a convention that holds
   through measurement relays via passthroughs) colocated with the backend;
   gateway→backend is localhost. permessage-deflate WITH context takeover: one
   deflate window for the whole session. The gateway is exec-only (no compiled
   surfaces yet) and holds no credentials. Backend RESTARTS (content-type-builder
   flows) cost nothing: the gateway fetches per request, so a restarted backend just
   serves the next crossing.

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
reports — bytes AND network wait. Timing claims use two extra repetition passes per
cell and `report-time.mts` with comma-separated run lists (medians of 3); the
compressed-stock pair is `STRAPI_TIERLESS_GZIP=1` on the truth arms. Transport
note: this sandbox's proxy blocks
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
- Adapter certified at smoke level: admin/login green with crossings on a
  direct-fetch exec. Session socket: the full CE suite below.

## What the suite caught (the requirements list this app contributes)

Three real boundary defects, each fixed at the right layer rather than worked around:

1. **Cookie-writing responses cannot cross — without a cookie-authority layer.**
   Login's reply sets the httpOnly refresh cookie; a Response reconstructed from a
   crossing cannot write the cookie jar. Their own suite asserts the cookie after
   login and caught it. First treatment: auth flows browser-pinned by MEANING.
   Final treatment: sealed cookie authority — the layer the n8n port built — lets
   them cross while the claim replay keeps the real jar current; the pin is gone
   and the same assertions pass.
2. **Harness waits can assert the REQUEST, not just the reply.** Their i18n specs
   match `waitForRequest(...).postDataJSON()` on `uid/generate` — the exec log
   recorded only replies, so the accommodation had nothing to race. Fix in the
   RUNTIME: the opt-in exec log now records each crossing's own payload (`reqBody`),
   and the transport-agnostic waits grew `waitForTransportRequestBody` (assertions
   preserved intact).
3. **A ported app reaches network-quiet earlier, and load-state waits notice.** This
   sandbox MITMs outbound TLS, so the admin's github release check dies with a cert
   error Playwright never sees finish; the phantom in-flight request wedges
   `networkidle` waits once their preview page's (stock-CSP-refused) iframe forces a
   lifecycle recalculation. Stock kept passing only because it loses the race more
   slowly. Fix: `TIERLESS_IGNORE_HTTPS_ERRORS` (test patch 0001, both arms) lets the
   proxied request complete; a normal network never hits this.

## The suite at the socket (2026-07-19, results/*-truth.jsonl — the 95-line packaged cut)

Both arms by one command each (`TIERLESS_WIRE_TRUTH=1 node ports/strapi/suite.mts
[--baseline]`, orchestrated by ports/drive-arms.mts). 289 paired tests; 224
pass-parity pairs (62 symmetric skips — EE- and future-flag-gated specs on the CE
lane — plus the three one-off flakes below); 217 of 224 touch the session socket
(the rest are reporter-attribution dropouts, see caveat).

    API+ws bytes   90.8 MB -> 7.6 MB   (92% less IO)
    per test       median 92% fewer bytes (p10 91%, p90 93%)
    ported split   7.38 MB session ws (deflate included) + 0.21 MB residual HTTP —
                   with auth flows on the socket (cookie mediation auto-engages
                   from the gateway hello) the residual is only the by-design
                   pins: FormData uploads, non-JSON responses, and their raw-fetch
                   token refresh.
    best case      1,537 KB -> 132 KB (content-type builder: add attribute to component)
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

`STRAPI_TIERLESS_GZIP=1` puts a gzip RELAY (ports/gzip-proxy.mts — the nginx
posture) in front of the app origin for browser-facing traffic. The default
measured stack stays what their CI runs (raw); this pair answers "what if they
deployed compression":

    stock, gzip              90.8 MB -> 30.4 MB (gzip cuts stock's traffic 66%)
    ported+gzip vs it        30.4 MB -> 7.6 MB   (75% less IO; median per-test 71%)
                             — the SYMMETRIC pair; ported(raw) vs it is the same 75%
                             (the ported arm's residual direct HTTP barely compresses)

Compression captures about two thirds of the raw gap; the port's win over a
compressed stock is structural — bodies that never repeat across a session-long
deflate window, headers that never re-send — the same shape as NocoDB (where gzip
captured a third) and Vikunja (half): payload-size distribution decides how much of
the win is compressible.

Pass sets: every test that runs on the CE lane passes on BOTH arms, except three
one-off UI-timing flakes excluded by the pass-parity gate this pairing:
blocks.spec.ts:13 (the Blocks editor fill — a known repeat offender, stock-side
this time), conditional-fields visibility, and the preview iframe wait (each
failed once ported-side and passed a targeted re-run, 6/6 with 1 skip). None is
at a transport seam; the sealed-auth flows themselves (login/logout/re-login as a
second user, cookie assertions incl. httpOnly) pass everywhere. One real race an
earlier pairing DID catch: the fire-and-forget claim can replant the refresh
cookie a beat after a clearCookies that raced it (stock fetch applies Set-Cookie
synchronously with the response). Fixed at the runtime layer: `awaitClaims` holds
a ROTATING crossing until its claim lands — auth flows only, the data plane never
rotates. On this cut it engages via autoSession({awaitClaims: true}) in patch 0002.

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

## Shaped timing (2026-07-19, results/floor-*.jsonl x3, rtt80-*.jsonl x3 — medians of 3)

Produced by the generic driver (`node ports/drive-arms.mts strapi --rtt 80`) plus
two repetition passes per cell, interleaved across arms: single runs of this suite
swing by minutes (an earlier pass read the ported floor 18% fast, another 20% slow),
so every per-test duration below is the MEDIAN of 3 runs per cell
(`node ports/report-time.mts` with comma-separated run lists). RTT is injected for
real on both browser-facing hops (raw TCP relays, TCP_NODELAY), the
gateway->backend hop stays undelayed localhost, and the settled metric is NETWORK
WAIT = dur@RTT − dur@unshaped-floor per test. RTT-20 was dropped earlier for this
suite (fully variance-dominated at 20 ms) — 80 ms is the instrument.

At RTT 80, medians of 3, over 205 tests passing in all twelve runs:

    RTT-0 floor           2,696 s baseline / 2,191 s ported — the ported build runs
                          the suite ~19% (8.4 min) FASTER at localhost, reproducible
                          across all three floor pairs: 92% fewer bytes, and session
                          frames replacing per-request browser scheduling and Koa
                          middleware work that no longer happens. (An earlier single-run
                          pass saw this, was corrected to "variance", and the
                          correction was itself the variance casualty — medians of 3
                          settle it.)
    network-wait pool     220 s baseline; pool share of wall 8% — the ceiling ANY
                          transport work has here. Pool TOTALS stay noise-dominated
                          even at 3 runs (38 of 205 tests measure a negative net);
                          medians and the decile are the quotable numbers.
    median per test       1,422 -> 1,332 ms network wait (6% less)
    network-bound decile  the top 21 tests by baseline net wait: 99.8 s -> 40.5 s
                          (59% of that pool removed), median 4,121 -> 1,312 ms —
                          where network dominates, the port removes most of it.

The verdict, third app in a row, now sharper: per-interaction crossings pay
per-interaction RTTs (this app's stock API was already same-origin keep-alive HTTP —
no preflights to eliminate), so suite-wide network-wait medians move single digits —
but the network-BOUND tests improve 3x, and the RTT-0 floor win is real and large
on this request-heavy suite. Restructuring flows (§6 chains / migrations — not
shipped in this port) is where the remaining 8% pool moves.

## Re-cut on the packaged surface (2026-07-16; all arms re-measured on this cut 2026-07-19)

The recipe now rides the packaged port surface — 897 → 95 patch lines:

    patches/0002-tierless-auto-session.patch (61)  THE PORT: adapt-fetch + autoSession at the
                                                   same four call sites (replaces the earlier
                                                   hand-rolled adapter, socket, and cookie
                                                   authority — cookie mediation now
                                                   auto-engages from the gateway's hello)
    patches/0001-measure-config.patch (34)         baseURL + sandbox-TLS flag only — these are
                                                   GENERATION-time env reads (their runner
                                                   JSON.stringifies the base config), the one
                                                   channel a wrapper can't reach

Everything else arrives from outside the tree: the waits ride NODE_OPTIONS
(`tierless/playwright-register` — their runner owns the Playwright invocation, so the
nocodb-style `--config` wrapper isn't ours to pass; the standard Node preload reaches
the runner and every worker), the reporter rides their runner's own flag passthrough
(`--reporter=line,<abs>`), stock-arm gzip is the shared relay (ports/gzip-proxy.mts —
the retired 0005 enabled their own koa middleware; the relay is the nginx posture),
and the gateway is `tierless gateway --cookie-authority` on :8100 (page+100).

VERIFIED in this sandbox (2026-07-16): both variants built; floor arms over the
wait-heavy subset (admin home/tokens + content-manager blocks) — **18 tests per arm,
identical ids, EXACT status parity: 16 passed / 1 skipped / 1 failed on both**, the one
failure arm-symmetric (blocks.spec.ts code-block, fails identically on stock — falls
out of the parity gate). Wire-truth smoke on the admin domain: 6/6 passed with 169 KB
of real session-ws bytes — the crossings ride the socket through the register-delivered
waits and the CLI gateway's cookie authority. The verification also caught and fixed a
harness gap: on shaped/counted arms the page's origin is the relay, so the page+100
convention now holds THROUGH relays (passthroughs at 28100/18100). Every measured
number above — truth pair, gzip pair, and the medians-of-3 shaped arms — was driven
on THIS cut (2026-07-19); nothing quoted predates it.
