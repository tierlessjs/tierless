# Architecture

This document explains how Stackmix is put together and why. For the original
vision and the open research questions, see [`design.md`](./design.md) (the
spec). For where Stackmix sits among related systems, see
[`prior-art.md`](./prior-art.md).

## The model in one paragraph

You write one program in ordinary TypeScript. You do **not** annotate which parts
run on the client and which on the server. Instead, placement is *inferred* from
the resources each call touches — `db.*` forces the server, `ui.*`/`DOM.*` force
the client. When execution reaches a resource the current tier doesn't have, the
runtime captures the live continuation (the call stack, as plain serializable
data), ships it to the tier that does have the resource, and resumes it there.
The big data stays where it lives; only the small continuation moves.

## Repository layout

```
src/                  the framework (what ships)
  index.mjs           the public API surface + createRuntime() (composition root)
  runtime/
    core.mjs          the interpreter, the IR, the continuation wire format
    heap.mjs          identity-preserving, cycle-safe graph codec for the wire
    frame.mjs         length-prefixed framing (JSON header + binary attachment)
    fetch.mjs         §5 handle deref: local / cached / fetch-from-owner
  compiler/
    tsc.mjs           TypeScript -> Stackmix IR, via a real ts.Program + checker
  wasm/
    interpreter.wat   the interpreter as a WebAssembly module
    core.mjs          wasm runtime: instances, capture/restore, heap, policy
    compile.mjs       the i32 TS subset -> wasm IR
    build.mjs         interpreter.wat -> interpreter.wasm (via wabt)
bin/stackmix.mjs      the CLI (compile / run / new)
types/index.d.ts      hand-written type declarations for the public API
examples/             runnable demos (spike, two-process, wasm, hn-thread, ...)
bench/                the HN waterfall + Conduit over-fetch benchmarks
test/                 conformance, differential, decorator, multi-module suites + probes
templates/basic/      the `stackmix new` scaffold
docs/                 this document, the design spec, prior art
```

The load-bearing framework is `src/`. Everything else is evidence that it works
(`examples/`, `bench/`, `test/`) or supporting material (`docs/`, `templates/`).

## Public API

The single supported entry point is `#stackmix` (internally) / `stackmix`
(as a package), which resolves to `src/index.mjs`. The batteries-included entry
is `createRuntime()`:

```js
import { createRuntime, Tier, serializeContinuation } from "stackmix";

const rt = createRuntime();              // an isolated program registry + bound interpreter
rt.load(tsSource, { entry: "main", resources: ["db.query", "ui.render"] });
const result = rt.run(tier, frames, host);
```

A **runtime** owns one program registry and binds the interpreter and the
TypeScript frontend to it. Two runtimes never share state — this replaced the
prototype's single process-wide `PROGRAM` global. Lower-level primitives (`run`,
the wire codec, the compiler functions) are also exported for advanced use; deep
imports (`#stackmix/runtime/...`, `#stackmix/wasm/...`) exist but carry no
stability guarantee.

## Core concepts

- **Program / IR.** A program is a plain registry: function name → `{ nlocals,
  code, pos? }`. The IR is a WASM-shaped stack machine with explicit numbered
  locals. Every resource access compiles to a single `RES` instruction — the only
  place a migration can happen. Boundaries are visible at compile time; the
  decision to migrate is made at runtime.
- **Tier.** An isolated execution context: its own resource imports and its own
  heap. The client tier physically cannot call `db.query` — it isn't in its
  import set. Two tiers run the *same* program (code travels by reference; resume
  is by instruction offset).
- **Continuation + wire format.** A captured continuation is the live frame stack
  plus what it's waiting on. `serializeContinuation` encodes everything reachable
  through `heap.mjs`'s graph codec: shared references stay shared, cycles survive,
  and any subgraph larger than `HANDLE_THRESHOLD` becomes an opaque §5 *handle*
  into the owning tier's heap instead of being copied.
- **Host / deref.** Dereferencing a handle resolves three ways: it's *local* (use
  it), it's *cached* (use the snapshot), or it's *remote* — which returns a `Miss`
  that the interpreter turns into a fetch suspension. Every deref-touching opcode
  is peek-then-deref, so a miss leaves the stack and instruction pointer intact
  and the re-run is correct.

## Why the transportable continuation is ours to build

A reasonable question: modern JS has `async`/`await` and generators — native
suspension. Why not capture *those*?

Because native async is **suspend-but-not-serialize**. A paused async or generator
state is engine-internal; you cannot read it out as bytes and ship it to another
process. (This is the same limitation that makes the WebAssembly stack-switching
proposal in-process and one-shot — see design `§8`.) So Stackmix reuses async
*semantics* for the boundary shape — a resource access is just an `await` — but the
*transportable* continuation is its own data structure, captured at the
interpreter level in Stackmix's own IR. That is the load-bearing design decision,
and it's why the prototype does not depend on any unreleased platform feature.

## The two execution paths (intentional)

Stackmix has two interpreters with different jobs:

- **The JS path** (`runtime/core.mjs` + the `compiler/tsc.mjs` frontend) is the
  language substrate. It runs arbitrary JS values and is where all the language
  coverage lives — closures, classes + inheritance, generators, async,
  destructuring, BigInt/Symbol, getters/setters, the metaprogramming surface
  (Proxy, Reflect + metadata, decorators, type-based DI), and multi-module
  programs — all proven to survive serialize/resume migration and measured for
  fidelity against Node's own evaluator.
- **The WASM path** (`wasm/interpreter.wat`) is the minimal proof that the
  continuation can live in linear memory — a byte-slice that crosses a real pipe
  between two processes. It is deliberately i32-only; extending it to the full
  language is not the point. The two are separate tracks, not a coverage gap.

## Known limitations and intentional caveats

These affect only buggy or exotic code; each is a deliberate trade-off in the
TypeScript frontend, not an accidental gap:

- **TDZ non-enforcement.** Reading a `let`/`const` before its declaration yields
  `undefined` rather than a `ReferenceError` (enforcing it would cost a sentinel
  check on every read).
- **Dynamic accessor keys.** A *static* `obj.x` read does not fire an accessor
  installed via `Object.defineProperty` or a computed-name accessor; computed
  access `obj[k]` does. (Belongs with a future reactivity pass.)
- **Dynamic `new` / `Reflect.construct` on top-level classes.** The inline
  `new LocalClass()` path is unaffected; only dynamic construction of a *local*
  class whose methods close over enclosing scope is restricted.
- **`emitDecoratorMetadata` across imported type *aliases*.** Same-module and
  imported *classes* resolve via the checker (the dependency-injection case
  works); following an imported `type X = ...` alias to its ultimate type does
  not.

Broader prototype limits (no native wasm stack capture by design; numeric-only
wasm path; fixed working-heap size; cross-process handle *fetch* transport not yet
wired; no browser target or portable source maps yet) are described in the README
and tracked in [`../ROADMAP.md`](../ROADMAP.md). They line up with the design
doc's own open questions (`§10`).

## Evolving the structure

`src/runtime`, `src/compiler`, and `src/wasm` are deliberately clean module
boundaries: the runtime does not depend on the compiler (you can run IR without
the TypeScript frontend), and the wasm path is independent of both. If and when
the project benefits from independently versioned packages, these subdirectories
are the natural seams to extract into `@stackmix/runtime`, `@stackmix/compiler`,
and `@stackmix/wasm`. That split is intentionally deferred until it earns its
keep — a single package with clean internal boundaries is simpler to develop and
release today.
