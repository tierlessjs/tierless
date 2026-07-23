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

    patches/0001-tierless-session-socket.patch   utils.ts: the adapter + the session
                                                 socket in the one request() (one file)

plus `pnpm add tierless` in `@n8n/rest-api-client` (a dependency install, not a
diff — setup.sh does it on the ported tree only). The whole port is this one file:
the direct-fetch adapter and the session-socket stage below are two halves of it.
Test patches (BOTH arms):

    patches/0002-measure-reporter.patch   playwright.config.ts: measure reporter +
                                          recording off on measured runs + webServer
                                          skip covers the frontend entry; one new
                                          reporter file

What the adapter half does: n8n's `request()` builds a per-call `AxiosRequestConfig`;
the patch adds a per-call `adapter` — tierless's axios adapter with a
direct-fetch exec bound to THAT call's own `baseURL` origin. Everything above —
their error taxonomy (ResponseError/MFA), param serializer, browser-id header,
the ~50 `api/` modules — runs untouched. Same-origin cookies ride the exec's
fetch exactly as they rode the XHR (n8n sets `withCredentials` only in dev
builds, so production requests never pin on it). Blob/FormData/binary configs
and external origins (`api.n8n.io`) fall through to axios's own XHR adapter.

## The session-socket stage (the port patch's second half — BUILT and certified)

Same-origin `/rest` now crosses a **session websocket** to a standalone gateway
(`ports/n8n/gateway.mts`, :5780 = page-port+100) as one exec crossing each:
preflights gone (same-origin socket), envelope headers trimmed to what the
code reads, one session-long deflate window. External origins (`api.n8n.io`)
keep the direct-fetch exec.

**Sealed cookie authority** solves the auth problem the direct-fetch stage
dodged. The JWT lives in an **httpOnly cookie**, and n8n logs in/out as an SPA
transition, so a socket opened on signin outlives an auth change. The gateway
(packages/tierless/src/session-auth.mts) mints a secret key at boot, seals the
upgrade-time cookie under it, and hands the BLOB to the browser runtime instead
of storing it — every crossing carries the blob, the gateway decrypts/uses/
forgets, so authority travels with the request as in the header-auth ports (the
gateway holds no credentials). Rotation is in-band and exec-path-wide (n8n rolls
the cookie near expiry on arbitrary responses): a mediated `set-cookie` rides
down as a new blob; a claim request (blob + 30 s nonce) replays the Set-Cookie
into the real jar for reload continuity (script cannot write httpOnly, so a ws
frame cannot); BroadcastChannel propagates rotation across tabs (reseal, the
claim's mirror); a session-exec 401 drops the blob and re-upgrades, the
catch-all for out-of-band invalidation. Full shape and the SharedWorker
alternative: ROADMAP.md. Framework probe: `test/probes/session-auth.mts`.

**Proven live**, not assumed: logging in through the page rides the ws, the
claim plants `n8n-auth` (httpOnly=true) in the real jar, gateway HTTP is exactly
reseal+claim, ZERO page-origin `/rest` over HTTP, and a hard reload stays
authenticated.

### The session socket's defining limitation (requirements find)

Moving I/O off the browser makes it **invisible to browser network
interception** — service workers, extensions, devtools, and (where it surfaced)
a test harness's response mocking. Playwright's `route()` hooks the browser's
own fetch, so a request that leaves as a ws frame is never seen: on the first
full ported run, 33 tests that inject feature flags by mocking `/rest/settings`
and friends silently went unmocked. The answer is a **force-browser seam**
(the port patch's `forceBrowser` seam): a page global lists URL globs that must
stay on the browser's own fetch; matching same-origin requests take the
direct-fetch exec instead of the socket. Empty in production — a real embedder
control (keep a resource SW/extension-visible), not a test device. The
force-browser test patch populates it
by wrapping `route()`, so every intercepted glob auto-registers; both arms,
inert on stock.

A second class the socket surfaces: tests that assert the **transport** —
`waitForResponse`/`waitForRequest` for a request the socket carries, or
`.postDataJSON()` on it — can never fire against browser HTTP. Patch 0006
relocates these to a race between the HTTP wait and the page's exec log (same
predicate; request bodies served from the log), so the request still crosses
the socket AND the test observes it. Both arms; only transport moves, never an
assertion.

### Certification (results/cert-0005-session-socket.jsonl)

Full suite on the session-socket build, same command as the baseline:

    736 discovered · 672 passed · 31 failed · 33 skipped · 1.5 h
    paired 694 · 2 passed->failed, BOTH rerun green (code-node:41, debug:55)

An earlier ported run surfaced the two limitation classes above (network
mocking, transport-assertion) as ~17 regressions; patches 0005 force-browser +
0006/0007 resolve them. The final pair against the baseline leaves just 2
passed->failed, and both pass on rerun — the session socket is behaviorally
invisible at the same bar as the direct-fetch stage. (672 > baseline's 666
passed: a few baseline flakes happened to land green this run; the paired,
parity-gated set is the honest comparison, not the raw pass counts.)

### Wire-truth byte A/B (2026-07-20, results/{baseline,ported}-truth.jsonl)

Both arms under the TCP-true counting relay (bytes are socket-level, deflate
included; browser data path only, node-side seeding excluded), single machine
epoch, 661 pass-parity pairs:

    total wire IO   5,605,510 KB -> 6,081,963 KB   —  8% MORE on the ported arm
    median per test                                —  2% more

**This retracts the previously published 49%.** That number was computed
against a baseline artifact assembled after a mid-run container restart by a
max-bytes dedup; per-test comparison against clean arms shows that dedup
inflated the old baseline uniformly ~2x (median new/old ratio 0.50 across 518
tests) — the old PORTED artifact matches the new one, only the baseline was
wrong. On clean same-epoch arms, n8n is the corpus's honest null-to-negative
byte data point, and the anatomy says why:

- The dominant per-test wire is a constant BOTH arms pay through the single
  origin: editor assets and the push channel (~7-8 MB/test; fresh context per
  test refetches the bundle).
- The ported arm's session ws is ~1.75 MB per page session — the app's ~18
  boot `/rest` fetches, deflate-compressed (verified: the quantum is 2x on
  two-page tests, absent on session-less tests, and invariant under the
  TIERLESS_PREBOOT=0 ablation — prebooted-in-hello or crossed, same bytes).
- ANATOMY LOCALIZED (2026-07-22, ports/n8n/measure-wire-cost.mts + the
  TIERLESS_WIRE_LOG per-message instrument): the quantum's body is ONE
  payload — `/rest/community-node-types`, 12.40 MB raw JSON, fetched once
  per page session. Per payload the session transport is at PARITY with
  stock: 1,891,695 B over the session socket vs 1,891,765 B stock gzip
  (ratio 1.00); the binary codec's plaintext is 4.66 MB (0.38x the JSON
  text — MORE compact, not less). The compressor and codec are exonerated.
