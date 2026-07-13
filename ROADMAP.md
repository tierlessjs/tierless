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
- **Gateway-mediated cookie authority, sealed** (from the n8n port,
  ports/n8n/README.md — the design that unblocks cookie-authed SPAs at the
  session socket, with the gateway authority-STATELESS). The gateway mints a
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
  (frozen/bfcached) or invalidation with no broadcast at all. Properties to state when it lands: page script can hold
  the blob but not read the JWT inside — XSS can use the session (as it can
  stock same-origin XHR) but not exfiltrate the token, which is httpOnly's
  actual guarantee; and the blob adds no lifetime — the backend still
  validates the decrypted JWT, so a stolen blob is worth exactly a stolen
  browser session. A gateway restart self-heals: blobs die with the key,
  sockets reconnect, the fresh upgrade re-presents the jar cookie.
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

- **Cash the measured 486 ms data-path lead** (ports/vikunja README, timing
  section). Under real 80 ms RTT the port delivers all route data at t=260 vs
  stock's t=746, yet click-to-render is at parity (859 vs 870 ms) because the
  code path forfeits the lead. In order: preload workflow modules at boot (the
  lazy chunk costs the first RTT before the ws send); let the router's guard
  fetch race the network instead of waiting on the workflow hold (first answer
  wins); then profile the remaining ~380 ms render tail on the ported arm.

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
