# Waso — prototype

A working prototype of the ideas in [`initial-design.md`](./initial-design.md):
**one program that runs across client and server, with the runtime moving
execution between tiers as needed** instead of you splitting it by hand.
Placement is inferred from which resources you touch; when you cross a tier
boundary mid-computation, the live continuation is serialized and resumed on the
other side.

This is the design doc's §11 first prototype and several steps past it. It does
**not** require the in-flight WASM stack-switching proposal (§8): capture happens
in Waso's own IR, where the continuation is *Waso's* data structure — readable
and serializable — exactly as the doc argues.

```
npm install
npm test          # runs every demo and checks the headline claims
```

## What it shows

The central empirical bet (design doc open question #1): **does the continuation
actually stay small on real code?** Yes. A program queries a large dataset on
the "server", filters it, and renders the result on the "client". It is forced
to cross once each way. The continuation that migrates carries the *live stack*,
while the big dataset stays put as a tier-local heap object:

```
continuation crossing the wire : 8.2 KB
full dataset, had we shipped it : 8.00 MB
ratio                          : ~978x smaller
```

## The demos

| Command | File(s) | What it proves |
|---|---|---|
| `npm run spike` | `waso-spike.mjs` | continuation ≪ dataset; single process, JS interpreter (§4.4, §11) |
| `npm run 2p` | `waso-2p-*.mjs` | survives real serialization across two OS processes; the `undefined`→`null` JSON gotcha handled |
| `npm run wasm` | `waso-wasm.mjs` | **TypeScript → Waso IR → wasm**; the continuation is a slice of wasm linear memory (§4.2) |
| `npm run wasm:2p` | `waso-wasm-2p-*.mjs` | the full stack: the linear-memory slice crosses a real pipe between two processes |
| `npm run policy` | `waso-policy.mjs` | migrate-vs-fetch cost model with real measured sizes (§6) |
| `npm run bench:hn` | `bench-hn.mjs` | **HN waterfall benchmark**: REST round trips vs continuation migration (`--real` for wall-clock) |
| `npm run bench:sweep` | `bench-sweep.mjs` | the HN benchmark as a **scale curve** over thread size and RTT (writes `bench-sweep.csv`) |
| `npm run bench:conduit` | `bench-conduit.mjs` | **Conduit feed benchmark**: REST over-fetch vs server-side assembly (the bandwidth win) |
| `node conformance.mjs` | `conformance.mjs` | **conformance suite**: full-language fidelity vs Node, AND survival of every feature across a serialize/resume continuation migration |
| `node difftest.mjs` | `difftest.mjs` | **differential tester**: ~217 semantic-corner snippets run through Waso *and* Node; completeness is measured, not asserted (214/217, 3 documented caveats) |
| `node decorators.mjs` | `decorators.mjs` | **decorator/DI conformance** vs the TS `experimentalDecorators` transpile (Node can't run the syntax) — class/method/property/param decorators + type-based DI, surviving migration |
| `node multimodule.mjs` | `multimodule.mjs` | **multi-module**: an import graph compiled into one program — namespacing, cross-module inheritance/DI, dependency-ordered init, and a multi-file program migrating as one |

### Two execution paths (by design)

Waso has **two interpreters**, on purpose, with different jobs:

- **The JS path** (`waso-core.mjs` + the `waso-tsc.mjs` frontend) is the **language
  substrate**: it runs arbitrary JS values and is where all the language coverage
  lives. It now spans essentially the whole language — closures, classes +
  inheritance, generators, async, destructuring, BigInt/Symbol, getters/setters,
  the metaprogramming surface (**Proxy, Reflect + metadata, decorators, type-based
  DI**), and **multi-module programs** (an import graph compiled into one program
  via a real TS type checker) — all proven to survive serialize/resume migration,
  and measured for fidelity against Node's own `eval` (`probe-realts.mjs`, plus the
  conformance / differential / decorator / multi-module suites below).
- **The WASM path** (`waso.wat`) is the **minimal proof that the continuation can
  live in linear memory** — a byte-slice of wasm memory that crosses a real pipe
  between two processes. It is deliberately **i32-only**: no heap objects, closures,
  strings, or BigInt. Extending it to the full language is *not* the point; the JS
  path already demonstrates the language, and the WASM path demonstrates the
  capture/serialize mechanism in a real linear-memory VM. The two are intentionally
  separate tracks, not a coverage gap.

### The benchmark (`npm run bench:hn`)

The Hacker News thread shape is the canonical client-side waterfall: loading a
thread means fetching the story, then each comment, then its children — one
dependent request per node, with no "fetch the whole thread" API. The benchmark
runs the **same traversal** under the runtime across a 2×2 of concurrency ×
placement (all four cells executed, not modeled):

```
                       per-item (sequential)     per-level (concurrent)
  client (REST, stay)   13208ms / 254 rt            312ms /   6 rt
  Waso   (migrate)        608ms /   2 rt            112ms /   2 rt
```

Two independent levers, both on identical traversal source:
- **concurrency** collapses round trips from O(nodes) to O(depth);
- **migration** collapses the *client* round trips to 2 — once the traversal is
  on the server, its per-level rounds are cheap server↔API hops, not client↔server
  RTTs.

**Waso (migrate + concurrent) = 112ms** beats naive REST (13208ms, **118×**) and
even a hand-tuned parallel client (312ms, **2.8×**) — because the client still
pays one RTT per tree level (6 levels here) while Waso pays 2 client RTTs total,
regardless of depth. `--real` injects real sleeps; measured **12.8s → 0.10s**.

This is the "minimal change to an existing app" story: the obvious sequential
code an agent writes, migrated, beats the optimal hand-tuned client — no
batching, resolvers, or client orchestration in the source. (The per-level
concurrency assumes the server can fetch a level at once, which it can, being
co-located with the data; the public per-item API the client is stuck with
cannot.)

`npm run bench:sweep` shows this as a curve, not a single point — round trips
and latency as the thread grows and as RTT varies:

```
  nodes  depth │   REST (naive)      parallel client    Waso (migrate)  │  vs REST   vs client
     10      2 │    10rt   520ms    3rt   156ms   2rt   106ms │      5x      1.5x
    300      5 │   300rt   15.6s    6rt   312ms   2rt   112ms │    139x      2.8x
  10000      9 │ 10000rt  520.0s   10rt   520ms   2rt   120ms │   4333x      4.3x
```

REST round trips grow O(nodes); the parallel client O(depth)≈log(nodes); Waso
stays **2, flat**. So Waso's win vs naive grows without bound, and it holds
~depth/2 even against the optimal client — and the gap widens as RTT rises,
since Waso's cost is ~constant in round trips while both client strategies
scale linearly with the network.

### A second benchmark — Conduit (`npm run bench:conduit`)

HN proves the **latency/round-trip** win on a deep waterfall (bytes were equal).
The RealWorld/Conduit home feed proves a different one — **bandwidth/over-fetch**.
The feed is filtered by a predicate the public API doesn't support, so a REST
client must drag every article body to the client to filter and join locally,
plus an N+1 round trip per article for its author. Waso runs the same assembly
on the server and ships back only the small projected feed:

```
  strategy               round trips    bytes      latency
  REST (over-fetch)       202 rt     4.08 MB    10504ms
  Waso (migrate)            2 rt     11.3 KB      504ms
       -> 362x less data, 21x faster, identical result
```

A bespoke server endpoint could also avoid the over-fetch — but that's new
boilerplate for every filter you didn't anticipate (the design doc's §2). Waso
runs the filter inline because it's already where the data is. Together the two
benchmarks cover both axes of the value: HN = round trips/latency on sequential
depth; Conduit = bandwidth on fan-out filtering + joins.

