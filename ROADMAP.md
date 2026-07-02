# Roadmap

What's genuinely open. Everything that has landed — with its measurements and
proofs — moved to [`CHANGELOG.md`](./CHANGELOG.md); the mechanism itself is
proven (33 executable proofs, `npm test`).

## Toward a first npm release

- **Publish `stackmix` + `create-stackmix`** at 0.1.0 (the packages are shaped
  and `npm pack`-verified; the README quick start assumes the registry).
- **TypeScript sources for mix modules.** The public API is fully typed
  (hand-written `.d.ts`, tsc-verified in `npm test`), but `"use mix"` files are
  plain JS: the transform needs @babel/parser's TS plugin + type stripping.
  Richer generated types than `(...args: any[]) => any` from `stackmix types`.
- **Production build story for the Vite plugin.** Dev is first-class (the
  plugin hosts the endpoint on Vite's own server); prod works today by mounting
  `attachStackmix` with a CLI-built machine (see `docs/production.md` and
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
