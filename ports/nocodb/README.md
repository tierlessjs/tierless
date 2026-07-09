# NocoDB port (v2026.06.1, sha aa3fa4a8)

Second corpus app (docs/corpus.md rung 3): the porting recipe hardened on a
structurally different workload than Vikunja. NocoDB is a data-grid app — the
request shapes Vikunja mostly lacked: opening a base is a sequential dependency
chain (table meta → columns → views → rows), grid scrolling is paged fetches,
cell edits are update + refresh. This is the test of whether §6 chain migration
moves a suite-level number, and a data point for the burst-coalescing
review-or-remove item (ROADMAP.md).

## The target

- Frontend: Vue 3 via **Nuxt** (Vite underneath; SPA at runtime, served by the
  Nuxt node server on :3000, `NUXT_PUBLIC_NC_BACKEND_URL` → backend :8080).
- Service layer: `nocodb-sdk` — swagger-generated `Api` class with **axios** at
  the bottom (`--axios --unwrap-response-data`), wrapped by nc-gui's `useApi`
  with app interceptors. Same I/O-bottom seam as Vikunja's 0005 adapter.
- Backend: Node (Express + Knex), **SQLite lane** for tests
  (`DATABASE_URL=sqlite:./test_noco.db`), plus an `nc-sql-executor` sidecar.
- Their own workload: **tests/playwright — 99 spec files, ~351 tests**. CI runs
  the CE suite as 3 shards; the sqlite lane pins `workers=1` (their
  playwright.config), so a full local arm is LONG — iteration happens on spec
  subsets, full runs are reserved for measured arms.
- License: **Sustainable Use License** (fair-code; changed from AGPL upstream).
  Fine for this benchmarking-and-patch-recipe use — we never vendor their code —
  but quote results with the license named.

## Reproduce (stock boot, the CE+sqlite CI lane without docker/S3)

    node ports/run.mts nocodb          # fetch at the pinned sha, verify tree hash
    cd ports/work/nocodb/src
    corepack prepare pnpm@10.12.1 --activate   # their CI pins pnpm 10; the bare `pnpm`
                                               # inside their scripts must NOT resolve to
                                               # 11 (it ignores pnpm.overrides — WARN
                                               # confirms), and there is no packageManager
                                               # field to pin it
    HUSKY=0 corepack pnpm run bootstrap:ce     # HUSKY=0: the recipe tree has no .git,
                                               # their root prepare script would fail
    # bootstrap:ce is stale upstream at this sha: noco-integrations imports EE sdk
    # exports (uiTypeToIcon, genRecordVariables — src/ee/ IS in the public tree, and
    # their CI's playwright lane defaults ee=true and runs `bootstrap`). Finish with:
    HUSKY=0 corepack pnpm --filter=nocodb-sdk run build:ee
    HUSKY=0 corepack pnpm run integrations:build && HUSKY=0 corepack pnpm run registerIntegrations
    # nc-gui's root tsconfig extends ee/.nuxt/tsconfig.json; postinstall prepares only
    # the CE app — prepare the ee app once, then build (their CI never builds the UI
    # in this workflow; it downloads a prebuilt artifact from a private S3 bucket):
    cd packages/nc-gui && EE=true corepack pnpm exec nuxt prepare ./ee
    NODE_OPTIONS=--max_old_space_size=8192 corepack pnpm run build
    # sidecar:   packages/nc-sql-executor    pnpm run dev &
    # backend:   packages/nocodb             pnpm run watch:run:playwright &   (sqlite, :8080)
    # frontend:  packages/nc-gui             pnpm run build && ci:start        (:3000)
    # suite:     tests/playwright            E2E_DB_TYPE=sqlite pnpm exec playwright test

Transport note: this sandbox's proxy blocks codeload zips for out-of-scope
repos; the recipe's `git` transport (shallow clone at the release tag, checkout
verified against the pinned sha) is the one that works here. The tree hash pins
content either way.

Runtime facts, verified in this sandbox (2026-07-09):

- Their `.npmrc` pins `use-node-version=24.14.0` — pnpm fetches and runs its own
  node; the sandbox's node version is irrelevant to their processes.
