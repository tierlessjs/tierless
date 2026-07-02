# Changelog

Notable changes, per release. Tierless is pre-1.0 — semver applies, but a `0.x`
minor may break. This file is the release-level summary; the architecture and the
measured benchmarks behind these features live in [`docs/design.md`](./docs/design.md)
and `npm run bench`, and every feature ships with an executable proof in `npm test`.

## 0.1.0 — 2026-07-02

First public release: `npm i tierless` · `npm create tierless@latest <app>`.

One plain-JavaScript codebase that runs across browser and server, with the
runtime migrating live execution between tiers as serializable continuations —
so a multi-call workflow crosses the network once, not once per call.

**Compiler.** An AOT transform for `"use tierless"` modules lowers ordinary JS
into serializable `while/switch` state machines: full control flow (loops,
`try/catch/finally`, `for-of`/`for-in`), destructuring and non-simple parameters,
and suspensions in expression and optional-chain positions. A tier call that
can't migrate (inside a native callback or comparator) is a clear compile error,
never a silent miscompile. Also importable as a library (`compile()` / `analyze()`)
with a configurable resource allow-list, plus optional `--auto-deref`,
`--auto-writeback`, `--track-writes`, and `--source-map` passes.

**Runtime & migration.** A continuation-migration runtime — generic pump,
symmetric session protocol, and a stateless-per-message host (`serveApp`,
`attachTierless`, `connect`) — moves a live continuation across a real WebSocket,
with a Chromium browser tier. A distributed handle heap keeps large locals on
their owning tier, fetched on deref, single-writer coherent with optimistic-CAS
write-back.

**Wire.** A compact binary wire (type tags + varints, string/shape intern tables,
a typed-array fast path), hardened and fuzz-tested against hostile input.
Write-tracked delta capture ships `min(delta, full)` per hop, down to
per-field/element granularity; immutable subgraphs are content-addressed — shipped
once, then by hash.

**Trust boundary.** The reference monitor is the default `api.*` path:
`defineApi()` with mandatory load-time `authorize`, default-deny, and signed-token
principals, running in a forked sidecar process over a local pipe. A denial throws
into the continuation and is catchable across tiers. Per-call argument-size and
per-principal rate budgets are included.

**Developer experience.** Shipped as an npm package with a hand-written typed
surface (`.d.ts` for every entry), the `tierless` CLI (`build` / `explain` / `api`
/ `types`), a Vite plugin with React `useAction`, the `create-tierless` scaffold,
and an `examples/react-vite` reference app.

The framework was renamed from Stackmix to Tierless before this first publish; the
`"use mix"` directive remains accepted as an alias for `"use tierless"`.