- Part of the +8% is HTTP CACHING the crossing path lacked: the endpoint
  serves a weak ETag and answers If-None-Match with a 0-byte 304 (verified
  live), so a multi-page STOCK test pays the 1.9 MB once and revalidates
  after, while every ported page session re-crossed it in full. FIXED —
  conditional crossings (tierless/adapt-cache, default-on in autoSession):
  cache api.get envelopes browser-side keyed by path+ETag, attach
  If-None-Match, replay on 304. Re-driven truth arm
  (results/truth-ported-conditional.jsonl, 659 pass-parity pairs): 49 tests
  drop >=1.5 MB of session ws — the entire multi-session pool (44 tests) —
  for −41 MB, taking the suite total from +8.5% to **+6.8%**. Getting there
  surfaced a general bug: undici's fetch stamps cache-control:no-cache onto
  conditional requests and Express fresh() then refuses the 304 — the
  gateway now forwards validators with max-age=0 (a browser reload's shape).
- The REMAINING ~+6.8% is not repeat crossings (an earlier draft of this
  section overclaimed that; the measured repeat pool was only the 44
  multi-session tests). The open suspect is preboot over-delivery: the
  hello pre-fetches all 18 boot GETs on every upgrade whether or not that
  page consumes them, where stock pays only for what the app fetches. The
  TIERLESS_PREBOOT=0 ablation exists to price this. Crossings themselves
  are real and correct (pass parity held across all three arms:
  667/664/663 passed); unlike Strapi (raw MB-scale JSON re-sent per
  request, 92% win) or NocoDB, n8n's repeated payloads sit behind its
  asset bundle, push channel, and one revalidated mega-endpoint.

Reproduce:

    bash ports/n8n/setup.sh --baseline                        # build the stock arm tree
    TIERLESS_WIRE_TRUTH=1 node ports/n8n/suite.mts --baseline
    TIERLESS_WIRE_TRUTH=1 node ports/n8n/suite.mts
    node ports/report.mts ports/work/n8n-baseline/measure-truth.jsonl ports/work/n8n/measure-truth.jsonl

### Wall time and network wait (2026-07-20; floors same-epoch, RTT arms caveated)

The one defensible timing comparison on this rig is a back-to-back same-epoch
floor pair (single runs of this 1.5 h suite swing by minutes across container
epochs — the same instrument lesson as vikunja and strapi, and this suite is
too long for a medians-of-3 matrix between restarts):

    RTT-0 floor wall   88.5 min stock -> 95.9 min ported   (8% SLOWER)
    per-test median    +778 ms ported (quartiles +2 / +778 / +1333)

The slowdown is entirely SESSION BOOT, measured by correlation: grouping the
same tests by their session count (from the truth arm's ws quantum), the floor
delta is −5 ms at zero sessions, +1.1 s at one, +2.8 s at two, +3.4 s at
three — ~1.1 s per fresh-page session, parity without one. This retracts the
old cut's floor-parity/wall-win numbers along with the byte headline (same
contaminated baseline artifact), and it is a REGRESSION against the old cut's
own boot-latency study (boot crossings 19 -> 1, floors at parity) — the
packaged autoSession path re-pays a boot cost the hand-rolled port had
eliminated. DIAGNOSED (2026-07-20, phase-instrumented single-test runs, both
arms): no tierless queueing or correctness defect — the readiness gate costs
0-7 ms, preboot joins return in 0-5 ms, and crossings on a QUIET page run at
parity with stock direct HTTP (e.g. the workflow-run POST: 69-97 ms ported vs
87 ms stock). The ~1.1 s is crossings that land inside the boot render-storm
window paying 2-5x CPU contention on this shared box (browser main-thread
decode + the gateway hop + a backend whose editor endpoints already cost
100-200 ms each) — amplified by an irony: the instant preboot join starts the
mount storm EARLIER, so the editor fetches land inside it, where stock's
slower boot staggered them apart. Burst coalescing was A/B-tested here and is
neutral (the expensive crossings are sequential dependents, not coalescible
bursts — n8n confirms the vikunja default-off verdict). Remaining candidates
are scheduling-shaped (off-main-thread decode, crossing priority) and live on
the roadmap; the harness pays this per test, a real session pays it once per
page. The RTT-80 arms exist (results/rtt80-*.jsonl) but span a restart; their
decomposition is not quoted.

Structural notes that survive the retraction: the harness pays every per-session
cost once PER TEST (fresh context), where a real long-lived session pays it once —
harness numbers are the worst case for any per-session tax. Over **ws-over-H2**
(`docs/transports.md`) the socket handshake itself halves — a ws colocated on the
app's H2 origin coalesces onto the page's warm connection and pays 1 RTT, not 2
(measured independently: transport-bench 167 -> 84 ms).

The boot-latency mechanisms, built and measured on the original cut
(results/boot-setup.txt, per-context boot timing @ RTT80) and still shipped:

- **Reseal folded into the ws upgrade** — the gateway seals THIS socket's cookie at the
  upgrade and hands the blob back in an unsolicited `hello`, so the startup blob rides the
  handshake instead of a separate HTTP reseal round trip. First crossing −200 ms, FCP −152 ms.
- **Preboot** — the gateway pre-fetches the boot GETs (the frozen manifest) at the upgrade
  with the socket's own cookie and pushes the envelopes in the `hello`; the app's first
  crossings JOIN the buffer instead of crossing. Boot crossings **19 → 1**, boot data path
  −1.4 s. The join is consume-once and refreshes per page load, so it stays correct through
  mutations (full-suite gate: 670 floor / 667 rtt80 passed, pass-parity with baseline).
- NOT lost parallelism: the runtime **multiplexes** concurrent crossings (`peer.request` in
  transport.mts assigns a correlation id and sends immediately, replies matched by id).
- Eager bootstrap (moving setup to module import) was tested and **disproven** first
  (results/eager-boot-ab.txt): re-TIMING the setup was a wash because there is no overlap
  window; REDUCING it (these two fixes) is what moved the number.

Both fixes are ON by default (boot.mts); each is env-toggleable
(`TIERLESS_HELLO_AUTH`, `TIERLESS_PREBOOT`) so a run can isolate its contribution.
On the re-cut, the preboot join is verified serving (a logged run shows zero
manifest paths crossing; bytes are invariant under the ablation) — yet the
~1.1 s/session floor cost stands. Whatever re-introduced it is the open item
above, not these mechanisms' design.

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

## The adapter certified behaviorally invisible (2026-07-13, results/cert-0002-adapter.jsonl)

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

## Re-cut on the packaged surface (2026-07-16 — patches apply; runtime verification pending)

986 → 91 patch lines. The port is ONE patch again, now on the packaged surface:

    patches/0001-tierless-auto-session.patch (56)  utils.ts: autoSession + axiosAdapter in the one
                                                   request() options builder (same-origin crosses,
                                                   api.n8n.io stays direct — the execFor default),
                                                   plus the vestigial-withCredentials quirk hunk.
                                                   Cookie authority, the force-browser seam, and
                                                   the ws-URL convention all come from autoSession.
    patches/0003-local-lane-queue-gating.patch (16)  SEMANTIC: upstream's own container-only tag,
                                                   missing on one suite (unchanged)
    patches/0004-template-name-race.patch (19)     SEMANTIC: the one interleaving accommodation
                                                   from the old 620-line waits patch — everything
                                                   else was mechanical and now rides the wrapper

The 620-line waits patch, the reporter copy, and the 106-line route-recorder patch are
gone: the suite runs through the generated `--config` wrapper (ports/pw-wrapper.mts),
which patches their playwright-core Page class — waits AND route() recording — and
attaches the packaged reporter. gateway.mts is retired for `tierless gateway
--cookie-authority` on :5780 (page+100); the boot levers (preboot manifest,
hello-auth ablation, GET logging) are CLI flags/envs now.

VERIFIED in this sandbox (2026-07-16): both variants built; floor arms over the
wait-heavy subset (executions filter, editor execution incl. request-payload captures,
templates) — **25 tests per arm, identical ids, EXACT status parity: 19 passed /
5 skipped / 1 failed on both**, the failure arm-symmetric (a templates-page visibility
flake, identical on stock). Wire-truth smoke: 2/2 passed with 29.6 KB of real
session-ws bytes. Two findings from the verification: this suite's playwright (1.60)
SEALS the client classes, so the waits ride the suite's own fixture seam (test patch
0002, ~10 lines — the wrapper degrades gracefully and says so); and upstream's
frontend webServer entry misses the SKIP guard its backend entry has (test patch 0005,
15 lines, semantic). Total: 986 → 134 patch lines, one 56-line port patch.

