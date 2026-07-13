# n8n port (v2.30.3, sha 5c9574c2)

Third corpus app (docs/corpus.md rung 3): a structurally different workload again.
Vikunja was a task app (small chatty CRUD), NocoDB a data grid (sequential meta
chains, paged scrolls); n8n is an **editor SPA** — boot-time request fan-out
(settings, credentials, workflows, node-types metadata measured in megabytes),
save round-trips on a canvas, and a separate push channel. Selection facts,
verified from source at the pinned sha:

- Frontend: Vue 3 + **Vite** (packages/frontend/editor-ui) — the plugin seam exists.
- Service layer: every REST call funnels through ONE `request()` at
  `packages/frontend/@n8n/rest-api-client/src/utils.ts` with **axios** at the
  bottom — the same I/O-bottom seam class as both prior ports, but even
  narrower: per-call config, no instance to patch.
- Backend: Node (Express + TypeORM), **SQLite lane** for their e2e tests; ONE
  process serves the REST API and the built editor from :5680 (single origin).
- Their own workload: **packages/testing/playwright — 884 `test()` calls in 198
  e2e spec files**, first-class local lane (`test:local`): container-gated tags
  (`@capability:*`, `@mode:*`, `@licensed`, `@db:reset`) are grep-inverted out,
  the rest runs against the local SQLite instance. This suite is what their CI
  runs; journeys are theirs, not ours.
- License: **Sustainable Use License** (fair-code) — same posture as NocoDB:
  fine for this benchmarking-and-patch-recipe use (we never vendor their code),
  quote results with the license named.

## What n8n's tree broke first (rung-3 hardening, as designed)

- **Symlinks.** n8n ships directory symlinks (`.claude/plugins/`); the runner's
  tree hash followed nothing and `readFileSync` choked. `ports/run.mts` now
  hashes a symlink as its target string, never following.
- **A codeload-pinned lockfile dep.** `wa-sqlite` is a `github:` dependency —
  pnpm fetches it as a codeload tarball, which some sandboxes proxy away while
  git smart-http stays open. `codeload-shim.mts` (started by setup.sh only
  after probing codeload is actually unreachable) serves the same sha's tree,
  fetched over git, at the same URL — lockfile byte-identical, frozen install
  intact.
- **Cookie authority.** Both prior ports were header-authenticated; n8n's
  `/rest` API authenticates with an httpOnly JWT cookie, and login is an SPA
  transition (no reload). See "The session-socket stage" below — this is the
  requirements-list find of this port.

## The diff to their app

    patches/0002-tierless-axios-adapter.patch   utils.ts: the adapter in the one request() (+20 lines)

plus `pnpm add tierless` in `@n8n/rest-api-client` (a dependency install, not a
diff — setup.sh does it on the ported tree only). Test patches (BOTH arms):

    patches/0001-measure-reporter.patch   playwright.config.ts: measure reporter +
                                          recording off on measured runs + webServer
                                          skip covers the frontend entry; one new
                                          reporter file

What patch 0002 does: n8n's `request()` builds a per-call `AxiosRequestConfig`;
the patch adds a per-call `adapter` — tierless's axios adapter with a
direct-fetch exec bound to THAT call's own `baseURL` origin. Everything above —
their error taxonomy (ResponseError/MFA), param serializer, browser-id header,
the ~50 `api/` modules — runs untouched. Same-origin cookies ride the exec's
fetch exactly as they rode the XHR (n8n sets `withCredentials` only in dev
builds, so production requests never pin on it). Blob/FormData/binary configs
and external origins (`api.n8n.io`) fall through to axios's own XHR adapter.

## The session-socket stage (next; requirements find)

