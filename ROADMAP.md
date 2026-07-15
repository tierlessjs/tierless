# Roadmap

What's genuinely open. Everything that has landed — with its measurements and
proofs — moved to [`CHANGELOG.md`](./CHANGELOG.md); the mechanism itself is
proven (the executable proofs behind `npm test`).

## Runtime hardening

- **Reconnect/resume.** A dropped websocket loses the session today. The
  continuation is durable data, so parking it (server-side or client-side) and
  resuming on reconnect is a natural extension — not built yet.
- **Horizontal scaling.** The session protocol is stateless per message, but §5
  heap contents and delta baselines are per-process; multi-instance deployments
  need sticky sessions today. Documented in `docs/production.md`.
- **Event-dispatch model.** The live page parks the whole continuation on one
  human click; a page with several independent event sources needs the next
  event routed to the right resumable point. Application-level today.

## From the literature (Stip.js, Fission — see design.md §9)

- **Per-tier dead-code shake.** Stip.js's slicer ships each tier only the code it can
  run; Tierless ships every machine to both tiers. The suspendability analysis already
  knows which functions can only execute server-side in practice — a bundle shake using
  it would cut the browser payload with no semantic change.
- **Label-driven excision (Fission-grade confidentiality from existing parts).** Mark an
  api result `confidential` and compose two things Tierless already has: the value is
  FORCED to cross as a §5 handle (never inlined into a continuation headed client-ward),
  and every deref of it is a monitored, per-principal call. Data-flow confidentiality for
  tier-crossing values without whole-program interposition.
- **Whole-program placement optimization.** Trajectory pricing (`tierless/trace`,
  `docs/trajectory.md`) now prices a site's whole recorded same-tier suffix instead of
  one hop — measured 57% fewer bytes on a workflow where every greedy hop was locally
  correct. Still open, in order of leverage: land the §6 decide loop in the shipped host
  (fetch as a first-class protocol message — today the host always migrates and the
  driver lives in the tests); a suffix horizon for long-running sessions (price up to
  the first foreign-tier return, say — settle against real traces); and per-site suffix
  stability in real applications, the load-bearing empirical unknown the recorder now
  instruments. Beyond that, Stip.js-style global search over the suspension graph
  (pre-placing or replicating pure helpers) remains the bigger swing.
  UPDATE: the §6 decide loop is now LANDED in the shipped host (host.mts `drive`,
  `placement: { profile, mode }`) — fetch is a first-class protocol message
  (`type:"exec"`) the driver picks over migrate (`type:"resume"`) per park, priced on
  real shipped bytes; cold/unpriced keeps the migrate floor. Proven in the real host
  over the wire (test/e2e/trio-live.mts §3a: greedy 3 exec, trajectory 1 resume, 57%
  fewer bytes, byte-identical to the old hand-rolled driver). Remaining: symmetric
  step-side fetch (the answering side still always suspends); a suffix horizon for
  long-running sessions; per-site suffix stability in real apps.
- **Profile fidelity: record FAILED touches.** A resource call that rejects is
  invisible to the recorder (rec.res runs after a successful exec), so a run
  whose compiled code catches the failure reads as a complete trajectory with a
  missing touch — suffix stability can be learned from a path that didn't run.
  Needs an error-touch record kind (not a fetchable zero-byte result) and
  decide()/stability treatment for it.
- **Session auth transport.** The vite shim carries the login token as a ws URL
  query parameter, which reverse proxies and tracing systems log as the request
  target. Move it to a first-message/subprotocol handshake (a protocol change
  across shim, browser, and server) before any deployment posture beyond the
  dev/demo flow.
- **Gateway-mediated cookie authority, sealed** — BUILT (packages/tierless/src/
  session-auth.mts + adapt-session-auth.mts; probe test/probes/session-auth.mts;
  live in the n8n port, ports/n8n/README.md). The design that unblocks
  cookie-authed SPAs at the session socket, with the gateway
  authority-STATELESS. The gateway mints a
  secret key at boot and never shares it. At ws upgrade the browser presents
  the httpOnly cookie (cookies ignore ports); the gateway SEALS it under the
  key and hands the blob to the browser runtime instead of storing it. Every
  crossing carries the blob; the gateway decrypts, uses, forgets — authority
  travels with the request, as in the header-auth ports. Rotation is in-band
  and exec-path-wide, not a login special case (n8n rolls the cookie near
  expiry on arbitrary responses): a mediated `set-cookie` rides down as a new
  blob and the runtime swaps. The browser jar syncs via a claim request
  carrying the blob plus a 30 s nonce, whose HTTP response emits the
  Set-Cookie (script cannot write httpOnly — a ws frame cannot plant it).
  Tabs coordinate rotation via BroadcastChannel: the rotating tab broadcasts
  AFTER its claim request lands the fresh cookie in the shared jar; hearers
  refresh without dropping their socket via a `reseal` request — the claim's
  mirror image (claim: blob in, Set-Cookie out; reseal: jar cookie in, blob
  out; same boot key, both stateless). The channel's reach (same-origin,
  same-profile tabs) is exactly the jar's. On a session-exec 401, drop the
  blob and re-upgrade — the catch-all for tabs that missed the broadcast
  (frozen/bfcached) or invalidation with no broadcast at all.
  Alternative for the exec-only stage: a SharedWorker owning ONE socket per
  jar dissolves the multi-tab problem instead of coordinating it (one blob,
  one deflate window across tabs; n8n's push-ref is a per-REQUEST header, so
  per-tab push routing survives a shared transport). Deferred, not dismissed:
  it needs a per-tab-socket fallback where SharedWorker is absent, and the
  full-tierless session is per-page today (merged machine world, twins) —
  sharing one session across tabs needs per-tab namespacing first. Properties to state when it lands: page script can hold
  the blob but not read the JWT inside — XSS can use the session (as it can
  stock same-origin XHR) but not exfiltrate the token, which is httpOnly's
  actual guarantee; and the blob adds no lifetime — the backend still
  validates the decrypted JWT, so a stolen blob is worth exactly a stolen
  browser session. A gateway restart self-heals: blobs die with the key,
  sockets reconnect, the fresh upgrade re-presents the jar cookie.