RE-MEASURED on this cut (2026-07-20): the full six-arm drive plus a same-epoch
floor pair. Behavior holds (661 pass-parity pairs, crossings verified at the
gateway); the wire and wall numbers above are this cut's — including the byte
retraction and the open ~1.1 s/session boot regression, which is the next
tierless work item, not a caveat on the data.

## The wire budget (2026-07-23, results/wire-budget.txt)

Per-path attribution for a full arm-pair (TIERLESS_WIRE_BUDGET=1: HTTP-message
bytes per request behind the counting relay, the gateway's per-message session
log, ports/wire-budget.mts) — built because the +8% was previously attributed
by aggregate ratios, wrongly. Arm totals this pair (conditional crossings on):
5,958 MB stock vs 6,214 MB ported TCP-true (+4.3%; baseline had an elevated 46
failures this run — arm-level totals, not pass-parity-gated). Attribution
reconciles within 2.2% of TCP on the stock arm. What the table says:

- `/rest/community-node-types` is at wire parity now: 832 MB stock HTTP over
  **484 fetches** vs ~840 MB deflated session. (The earlier "197 stock
  fetches" arithmetic was wrong; the count is 484.)
- **The dominant remaining term never touches the session**:
  `/types/nodes.json`, plain browser HTTP in BOTH arms — 805 full 200s
  (1,174 MB) stock vs **1,007 full 200s (1,467 MB) ported: +294 MB from 202
  extra downloads**, zero 304s either arm. Why the ported build's pages fetch
  it more is an open, now-countable question (their loader uses plain fetch;
  the port doesn't touch that path).
- Hello/preboot cargo: 242 MB plaintext across sessions (nearly all preboot
  envelopes; ~60-90 MB deflated on the wire) against partially-displaced boot
  GETs — second-order, not the headline the preboot-over-delivery hypothesis
  expected.
- The rebuilt editor's asset chunks pair off against stock's (+2-4 MB per
  tierless-bearing chunk); roughly a wash.
