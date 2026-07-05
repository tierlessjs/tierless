# Vikunja port (v1.0.0, sha 3ba5192b)

Their newest release (tagged 2026-01-27; GitHub's "latest release" page shows v2.3.0
because it sorts by semver and Vikunja renumbered). Verified from source: Vite 7.3.1 +
Vue 3.5.27 frontend with a 31-spec Playwright e2e suite; Go backend, SQLite default —
**never modified**: the port's server side is `restResources` (tierless/adapt) proxying
`api.get(path)` onto their REST API over localhost, forwarding the user's bearer token,
hosted by the Vite plugin on `vite preview`'s own server from the build's dist-tierless
manifest.

## The diff to their app

    patches/0001-vite-config.patch        2 inserted lines (import + plugin entry)
    patches/0002-openProject-workflow.patch   1 new file, ~20 lines of plain JS

plus `pnpm add tierless` (a dependency install, not a diff). The workflow module is
sequential plain JavaScript: user, project, resolve the default view, tasks — returned
as { requestPath: body }. The plugin's injected shim arms on navigation, runs the
workflow as ONE migrating continuation, and answers the app's own XHRs from the result;
identical GETs within the interaction are memoized (the SWR-style dedupe the app never
had). Components, stores, and services run untouched.

## Reproduce

    node ports/run.mts vikunja                      # fetch + verify + apply the patches
    cd ports/work/vikunja/src/frontend
    corepack pnpm install --frozen-lockfile && corepack pnpm add tierless@link:<repo>/packages/tierless
    corepack pnpm run build
    cd .. && go build -o vikunja .
    node ports/vikunja/journeys/project-view.mts    # boots, seeds, measures

## Suite benchmark — their whole e2e suite, before vs after

Two arms, identical test patches (measure fixture + transport-agnostic waits), one
command each; the ported arm needs the build above, the baseline arm a stock build
(`node ports/run.mts vikunja --baseline`, then install + build WITHOUT `pnpm add
tierless`, backend binary is byte-identical so copy it):

    node ports/vikunja/suite.mts --baseline         # -> ports/work/vikunja-baseline/measure.jsonl
    node ports/vikunja/suite.mts                    # -> ports/work/vikunja/measure.jsonl
    node ports/report.mts ports/work/vikunja-baseline/measure.jsonl ports/work/vikunja/measure.jsonl

The report pairs tests by id, drops pairs that don't pass in BOTH arms (listed, never
silent), and prints suite-wide totals plus the covered subset — the tests whose
interaction actually crosses the session socket. Both arms' JSONL is committed under
`results/`, so the report reruns without the two 9-minute suite runs.

Measured 2026-07-05 (both arms 196/199, identical exclusions — the two drag tests
upstream's own CI retries for, and the Dex login we don't run):

    suite-wide (196 paired tests)   51% fewer round trips (6376 -> 3144)
                                    27% median per-test IO reduction (6% of total
                                    bytes — the total is dominated by one 899 KB
                                    attachment-upload spec)
    covered subset (82 tests)       42% fewer trips · 26% median IO reduction

Two mechanisms, same 2-line diff. (1) Route workflows: /projects/:id navigations run
as one migrating continuation. (2) Interaction-scoped GET dedupe with write
invalidation — it applies on every route, which is why 114 tests that never touch the
workflow still improve: their worst antipattern collapses (the comment-pagination spec
refetches the author avatar per comment, 126 API requests -> 19). Losers included:
8 covered tests pay up to +4 KB (kanban wants buckets first; the workflow ships the
list-view task page it won't use), all 8 still make fewer trips.

## Measured — the same journey, same seed, same harness

Journey: warm SPA, logged in, click a project with 20 tasks (the interaction behind
their tests/e2e/project/project-view-list.spec.ts). Data-path traffic only (API origin
+ session socket); the SPA bundle is identical either way.

    BEFORE (stock):    10 requests · 28.3 KB · modeled 823 ms @ 80 ms RTT, 10 Mbps
    AFTER  (tierless):  1 trip     · 16.6 KB · modeled  94 ms

    => 10x fewer round trips · 41% less IO · 8.7x less network wait

The stock waterfall was a real-world mosaic: /user and the avatar each fetched twice,
two CORS preflights (cross-origin API), then the dependent chain projects/1 ->
views/1/tasks. After: one websocket crossing (268 B out, 16.3 KB back) carries the
whole workflow; preflights disappear (same-origin socket); the avatar refetches are
served by the interaction memo (fetched once at page load, before the measured window —
in the stock build every rerender refetched it for real).

## Correctness — their own suite as the judge

Full suite (31 files, 199 tests), stock and ported arms run identically: **196 pass on
both, and the 3 failures are the same 3 tests in both arms** — the two drag-to-project
specs that upstream's own CI retries for (`retries: process.env.CI ? 2 : 0`; both pass
in isolation on both builds), and the OpenID login that needs the Dex container their
CI boots. Nothing fails on the ported build that passes on stock.

Four task.spec.ts tests originally failed on the ported build by waiting on
`page.waitForResponse(...tasks...)` — the exact HTTP request the port eliminates. Their
screenshots showed correct UI; the accommodation patch (0004, applied to both arms)
replaces the network wait with the equivalent UI wait, and all four now pass on both.

The suite caught three real adapter bugs on the way (each fixed in tierless, not worked
around): stale caches after mutations (writes now invalidate), response-header
semantics (x-max-permission gates UI capability, x-pagination-* drives paging — HTTP
now migrates as {status, headers, body} envelopes), and a test-infrastructure bug where
a zombie preview process served pre-fix code to two diagnostic runs (boot now kills
process groups).

## Caveats (read before quoting)

- Latency is MODELED from measured trips/bytes (declared RTT/bandwidth — CDP throttling
  can't shape websockets); bytes and trips are real wire measurements.
- The memo TTL is 10 s: a user idling longer between load and click pays one real
  avatar refetch (~1 trip). The workflow bundle is used within the navigation window
  only; misses always fall through to the real network unchanged.
- Their service-worker registration fails under `vite preview` in both variants
  (upstream workbox path issue) — no effect on the comparison.
- One journey, one app: this is the recipe's first data point, not the corpus median.
