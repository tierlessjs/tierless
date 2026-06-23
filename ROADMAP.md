# Roadmap

Stackmix is a research-stage framework. The load-bearing claim — small,
serializable, migratable continuations with placement inferred from resources —
is proven (see the [README](./README.md) and the test suites). What follows is
where it goes next. Items are grouped, not strictly ordered; see
[`docs/design.md`](./docs/design.md) `§10` for the original open questions.

## Language & frontend

- **Remaining ES-module surface.** Named imports/exports of functions, classes,
  and consts work today. Still to wire in: `export default`, `export *` /
  re-exports (`export { x } from ...`), and namespace imports (`import * as M`).
  The import resolver is checker-based, so these are mostly wiring in
  `compileProgram`'s declaration resolution and import emission.
- **Source maps** (design `§10.6`). Every IR instruction already carries its TS
  position; the unfinished part is emitting that as portable file/line metadata
  that survives into a standard source map. Design it into the transform, don't
  bolt it on afterward.
- **Resolve the documented frontend caveats** where they prove to matter (TDZ
  enforcement, dynamic accessors; see [`docs/architecture.md`](./docs/architecture.md#known-limitations-and-intentional-caveats)).

## Runtime & transport

- **Cross-process handle fetch — wire the transport.** The invariant is honored
  (a deref-miss suspends and re-runs correctly; verified in
  `test/probes/deref.mjs`), and the cost model exists (`examples/policy`). The
  remaining piece is the live transport that fetches a §5 handle across a channel
  on demand.
- **Binary wire format.** The continuation wire is JSON today. Espresso's
  Kryo-vs-Java result (~half the size) motivates moving to a compact binary
  encoding; keep the `heap`/`fetch` seam so serialization stays swappable.
- **Incremental snapshotting.** Golem's delta-based capture is the reference for
  making repeated captures cheap rather than re-serializing the whole state.
- **Content-addressed code identity.** Resume-by-instruction-offset breaks under
  version skew between tiers. Unison's content-addressing is the known fix;
  revisit when tiers may run different builds.

## Platform

- **Browser target.** No browser host yet; the JS path is Node-only today.
- **Full-language WASM path** is explicitly *not* planned — the JS path covers the
  language; the wasm path exists only to prove the linear-memory capture
  mechanism.

## Framework shape

- **A multi-file, framework-shaped sample app** (Nest/Angular-shaped: a DI graph,
  decorated controllers/providers, a request that migrates mid-handler) to shake
  out what real framework code hits now that imports + decorators + DI work.
  Likely surfaces: lifecycle hooks, async providers, guard/interceptor chains,
  request scoping.
- **Package extraction.** If independently versioned packages earn their keep,
  split `src/runtime`, `src/compiler`, and `src/wasm` into `@stackmix/*` packages
  along the existing module seams. Deferred until needed.

## Not on the roadmap (by design)

- **Native WASM stack capture** — not serializable, not in browsers; capture stays
  at the interpreter level (design `§8`).
- **Replay/journaling as the migration mechanism** — replay reconstructs state by
  re-running history, which can't move a *live* mid-call computation across a
  trust boundary. It's a complementary durability story, not a substitute (see
  [`docs/prior-art.md`](./docs/prior-art.md#b-replay-from-a-log-the-alternative-we-are-not-using)).