- `@playwright/test` is pinned at 1.55.1 (wants chromium-1193; the sandbox's
  preinstalled set has 1194). `PLAYWRIGHT_BROWSERS_PATH=$HOME/pw-browsers pnpm exec
  playwright install chromium` downloads 1193 from the Playwright CDN (reachable).
- `sharp@0.32.6`'s libvips prebuilt (a GitHub release asset) is 403-blocked by this
  sandbox's proxy — its install FAILED and the backend boots anyway; expect
  attachment/thumbnail specs to be the place this surfaces, if anywhere.
- Boot shape (three processes): nc-sql-executor `pnpm run dev` (:9000), backend
  `pnpm run watch:run:playwright` in packages/nocodb (SQLite `test_noco.db`, :8080,
  EE=true is upstream's own script), frontend `pnpm run ci:start` in nc-gui (:3000,
  `NUXT_PUBLIC_NC_BACKEND_URL=http://localhost:8080`).

## Status

- Recipe pinned and fetched (git transport, tree hash verified). `setup.sh` is
  the one-command rebuild; boot.mts/suite.mts are the one-command arms; the
  measure collector is a REPORTER (patch 0001 — their specs import `test`
  straight from @playwright/test, no shared fixture module to hook; a 2-line
  config patch + workers=1 keeps per-test attribution sound).

## Stock baseline (2026-07-09, results/baseline.jsonl)

Full suite, their sqlite-lane concurrency (`--workers=1` — their config pins
that only under CI=true; unpinned local runs race 4 browsers against the one
sqlite backend and add flakes):

    282 discovered · 82 passed · 5 failed · 195 skipped · 1.1 h wall

Corrections to the selection-time sizing: 191+ of the discovered tests are
EE- or pg-gated and SKIP on this lane — the honest CE+sqlite workload is
~87 running tests, not the ~350 spec-level count. Still the request-shape
class we picked it for (data-grid chains and bursts).

The 5 stock failures are one mechanism, diagnosed at the wire: on full-page
reload/shared-view flows the app POSTs `/auth/token/refresh` WITH credentials,
the backend answers `Access-Control-Allow-Origin: *` and no
Allow-Credentials — browsers BLOCK credentialed wildcard responses (curl
can't see this; Playwright records status −1 "Network Error") — the app then
signs out, rotating token_version, and every subsequent call 401s ("Token
Expired" with a fresh 10h token). Stock-rooted and arm-symmetric: these
exclusions will fail identically on the ported arm (auth flows stay on stock
XHR), falling out of report.mts's pass-parity gate — same treatment as
Vikunja's Dex/drag exclusions. Affected: columnAttachments, metaLTAR
delete-over-UI, sourceRestrictions ×2, viewGridShare-GroupBy.

Next: the port — patch 0002 puts the tierless adapter at nocodb-sdk's axios
bottom (the Vikunja 0005 pattern), plugin entry into nc-gui's nuxt `vite:`
block, gateway into the :3000 server, then the ported arm against this
baseline.

## Patch 0002 certified behaviorally invisible (2026-07-09, results/cert-0002-adapter.jsonl)

Full suite on the ported tree (adapter at the sdk's axios bottom, direct-fetch
exec — every request refashioned as a tierless resource request and back):

    84 passed · 3 failed · 192 skipped · 1.1 h — ZERO new failures vs baseline

The 3 failures are a strict subset of the baseline's 5 CORS exclusions; the two
sourceRestrictions specs flipping to pass is timing wobble within that stock
refresh-race family (one also passed in a stock isolation rerun), not an
adapter effect. Coverage audit: every main-thread Api instance flows through
addAxiosInterceptors (createApiInstance + the $api plugin); the ee/ app variant
(not in the CE build) and workers/importWorker.ts (its own Api, stock XHR on
both arms) are the two knowing, symmetric bypasses.

Next: the session socket — compile surface (nocodb-sdk HttpClient.request is
the single generated choke point), plugin entry in nc-gui's nuxt vite block,
gateway serving http.* against :8080 over localhost.