## How it works

- **The IR.** A WASM-shaped stack machine with explicit, numbered locals. Every
  resource access (`db.query`, `DOM.renderList`) compiles to a `RES` instruction
  — the only place a migration can happen (§4.3). Compile-time visibility of
  boundaries; runtime decision at them.
- **Resources are imports = the tier model.** In the wasm path the two tiers are
  two instances of the *same* module wired with *different* imports. The client
  instance physically cannot call `db.query` — it isn't in its import table
  (§4.2.1, §7). Hitting a resource you don't have throws from the host, which
  unwinds wasm to the host with linear memory intact (§8.3.3). The `RES` opcode
  is written to be re-runnable, so re-executing it on the tier that *does* have
  the resource just succeeds.
- **The continuation is data you own.** In the JS path it's plain objects
  (frames of `{ip, locals, stack}`); in the wasm path it's a byte-slice of
  linear memory (control regs + operand stack + the whole call stack + the small
  working heap). Not the code (both tiers run the same module; resume is an
  instruction offset) and not the big heap (§4.4).
- **Multi-frame.** The wasm interpreter has a real call stack in linear memory,
  so a continuation captured inside a nested call carries every live frame. The
  demo shows `db.query` migrating 1 frame (`render`) and `DOM.renderList`
  migrating 2 frames (`render → show`).