The NocoDB shape — `sessionExec()` over a ws gateway, one exec crossing per
request — needs authority the browser cannot attach per request here: the JWT
lives in an **httpOnly cookie**, and n8n logs in/out as an SPA transition, so
a socket opened on the signin page outlives an auth change. The design that
unblocks it is **gateway-mediated cookie authority** (ROADMAP.md has the full
shape): bind the cookie at ws upgrade (cookies ignore ports, so a same-host
gateway receives it); re-bind on `set-cookie` seen on ANY mediated response —
a property of the exec path, not a login special case, because n8n rolls the
cookie near expiry on arbitrary responses; plant the browser-jar copy via a
one-time-ticket claim request whose HTTP response carries the Set-Cookie
(script cannot write httpOnly, so a ws frame cannot); and on a session-exec
401, drop the binding and re-upgrade — recovery for invalidation that never
crossed this socket (another tab's logout or password change). This recipe
ships the direct-fetch exec (patch 0002); the mediated-authority gateway is
the next stage and where the wire numbers come from.

## Reproduce

    bash ports/n8n/setup.sh                 # fetch + verify + patch + install + build + browsers
    bash ports/n8n/setup.sh --baseline      # stock arm: test patches only, separate tree

    node ports/n8n/suite.mts --baseline     # -> ports/work/n8n-baseline/measure.jsonl
    node ports/n8n/suite.mts                # -> ports/work/n8n/measure.jsonl
    node ports/report.mts ports/work/n8n-baseline/measure.jsonl ports/work/n8n/measure.jsonl

Boot shape (one process): the built cli (`packages/cli/bin/n8n`) serves REST +
editor statics on :5680, SQLite in a per-variant user folder (wiped per boot;
their `RESET_E2E_DB` global-setup wipes rows on top). Readiness bar is theirs:
POST `/rest/e2e/reset` until the controller answers. Suite runs their `e2e`
project, `--workers=1` (per-test wire attribution; their local default is
cpu/2), node-side seeding pinned to the direct origin while the PAGE goes
through a relay when shaping/counting (single origin, so the relay carries
asset bytes too — identical in both arms; the report states provenance).

Runtime facts, verified in this sandbox (2026-07-12):

- Node >= 22.22 required by their engines field; sandbox node 22.22.2 passes.
  pnpm 10.32.1 pinned by their `packageManager` field; corepack activates it.
- Full turbo build: 266 s at concurrency 4 (their agent-setup memory caps).
- `@playwright/test` pinned at 1.60.0; its chromium fetches from the Playwright
  CDN into `$HOME/pw-browsers` (the sandbox's preinstalled set is a different
  revision).
- **740 tests in 139 files** survive the local lane's container-only
  grep-invert (`--project=e2e --list`) — the honest workload count, vs the
  884 spec-level total.
- n8n's default listen address `::` needs IPv6 (absent here) —
  `N8N_LISTEN_ADDRESS=127.0.0.1` in boot.mts.
- Their readiness bar (poll `/rest/e2e/reset` until non-404) has a hole this
  sandbox hits: the "starting up" middleware answers 503 BEFORE controllers
  mount. boot.mts treats only a response that is neither 404 nor "starting
  up" as ready.

## Stock baseline (2026-07-13, results/baseline.jsonl)

Full e2e project, workers=1, measure reporter on (recording off, both arms):

    740 discovered · 666 passed · 37 failed · 33 skipped · 1.6 h wall

Two runs were discarded getting here, each a mechanism worth having on file:

1. **301 failures, one signature.** n8n's auth cookie is `Secure` by default;
   Playwright's node-side cookie jar honors Secure over plain http for a
   literal IP while special-casing the name `localhost`. With
   `N8N_BASE_URL=http://127.0.0.1:5680` every authenticated api-helper call
   401s while browser flows sail (both origins are secure contexts to
   Chromium). suite.mts says `localhost`, like their own scripts.
2. **Server death at test ~500.** `settings/workers/workers.spec.ts` flips the
   instance into queue mode without upstream's own `@mode:queue`
   container-only tag; with no Redis locally n8n exits after 10 s of retries
   and everything after is ECONNREFUSED collateral. Patch 0003 adds the tag
   (test patch, both arms).

The 37 remaining failures are env/flake classes (largest: 10× a null
`services` read; OAuth popups needing external network; assorted timeouts) —
arm-symmetric by construction, dropped by report.mts's pass-parity gate.

## Patch 0002 certified behaviorally invisible (2026-07-13, results/cert-0002-adapter.jsonl)

Full suite on the ported tree, same command as the baseline:

    740 discovered · 667 passed · 36 failed · 33 skipped · 1.6 h — 736 tests
    paired, 663 pass-parity pairs

Engagement is PROVEN, not assumed. The first ported build was **silently a
no-op**: their build leaves `import.meta.env.NODE_ENV` undefined, so a
dev-only `withCredentials` branch runs in production builds too, and the
adapter pins any withCredentials config to the XHR fallback. A page probe
showed `/rest/settings` as initiatorType `xhr`; after amending 0002 (set the
flag only when the target origin differs from the page origin — same-origin
XHR sends cookies regardless of it, so upstream behavior is unchanged), the
probe shows `fetch`, the adapter's exec. Lesson recorded: **certify
engagement before certifying invisibility.**

Of the 3 tests that flipped passed→failed against the baseline (5 flipped the
other way): two rerun green (canvas switch-node, demo chat-trigger — known
flake classes; their runner quarantines 8 titles for the same reason), and one
was REAL and reproducible — the corpus's first transport-timing find:

- `templates.spec.ts` "should save template id with the workflow": the flow
  saves on execute-click, and the save is valid only after the imported
  workflow's NAME lands (upstream sequences it after a `/rest/workflows/new`
  fetch; the import composer waits only for the URL redirect). Stock XHR
  interleaving happened to apply the name by click time; the adapter's fetch
  interleaving didn't — the save 400s on an empty name and the app converges
  by creating a second workflow. A one-macrotask resolution hop in the adapter
  (XHR settles from a task, fetch from a microtask) did NOT fix it and was
  reverted — the reorder is between two concurrent requests' apply-effects,
  not a single response's settle stage. Patch 0004 relocates the wait to the
  page state the test already assumes (name applied), assertions unchanged —
  the docs/corpus.md test-accommodation contract. Verified 3× green ported;
  the stock arm demonstrably reaches the awaited state (its save carried the
  name). 0004 landed after the two committed runs, so those JSONLs predate it;
  the next full pair folds it in.

No byte/trip movement is claimed at this stage — the exec is a direct fetch
(stock wire shape, by design). The wire numbers come with the session-socket
stage, which is blocked on the auth-rotation requirement above.

Sandbox caveat for rebuilds: turbo trusts stale hashes on the no-git recipe
tree after patch(1) edits — rebuild the ported frontend with
`turbo run build --filter=@n8n/rest-api-client --filter=n8n-editor-ui --force`.
