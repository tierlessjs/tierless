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

## The suite at the socket (2026-07-10, results/truth-*.jsonl)

Both arms by one command each (`TIERLESS_WIRE_TRUTH=1 node ports/nocodb/suite.mts
[--baseline]`, orchestrated end-to-end by drive-truth.sh), TCP-true accounting:
session ws bytes counted inside the gateway (deflate included), browser API bytes
through a counting relay (:28080), node-side seeding on the direct :8080 and never
counted. 282 paired tests; 80 pass-parity pairs (194 EE/pg-gated skips on this
lane, plus the exclusions below); 78 of 80 touch the session socket.

    total bytes    26.5 MB -> 1.57 MB   (94% less IO)
    per test       median 94% fewer bytes (p10 92%, p90 95; worst test still 85%)
    best case      798 KB -> 61 KB (columnMenuOperations: duplicate-column flows)
    wall clock     54.8 -> 55.0 min (parity — localhost; shaped RTT is the timing
                   instrument, not yet run for this port)

Why the number dwarfs Vikunja's 13%/35%: **their Express backend serves raw,
uncompressed JSON** (no compression middleware anywhere in the tree — verified),
so stock pays full-size bodies plus per-request headers, while the ported arm
pays one session-long deflate window. CORRECTION (2026-07-10): Vikunja's stock
API is ALSO raw — its echo gzip middleware skips /api/ paths (verified
empirically: identity encoding with Accept-Encoding: gzip) — so the 94%-vs-35%
gap is payload-size distribution, not encoding. Trips are
not instrumented on this port (the reporter is wire-counter-based, no CDP
fixture; report.mts derives socket coverage from the TCP ws counters).

### Apples-to-apples: against a COMPRESSED stock (results/truth-baseline-gzip.jsonl)

