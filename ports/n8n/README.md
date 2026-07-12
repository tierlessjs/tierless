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
lives in an **httpOnly cookie**. The upgrade request to a same-host gateway
carries that cookie (cookies ignore ports), so a session can bind authority at
connect time — but n8n logs in/out as an SPA transition, so a socket opened on
the signin page outlives an auth CHANGE. The runtime's shared connection has no
authority-rotation hook (`browser.mts` holds one lazy connection per page).
Requirement recorded for the framework: **session re-key on auth rotation** —
drop/re-upgrade the session socket when a pinned auth request (login, logout,
MFA) succeeds. Until that exists, a cookie-authed SPA can only be ported at the
direct-fetch exec (patch 0002), which is exactly what this recipe ships.

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
- `pnpm agent:setup install|build` is their own memory-capped fresh-checkout
  path (turbo, concurrency 4) — setup.sh uses it rather than reinventing.
- `@playwright/test` pinned at 1.60.0; its chromium fetches from the Playwright
  CDN into `$HOME/pw-browsers` (the sandbox's preinstalled set is a different
  revision).

## Status

- Recipe pinned and fetched (git transport; tree hash covers symlinks). Test
  patch 0001 and port patch 0002 authored; setup/boot/suite drivers written.
- Build in progress in this sandbox; baseline and certification runs next.
  Numbers land here when measured — nothing below this line is measured yet.