- **Heap model (§5).** Heaps are tier-local. The continuation wire format
  (`waso-heap.mjs`) is an identity-preserving, cycle-safe graph codec: shared
  references stay shared and cycles survive the round trip, while a subgraph
  larger than a threshold becomes an opaque handle into the owning tier's heap
  instead of being copied. Dereferencing a handle on another tier fetches it
  across a channel with a version-invalidated cache (single-writer coherence,
  `waso-fetch.mjs`). `probe-heap.mjs` / `probe-fetch.mjs` exercise these.
- **Migrate-vs-fetch (§6).** At a boundary the runtime can ship the continuation
  *or* fetch the data and stay put. `waso-policy.mjs` prices both with real
  bytes and shows the decision flipping between regimes, degrading to the naive
  "always migrate" when uninformed and improving with measured sizes.

## Files

```
initial-design.md     the design document (the spec)
NOTES-frontend.md     frontend dev log (chronological) + "pick up here" / caveats
app.ts                the demo application, authored as ordinary TypeScript
waso-tsc.mjs          JS-path frontend: full-language TS -> Waso IR, via a ts.Program
                      + type checker; loadModule (1 file) / loadProgram (import graph)
waso-core.mjs         JS-interpreter runtime + language semantics (the substrate)
waso-heap.mjs         identity-preserving, cycle-safe continuation wire codec
waso-compile.mjs      wasm-path frontend: the i32 TS subset -> the wasm IR
waso.wat              the interpreter, as a WebAssembly module (build -> waso.wasm)
build-wasm.mjs        compiles waso.wat -> waso.wasm via wabt
waso-wasm-core.mjs    wasm runtime: instances, capture/restore, heap, policy bits
waso-wasm.mjs         wasm demo, single process (two instances)
waso-wasm-2p-*.mjs    wasm demo, two OS processes (slice crosses a pipe)
waso-spike.mjs        JS demo, single process
waso-2p-*.mjs         JS demo, two OS processes
waso-frame.mjs        length-prefixed framing (JSON header + binary attachment)
waso-policy.mjs       §6 migrate-vs-fetch cost model
test.mjs              runs every demo + suite and asserts the headline claims
conformance.mjs / difftest.mjs / decorators.mjs / multimodule.mjs   the four test suites
```

## What this prototype is not (honest limits)

- **No native wasm stack capture.** By design (§8) — that isn't serializable and
  isn't in browsers. Capture is at the interpreter level, in Waso's own IR.
- **Numeric data in the wasm path.** Flat `i32`s, to keep values trivial in
  linear memory; the TS subset is numbers / number-arrays. No strings, objects,
  or the explicit `shared.*` distributed-object machinery (§5).
- **Fixed working-heap size.** The small heap is bounded; overflowing it traps
  loudly (rather than corrupting), but there's no GC or realloc.
- **Cross-process handle *fetch* — invariant honored, transport not yet wired.**
  Touching a remote §5 handle makes `host.deref` miss, which the interpreter turns
  into a suspension (a deref-miss is an await on the fetch) and re-runs the op once
  the value arrives. Every deref-touching op is **peek-then-deref**, so a miss
  leaves the stack/ip intact and the re-run is correct — verified directly in
  `probe-deref.mjs` (a handle miss mid-op suspends, resumes, and keeps its args).
  The remaining piece is the *live wire transport* that fetches the handle across a
  channel; its cost model is in `waso-policy.mjs`. (This is a real, supported path,
  not a non-goal — only the transport is unbuilt.)
- **No browser; no source maps yet.** Every IR instruction already carries its TS
  position (`describeContinuation`), but portable file/line metadata isn't emitted
  yet (§10.6).
- **Frontend scope.** The frontend *is* now a real `ts.Program` with a type checker,
  and compiles **multi-file programs** (named imports/exports of functions, classes,
  consts). Not yet wired: `export default`, `export *`/re-exports, `import * as M`.
  A handful of intentional, documented behavioural caveats (TDZ non-enforcement;
  dynamic accessor keys; dynamic `new`/`Reflect.construct` on *top-level* classes;
  `emitDecoratorMetadata` across imported type *aliases*) live in
  [`NOTES-frontend.md`](./NOTES-frontend.md) — each affects only buggy or exotic code.

These line up with the design doc's own open questions (§10). The point of the
prototype is the load-bearing claim — small, serializable, migratable
continuations, with placement inferred from resources — and that holds. The
frontend has since grown to cover essentially the whole language plus the
metaprogramming surface and multi-module programs; **`NOTES-frontend.md`** is the
chronological log and the "pick up here" pointer (next: a multi-file, framework-
shaped sample app).