Patch 0005 adds an env-gated gzip layer to their test server (`NC_TIERLESS_GZIP=1`;
zlib, ≥1 KB compressible bodies — expressjs/compression defaults). The default
measured stack stays what their own CI runs (raw); this arm answers "what if they
deployed compression":

    stock, gzip              26.5 MB -> 16.3 MB api-in (gzip cuts stock's API bytes 63%)
    ported(raw) vs it        16.3 MB -> 1.57 MB   (90% less IO; median per-test 91%)
    ported+gzip vs it        17.0 MB -> 1.57 MB   (91% less IO; median 91%) — the
                             SYMMETRIC pair (results/truth-ported-gzip.jsonl); the
                             ported arm's residual direct HTTP is negligible here

Compression captures barely a third of the gap: the port's win here is
structural — bodies that never repeat across a deflate window, headers that
never re-send — not just encoding. (Contrast Vikunja, where gzip captures half
the suite-wide advantage: payload-size distribution decides how much of the win
is compressible — ports/vikunja/COMPILING.md.)

Pass sets: 3 exclusions fail on BOTH arms (columnAttachments, metaLTAR
delete-over-UI, viewGridShare — the stock CORS-refresh family), and
sourceRestrictions flip-flops between arms (one member failed stock/passed
ported, the other the reverse — the same unstable family). Ported-only:
toolbarOperations row-height passes in isolation (load flake);
accountUserManagement's invite flow failed deterministically at the
transport-agnostic-wait seam — diagnosed and FIXED: the wait's index cursor
died at goto() navigations (page world resets restart the log); entries now
carry wall-clock timestamps and the wait scans by time. The flow passes. All are
pass-parity-excluded; none contribute bytes to the distribution.

The accommodation that made the ported arm runnable: their page objects
centralize `page.waitForResponse` in pages/Base.ts — the exact HTTP requests
the session socket eliminates. Test patch 0004 races that wait against the
page's tierless exec log (same url predicate, method, status, JSON matcher
applied to the winner's body); on stock the log never exists and the race
reduces to the original wait exactly. One helper covered the suite where
Vikunja needed per-site rewrites.

## Shaped timing (2026-07-10, results/rtt20-*.jsonl)

`TIERLESS_RTT_MS=20 node ports/nocodb/suite.mts [--baseline]` — 20 ms RTT on all
three browser-facing hops (frontend origin, API origin, session ws; relays set
TCP_NODELAY), gateway→backend on undelayed localhost, as deployed. 78 pass-parity
pairs (8 failures shared by both arms under RTT pressure; 1 ported-only RTT flake
— columnUserSelect duplicate-field — passed on the unshaped ported arm):

    wall clock     54.3 -> 54.2 min total (parity)
    per test       median 39.1 -> 38.7 s (+0.9% faster; p10 -1%, p90 +4%)

The settled metric is NETWORK WAIT — dur@RTT − dur@unshaped-floor per test
(clean floors in results/floor-*.jsonl; `node ports/report-time.mts`). At 20 ms
RTT that decomposition is variance-dominated on this suite: the unimprovable
floor is ~3,340 s per arm (render + Playwright fixtures), the modeled pool is
~5% of that, and 74 of 78 pairs measure a NEGATIVE net component (run-to-run
noise exceeds the signal). The honest 20 ms verdict is wall parity.

## Network wait at RTT 80 (2026-07-10, results/rtt80-*.jsonl + floors)

At 80 ms (the Vikunja instrument — a 4x larger pool) the decomposition is
measurable: 58 tests pass in all four runs (floors + both rtt80 arms; RTT
pressure and the CE-lane skips drop the rest), 8 of 58 still noise-negative
(kept as-is; medians are robust):

    unimprovable floor    2,554 s per arm (render + fixtures — transport can't move it)
    network-wait pool     103.7 s -> 64.7 s   (38% of the POOL removed)
    median per test       2,190 -> 1,685 ms network wait
    pool share of wall    4% (baseline) — the ceiling ANY transport work has here

So the honest two-line timing story: the port removes 38% of what the network
actually costs this suite, and the network costs this suite 4% of its wall
time. Per-interaction crossings pay per-interaction RTTs — the byte win (94%)
does not become large wall-clock wins without restructuring flows (§6 chains /
migrations), and it costs nothing either. The timing ceiling lives in the
request-per-interaction structure — the compile-surface story, not the
transport story — same verdict as Vikunja, now decomposed on a second app.

## Re-cut on the packaged surface (2026-07-16, results/recut-floor-*.jsonl)

The recipe now rides the packaged port surface instead of hand patches — 321 → 173
patch lines, and what remains is mostly comments:

    patches/0001-measure-reporter.patch (24)      config only: tierless/playwright-reporter + relay baseURL
    patches/0002-tierless-auto-session.patch (62) THE PORT: autoSession + axiosAdapter at the same seam
                                                  (replaces the 0002 adapter + 0003 socket pair, 93 lines)
    patches/0004-transport-agnostic-waits.patch (27)  one hook: installTransportWaits(page.context()) in
                                                  setup() — pages/Base.ts and every spec stay PRISTINE
    patches/0005-optional-gzip.patch (60)         unchanged (the apples-to-apples lever)

gateway.mts is retired — boot.mts spawns `tierless gateway` (same origins, ports, and
wire-truth env). setup.sh links tierless into tests/playwright on both arms (a harness
dependency, same posture as the reporter copy it replaces). Cookie authority is
auto-declared OFF by the gateway's hello (nocodb's authority is the xc-auth header);
autoSession's `cross: () => true` covers the rig's UI(:3000)/API(:8080) origin split.

Verified in this sandbox (floor arms, one command each): an 8-spec subset spanning the
wait-helper-heavy page objects (columnUserSelect, columnMenuOperations,
columnMultiSelect, verticalFillHandle, multiFieldEditor, toolbarOperations,
tableOperations, pagination) — **42 tests per arm, identical ids, EXACT status parity:
32 passed / 10 skipped on both, zero diffs**; the session ws to :8180 confirmed live
mid-run (/proc/net/tcp). The suite's own waits (Base.ts `waitForResponse`, unpatched)
resolved from session crossings via the installTransportWaits facade.

The measured numbers above (truth/rtt sections) were driven on the PREVIOUS cut —
transport-equivalent (same socket, same gateway posture; the ws-upgrade hello frame is
new, a few bytes per session) but re-drive the arms before quoting them for this cut.