- **Browser network interception is defeated by the session socket** (from the
  n8n port — the session-socket stage's defining limitation, and a first-class
  entry on the requirements list). Moving I/O off the browser makes it
  invisible to anything that hooks the browser's own fetch/XHR: service
  workers, extensions, devtools, and — where it surfaced — a test harness's
  response mocking (Playwright `route()` saw none of the socket traffic, so 33
  of the ported suite's tests went unmocked). The port answers with a
  **force-browser seam** (packages/tierless, consulted in the n8n patch 0005):
  a page global lists URL globs that must stay on the browser's own fetch;
  matching same-origin requests take the direct-fetch exec instead of the
  socket. Empty in production, so it is a real embedder control (keep a
  resource SW/extension-visible), not a test hack; the n8n test patch 0007
  auto-populates it by wrapping `route()`. Open question for any consumer of
  the socket: which resources must remain browser-observable is an app-level
  policy the framework can only expose, not decide.
- **Byte pricing at the method boundary.** `methodMigrate` migrates on structural
  evidence alone (a stable ≥2-call same-tier chain) without comparing continuation
  bytes to the profiled fetch bytes the way `decide()` does — a method carrying a
  large serializable frame over two tiny responses migrates and pays for it. The
  fix needs the continuation encoded (or size-estimated) BEFORE the migrate
  decision, an API change to the §6 callback; do it together with the shipped
  decide loop above and re-measure the migrate arms.

## Adoption & measurement

- **Burst coalescing: review after more ports, or remove.** Implemented and
  measured on Vikunja (ports/vikunja/COMPILING.md, 2026-07-09): merging
  concurrent exec crossings into one `execBatch` frame cut session ws frames
  24% with zero time or byte movement — concurrent requests already overlap
  their RTTs, and deflate already absorbs payload repetition. Default OFF
  (`__TIERLESS_EXEC_BATCH__` opts in). Decision rule: if no later port
  surfaces a case where frame count is the paid unit (per-message pricing,
  mobile radio budgets), remove the mechanism and keep the Vikunja results
  as the recorded answer.

- **The corpus program** (`docs/corpus.md`): a statistical claim over real apps —
  "median X× less network wait, Y% less IO across N apps' own e2e journeys."
  Rungs 1–3 are built (harness verified against socket ground truth; REST-proxy
  adapter + route-workflow shim; Vikunja ported at a 2-line diff, 196/196 pass
  parity, 13% less suite IO / 16% fewer round trips — median per test 35%
  fewer bytes, 22% fewer trips). Open: the 10–20-app study reporting medians
  and full distributions, losers included.

- **The session socket's network-wait loss — FIXED to the websocket floor.**
  RESOLUTION (n8n, results/report-time-rtt80-p2.txt): two fixes — the reseal folded
  into the ws upgrade, and the boot GETs pre-fetched at the upgrade and JOINED by the
  first crossings — cut the regression from **+20% to +6%** (median wait +740 → +265 ms)
  with the 49% byte win and full correctness intact (670 floor / 667 rtt80 passed,
  pass-parity). The residual +6% is **86% the websocket handshake** (TCP + upgrade =
  2 RTT = 160 ms), paid **per fresh browser context** — 99 s of the 115 s pool excess
  over 618 tests. A real long-lived session pays that ONCE; the e2e harness pays it 618×,
  so the harness number overstates the loss and a real session runs at ~parity on wait.
  The other 17 s (14%) is workflow-ID/project-specific editor GETs a static preboot
  manifest can't cover (IDs unknown at the upgrade), multiplexed at ~1 RTT. "Colocate the
  gateway on the app origin" (below) is now known to buy ~0 — a ws needs its own handshake
  to ANY origin. Mechanism/proof: boot crossings 19 → 1, boot data path −1.4 s
  (results/boot-setup.txt); packages/tierless hello capability (test/e2e/preboot-live.mts);
  n8n patch 0005 + gateway.mts + boot.mts (both fixes ON by default, env-toggleable).
  The ORIGINAL loss, for the record:
  Measured on n8n (results/report-time-rtt80.txt): at 80 ms
  RTT the port cut wire bytes 49% but ADDED ~20% network wait (median 2946 ->
  3686 ms/test, ~9 extra round trips). Vikunja forfeited its 486 ms data-path
  lead to parity; n8n's more parallel boot fan-out makes it a net regression.
  The socket's structure costs round trips stock HTTP didn't: (a) a SECOND
  connection — the standalone gateway is its own origin, paying a TCP+ws-upgrade
  handshake on top of the app origin → colocate the gateway ON the app origin
  (one connection, upgrade in place); (b) a reseal round trip before the first
  crossing → amortize or fold into the upgrade. (NOT lost parallelism — the
  runtime multiplexes concurrent crossings on the one socket, verified from the
  transport code; see the refined diagnosis below.)
  The e2e harness's per-test fresh context pays the one-time setup 736x, so the
  amortizable part overstates the loss — but the SECOND-ORIGIN handshake recurs
  per context (not lost parallelism; the socket multiplexes — see below). Until
  this is fixed the port trades latency for bytes: a win only where bytes are the
  paid unit (metered/mobile radio), a wall-time loss under RTT.

  DIAGNOSIS REFINED (n8n, from the runtime code): the socket MULTIPLEXES —
  `execOver → peer.request` (transport.mts:makePeer) assigns a correlation id
  and sends immediately, many crossings outstanding at once, replies matched by
  id — so the regression is NOT lost parallelism, the scariest hypothesis,
  disproven. What remains is session setup LAZY on the critical path:
  `connect().exec` awaits the ws `open` event, and both the handshake and the
  reseal fire on the FIRST /rest (configureTierless({preconnect}) is called
  inside the adapter, so "preconnect" never overlaps page load).

  EAGER BOOTSTRAP — TESTED, DISPROVEN (results/eager-boot-ab.txt). The candidate
  fix opened the socket + kicked the reseal at MODULE IMPORT, hoping to hide the
  ~240 ms of setup (ws handshake + reseal ≈ 3 RTT at 80 ms) behind JS/asset
  bootstrap. A clean, drift-controlled dist-swap A/B settles it: two prebuilt
  ported dists differing by exactly the one line (eager self-invocation;
  confirmed the ONLY semantic delta), same 24-test subset at RTT80, two rounds
  each, minutes apart on a calm box. Both arms are the ported build at RTT80 so
  the RTT0 floor cancels — the durationMs delta IS the net-wait delta. Result:
  a WASH both rounds (R1 −0.1%, R2 −0.0%; pooled mean −13 ms/test, eager if
  anything marginally slower). The effect is an order of magnitude below the
  per-test noise (stdev 483 ms) and below the round-to-round drift of the SAME
  build (±0.6–0.7%, stdev 620–740 ms). The earlier "~10–15% faster" reading was
  an artifact of a container-suspend freezing that run mid-measurement. So the
  one-time lazy setup is NOT the load-bearing cost: page-load /rest fires nearly
  as early as module import, leaving no window to overlap, and the e2e harness's
  per-context repayment (the 736× the report flagged) is what made it look
  amortizable. Patch 0005 stays lazy — no reason to add the eager code.

  WHAT LANDED (supersedes the eager attempt): eager RE-TIMED the setup (a wash — no
  overlap window); the fixes REDUCE it. (1) Reseal folded into the ws upgrade — the
  gateway seals the socket's cookie at the handshake and returns the blob in an unsolicited
  `hello`, killing the reseal round trip (first crossing −200 ms). (2) Preboot — the gateway
  pre-fetches the boot GETs at the upgrade and pushes them in the `hello`; the first
  crossings JOIN the buffer (19 → 1 crossings, boot data −1.4 s). Both delivered on ONE
  frame at the upgrade. What did NOT help and why: colocating the gateway on the app origin —
  a websocket needs its own TCP + upgrade to any origin, so there is no handshake to save;
  the residual IS that handshake, irreducible for a ws transport and amortized once per real
  session. Fully general open item: route-aware preboot (the upgrade carrying the route so
  ID-specific GETs can be pre-fetched) would close the last 14%, at the cost of the upgrade
  learning the SPA route — deferred; the win is small and partly irreducible (first-open of
  an arbitrary record can't be predicted at the upgrade).

## Bigger swings

- **Durable continuations.** Persist a parked continuation and resume it after
  a process restart or on another machine — leaning hardest on "the
  continuation is data you own."
- **Auto-rewrite of Array HOF callbacks.** `items.map(x => api.f(x))` is a
  clear compile error today (a callback runs inside native code that can't
  suspend); the known Array cases could be loop-rewritten automatically.

## Not on the roadmap (by design)

- **Per-component continuation identity / render-splitting.** The framework is
  general-purpose and React runs *inside* it as ordinary code; finer granularity
  adds tier crossings and buys no parallelism. The coarse unit — migrate the
  whole continuation, cross only when forced — is the right one.
- **Native engine stack capture** (async/generator or WASM stack-switching
  state) — suspend-but-not-serialize cannot move a live computation across a
  process (design §8). The transportable continuation stays the compiler's own
  data structure.
