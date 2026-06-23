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

- **Cross-process handle fetch — wired (WebSocket).** Done: a deref-miss suspends
  and re-runs correctly (`test/probes/deref.mjs`), the cost model exists
  (`examples/policy`), and a §5 handle is now fetched on demand across a real
  WebSocket — `src/runtime/wss.mjs`, exercised end-to-end in `examples/wss`. The
  migrate/fetch loop is shared by both ends, so fetch works either direction
  (client→server is the one a demo exercises). Next: the binary wire format below.
- **Binary wire format.** The continuation wire is JSON today. Espresso's
  Kryo-vs-Java result (~half the size) motivates moving to a compact binary
  encoding; keep the `heap`/`fetch` seam so serialization stays swappable.
- **Incremental snapshotting.** Golem's delta-based capture is the reference for
  making repeated captures cheap rather than re-serializing the whole state.
- **Content-addressed code identity.** Resume-by-instruction-offset breaks under
  version skew between tiers. Unison's content-addressing is the known fix;
  revisit when tiers may run different builds.

## Platform

- **Browser target.** The *transport* is now browser-ready — `connectWss` runs on
  the browser's native `WebSocket` and the wire codec is `Buffer`-free — but
  nothing runs in an actual browser yet: no DOM-resource host, no bundle, no
  headless-browser test. That last mile is the remaining browser-target work.
- **Compile the IR to WASM (browser execution path).** Reverses the earlier
  interpret-only stance: the browser should run the program as native WASM, not a
  bytecode interpreter. Lower IR→WASM via Binaryen (drafting off AssemblyScript for
  the vanilla codegen), keep continuations serializable with Asyncify — its unwind
  state lives in linear memory, so it slices out and ships — then layer the §5 heap
  + resume-by-offset model on top. The load-bearing step is proven in
  `test/probes/asyncify.mjs`: a compiled-wasm continuation suspended at a resource
  call, its call stack serialized, and resumed in a *fresh* instance.

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
  trust boundary. It's a complementary durability story, not a substitute.
