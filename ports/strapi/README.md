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
   URLs leaving the backend origin, and **auth flows** (login/logout/register/reset/
   access-token: their responses SET the httpOnly refresh cookie, and cookie-jar
   writes exist only in the browser — caught by their own e2e suite, which asserts
   the cookie after login).
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

`drive-truth.sh` runs every remaining stage detached and checkpointed (smoke gate,
both truth arms, commit+push per stage). Transport note: this sandbox's proxy blocks
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
  direct-fetch exec. Session socket (0003) green on admin/login + content-manager
  smoke with real ws bytes and residual API HTTP = auth flows only.
- The suite caught one real boundary defect on the way, fixed in the ADAPTER rather
  than worked around: login's reply sets the httpOnly refresh cookie, which a
  reconstructed Response cannot do — auth flows are browser-pinned by meaning
  (the requirements-list entry this app contributes: **cookie-writing responses
  cannot cross**; header-authenticated data planes can).
- Full-suite truth arms: RUNNING (drive-truth.sh) — numbers land here when the arms
  complete.
