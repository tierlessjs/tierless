# Roadmap

What's genuinely open. Everything that has landed — with its measurements and
proofs — moved to [`CHANGELOG.md`](./CHANGELOG.md); the mechanism itself is
proven (34 executable proofs, `npm test`).

## Packaging & release

`tierless` and `create-tierless` are published — `npm i tierless` /
`npm create tierless@latest` work, both with npm provenance. Still open:

- **TypeScript everywhere.** The framework's own source
  (`packages/tierless/src/*.mts`/`*.cts`, `bin/`, `create-tierless`, `test/`, `bench/`) is
  TypeScript, compiled or type-checked by `tsc` on every build — checked against
  the real implementation, not hand-maintained separately. `"use tierless"` mix
  modules can be authored in TypeScript too (`app.src.ts`): the compiler
  detects the extension and strips erasable TS syntax (`node:module`'s
  `stripTypeScriptTypes`, the same ceiling as `node --experimental-strip-types` —
  no enums, no namespaces, no parameter properties) before parsing, so the rest
  of the compiler stays untouched. `tierless types` reads each endpoint's
  parameter list from its `run: ([sym, n = 1, ...rest]) => …` destructure (the
  caller's real signature), so a wrong-arity `api.*` call in a mix module fails
  to type-check; a run that takes the raw args array keeps the honest
  `(...args: any[])` fallback. Still open: return types are `any` — inferring
  them needs a type checker over the service body, not a parse.
- **Production build story for the Vite plugin.** Dev is first-class (the
  plugin hosts the endpoint on Vite's own server); prod works today by mounting
  `attachTierless` with a CLI-built machine (see `docs/production.md` and
  `examples/react-vite/server.prod.mjs`) but should become a build-time output.

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
- **Whole-program placement optimization.** §6 prices one hop at a time (greedy);
  Stip.js's search-based tier assignment optimized placement globally (total
  communication, offline availability). A PDG-style global view over the suspension
  graph could pre-place or replicate pure helpers better than local decisions.

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
