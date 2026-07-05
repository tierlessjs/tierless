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
interaction actually crosses the session socket.

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

Full suite (31 files, 199 tests) against the ported build: **194 pass**, 5 fail — every
failure explained, none a behavior bug:

- 4 are `page.waitForResponse(...tasks...)` waits in task.spec.ts for the exact HTTP
  request the port eliminates (served from the workflow bundle, so it never reaches the
  network). The failure screenshots show the task list fully and correctly rendered —
  the tests assert the transport, not the UI. This is a permanent exclusion category
  for ports: a test that requires the request to exist can't pass once the request is
  optimized away.
- 1 (OpenID login) needs the Dex identity-provider container their CI boots; we don't
  run it. Environmental, unrelated to the port.

The 59 project-directory specs — the ones that exercise the shimmed routes hardest —
pass 59/59 in the same wall time as stock (2.0 vs 2.1 min). The suite caught three real
adapter bugs on the way (each fixed in tierless, not worked around): stale caches after
mutations (writes now invalidate), response-header semantics (x-max-permission gates UI
capability, x-pagination-* drives paging — HTTP now migrates as {status, headers, body}
envelopes), and a test-infrastructure bug where a zombie preview process served pre-fix
code to two diagnostic runs (boot now kills process groups).

## Caveats (read before quoting)

- Latency is MODELED from measured trips/bytes (declared RTT/bandwidth — CDP throttling
  can't shape websockets); bytes and trips are real wire measurements.
- The memo TTL is 10 s: a user idling longer between load and click pays one real
  avatar refetch (~1 trip). The workflow bundle is used within the navigation window
  only; misses always fall through to the real network unchanged.
- Their service-worker registration fails under `vite preview` in both variants
  (upstream workbox path issue) — no effect on the comparison.
- One journey, one app: this is the recipe's first data point, not the corpus median.
