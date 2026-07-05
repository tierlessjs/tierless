# Roadmap

What's genuinely open. Everything that has landed — with its measurements and
proofs — moved to [`CHANGELOG.md`](./CHANGELOG.md); the mechanism itself is
proven (38 executable proofs, `npm test`).

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

## Adoption & measurement

- **The corpus program** (`docs/corpus.md`): a statistical claim over real apps —
  "median X× less network wait, Y% less IO across N apps' own e2e journeys."
  Rung 1 (the measurement harness, `bench/harness/`) is built and verified
  against socket ground truth. Open: the REST-proxy adapter + gateway recipe
  (existing backends as `api.*`, no rewrite), the agent-assisted porting recipe
  hardened on 2–3 real open-source apps, then the 10–20-app study reporting
  medians and full distributions, losers included.

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
