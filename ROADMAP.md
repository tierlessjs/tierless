# Roadmap

Stackmix is a research-stage framework. The load-bearing claim — small,
serializable, migratable continuations with placement inferred from resources —
is proven (see the [README](./README.md) and `npm test`). What follows is where
it goes next. Items are grouped, not strictly ordered; see
[`docs/design.md`](./docs/design.md) `§10` for the original open questions.

## Wire format

- **Binary wire format — done (`src/wire-binary.mjs`).** 1-byte type tags + LEB128
  varints (instead of `{"k":"r","id":N}`), a **string-intern table**, a **shape table**
  so same-shaped records emit their keys once, and a **typed-array fast path** (homogeneous
  numeric arrays pack with no per-element tag — varint deltas or `Float64`, ~18× on an int
  column). It decodes identically to the JSON form — identity, cycles, non-enumerable +
  symbol-keyed props, Map/Set, BigInt, §5 handles all survive — at **1.9×–5.4×** smaller on
  record-heavy payloads (`npm run bench:wire`). The decoder is **hardened** (bounds-checked
  reads, length-capped varints, count guards, `__proto__` stripping) and **fuzz-tested**
  (`test/probes/wire-fuzz.mjs`: property round-trips, a differential against JSON, boundary
  tables, and truncated/corrupted/hostile-byte robustness) — it must not crash, hang, or
  pollute on input from the other tier (§7). **It is now THE wire** — every socket-crossing
  demo (heap-live, policy-live, demo, the live page) ships the continuation as the binary
  frame, and the §6 policy prices the real binary bytes; `encodeWire` (JSON) is kept only as
  a readable debug serialization. The remaining wire-adjacent work is below: delta capture
  and content-addressing.
- **Typed-array fast path.** A homogeneous numeric array currently spends ~12 bytes
  per element on `{"k":"p","v":n}`; pack it as a base64 `Float64Array` (or varint
  deltas).
- **Incremental / delta capture — done (`src/wire-delta.mjs`).** The oscillation case
  (a session that crosses many times) re-ships a near-identical continuation each hop.
  Each tier keeps a replicated, stably-identified object store; a capture ships only the
  objects whose **shallow content version** changed (children referenced by id, so a deep
  edit bumps only its own object, not the spine to the root), and the peer mutates its
  store in place. Baseline = what the peer already holds (the last exchange); the **return
  hop of a bounce is itself a delta** (the receiver records the versions it now holds). The
  optimal strategy is `min(delta, full wire)` per message — the §6 cost decision — so the
  cold first hop falls back to the full binary wire and the wire is **never worse than full**.
  Over a 12-hop oscillation a warm hop ships a flat ~175 B regardless of feed size while the
  full wire scales with the model: **77–91 %** fewer session bytes, the win growing with size
  (`npm run bench:delta`). It is also a CPU **wash-to-win** warm (~0.73× a full encode — it
  walks the graph to diff but skips serializing the unchanged bulk) and strictly more work
  cold (the other reason cold falls back). Fidelity (identity, cycles, undefined/BigInt, §5
  handles), locality, the bounce, and the floor are proven in `test/probes/wire-delta.mjs`.
- **Bump version on write — done (`encodeDeltaTracked`).** The rescan encoder above costs
  O(reachable): it re-hashes the whole graph each capture to find the change. The write-tracked
  encoder instead marks an object dirty the instant it is mutated (`touch()` — the version bump,
  the same hook `--auto-writeback` already emits after a member write), then ships the dirty set
  directly, plus any newly-reachable object (a walk that PRUNES at clean, already-shipped objects).
  The receiver's apply writes only the shipped objects. Same wire, same store, **identical
  reconstruction** as rescan — proven by cross-checking against rescan as the oracle every hop in
  `test/probes/wire-delta.mjs`. Cost drops to **O(changed)** on both ends: warm encode and apply
  stay flat (~10 µs / ~5 µs) as the model grows from 50 to 3200 records, where rescan climbs to
  ~5 ms / ~4.6 ms — **~490× / ~850×** at 3200 (`npm run bench:delta`). It is exact only if every
  mutation bumps — the guarantee a compiler write-barrier provides; rescan stays the safe fallback
  when the caller can't cooperate.
- **Compiler write-barrier — done (`transform.cjs --track-writes`).** The bump is now emitted by the
  compiler, so write-tracking works on **plain, unannotated source** — no `touch()` in the developer's
  code. Each in-place mutation (`o.x = v` / `o[i] = v` / `o.x++` / the in-place array mutators) compiles
  with its target object wrapped in `__dirty(obj)`, a helper that reports the object to the active delta
  session and returns it (single-eval, no suspension — a local Set add, not a tier hop). It is scoped to
  chains rooted at a frame local/param (continuation state, never a global/import). `test/probes/wire-delta-compiled.mjs`
  compiles an oscillating sample and drives it: the compiler-tracked delta matches the rescan oracle every
  hop (same ship count, identical reconstruction) and reconstructs the live continuation exactly, with a
  control proving the barrier is load-bearing (uninstall the sink and an in-place edit goes unshipped).
  Untracked output is byte-identical (verified against the committed bundles), so the flag is zero-cost
  when off. **Map and Set are first-class** in the delta codec (identity/cycles preserved across Map keys
  and Set members) and the compiler instruments their mutators (`set`/`add`/`delete`/`clear`) alongside
  the array ones; a custom method that mutates without one of those names isn't seen and that continuation
  falls back to rescan. The reachability tradeoff is **measured, not asserted** (`npm run bench:delta`):
  write-tracking is O(changed) and can't cheaply prove reachability, so a mutate-then-orphan in one run
  ships the orphan once as a stray (bounded to one hop, never a wrong reconstruction). The bench runs a
  mean workload (realistic oscillation) and an extreme one (orphan every hop) against an exact O(reachable)
  variant: under the mean workload the orphan count is **zero**, where exact only adds ~5.8× encode time
  for no benefit — so pruned O(changed) is the tuned default; `encodeDeltaTracked(…, { exact: true })` is
  the knob for an adversarial workload (~85 B/hop of strays traded for the walk). Both the stray-correctness
  and the exact knob are proven in `test/probes/wire-delta.mjs`.
- **Live pump — done (`src/delta-live.mjs`).** The whole pipeline now runs over a real websocket: the
  compiler's `__dirty` barriers feed a per-tier delta session through an installed sink, and a continuation
  that bounces server↔browser every hop (`api.poll` + `commit`) ships **`min(delta, full)`** on each crossing
  — the compact full binary wire on the cold first hop (then both tiers `adoptBaseline` to a shared, DFS-
  deterministic baseline so ids agree), a write-tracked delta on every warm hop, and an automatic fall back
  to a full frame + re-`adoptBaseline` if a near-total change ever makes a delta no smaller. In the demo the
  continuation crosses 28× shipping 27 deltas + 1 full, 37 % under re-shipping the full frame each hop on a
  small model (the bench shows 77–91 % at scale), and the session computes the right result. It is wired into
  `npm test`.
- **§5 excision inside the delta path — done (`encodeDeltaTracked(…, { tier, threshold })`).** The framework's
  two wire moves now compose: "ship only the small continuation" (the delta) and "big data stays home" (the §5
  handle). When a capture is given a tier, a big NEW subgraph excises into that tier's heap and the delta carries
  a stable handle leaf in its place (`session.handleOf` maps it once and reuses it, so it never re-ships), while
  only the UI changes ride each hop. `test/probes/wire-delta-handle.mjs`: a continuation with a 2000-row dataset
  + a small UI ships an **80 KB inline capture as 115 B** (the dataset became a handle), preserves shared
  identity (two aliases → one handle), resolves on deref from the owning heap, keeps the warm deltas tiny and flat
  over an oscillation (the handle is never re-shipped), and survives a bounce with the data still home. Excision
  also composes with the `min(delta, full)` **full-binary path**: `exciseForCapture` runs first so both paths excise
  the same objects to the same handles, `subForFullWire` rebuilds the small spine with handle leaves for the full
  frame, and `adoptBaseline` substitutes too, so ids stay consistent across a full↔delta switch. `src/delta-live.mjs`
  now runs the **whole composition over a real socket** — a continuation bounces server↔browser carrying a 124 KB
  catalog that excises to a §5 handle (4.9 KB total wire vs 124 KB inline), ships `min(delta, full)` each crossing,
  and the browser derefs the catalog over the same socket — all on plain `--track-writes` source, in `npm test`.
- **Content-addressed subgraphs.** Hash immutable subgraphs (code, class shapes,
  config); if the peer has the hash, ship the hash, not the bytes. Globals already
  travel by reference; this generalizes it, and it is the known fix for resume
  identity under version skew between tiers (Unison's approach).

## Compiler & language

- **Broader language coverage in the transform.** The suspendable path covers all
  ordinary control flow with suspensions in any position. Natural extensions:
  suspensions inside an optional-chain conditional (currently a clear error), and a
  liveness pass to prune `--auto-deref` guards that are provably dominated by an
  earlier guard with no intervening suspension.
- **Field-level write-back.** `--auto-writeback` ships the whole edited object;
  tracking the mutated path would let it propagate a diff under the same CAS.
- **Source maps.** Carry each frame's source position through the transform so a
  migrated continuation can report a portable file/line, not just a `pc`.

## Runtime & framework shape

- **Event-dispatch model.** The live page parks the whole continuation on one human
  click — right for "this flow needs the other tier," but a page with several
  independent event sources (a click here, a server push there) needs the next event
  routed to the right resumable point. This is an application-level concern (React
  already answers it without continuations); the framework's job is only to let a
  continuation suspend at a boundary, which it does.
- **A larger, framework-shaped sample app — done (`src/conduit/`).** A RealWorld/Conduit reader
  written as ONE tier-fluid program: a routing loop across three views (home feed ↔ article page ↔
  editor) with tag filtering, favorites, comments, a new-article form, and a publish that validates
  on the server and is caught by a `try`/`catch` in the app across the tier boundary. It runs as one
  compiled continuation — `src/conduit-verify.mjs` drives an eleven-step user journey headlessly and
  asserts the rendered state at each `commit` (in `npm test`). Writing it shook out a real compiler
  bug exactly as intended: a suspendable call on an assignment RHS in an UNBRACED `if`-branch
  (`if (route === "home") vdom = loadHome(tag);`) had its hoisted temp land *before* the `if`, so it
  ran unconditionally. Fixed in `transform.cjs` (normalize now blockifies a branch/loop-body when its
  suspension will be hoisted, gated so head-normal statements and Tasks-style code are untouched —
  every existing bundle regenerates byte-identical) and locked with two focused cases in
  `control-flow.mjs` that throw if it regresses.

## Security & the trust boundary

- **The api as an external reference monitor — landed (`src/api/`).** The right axis: Stackmix's
  client is a fat web app that sometimes runs in Node, so BOTH halves — the browser client and the
  backend client (the "server" tier) — are untrusted. Authority therefore lives outside them, in the
  **api**: a small, stateless reference monitor in its own OS process, reached over a local pipe
  (sidecar) so a chained call stays a cheap same-host hop rather than a network round trip. It never
  trusts the control flow that reached a call — a forged continuation can jump anywhere, so every call
  is re-authorized against a freshly-verified principal. The interface is `api.fn(name, { authorize,
  run })` with **authorize mandatory at load time** (exposure and authorization are one act; `PUBLIC`
  and `DENY` are the explicit sentinels), and the principal is a **signed bearer token the monitor
  verifies** (`JwtApi` for the standard HMAC regime; any `Api` subclass for your own). Default-deny is
  the floor. `src/api-verify.mjs` proves it end to end (in `npm test`), including — across a real
  forked process and pipe — that neither a forged continuation (an admin-only call reached as a
  non-admin) nor a forged token (a client-flipped `role` claim that breaks the signature) can escalate
  (design `§7`). This corrects an earlier false start that validated the incoming continuation *inside*
  the untrusted server — the wrong side of the boundary.
- **Pump integration — landed (`src/api-pump.mjs`), with per-call budgets.** A real compiled
  continuation migrates across two tiers with every `api.*` serviced by the monitor over the pipe,
  authorized per principal, and the denial caught by the app's `try`/`catch` across the tier — the
  integration, not just the component. Same continuation, admin allowed / user denied / anonymous can't
  start. The monitor now also enforces per-call resource budgets (`maxArgsBytes`) and a per-principal
  rate window. **Still open:** make the sidecar the *default* in the other live demos and the runtime
  pump (they still wire in-process `api.*` handlers), and size/rate limits tuned for production past the
  wire decoder's existing guards.

## Not on the roadmap (by design)

- **Per-component continuation identity / render-splitting.** Considered and
  retracted: the framework is general-purpose and React runs *inside* it as ordinary
  code, so the framework must not know about components. Finer granularity also adds
  tier crossings (worse in the latency-dominated common case) and buys no parallelism
  (one event loop per tier; a migrating continuation is a single sequential thread,
  merely relocated). The coarse unit — migrate the whole continuation, cross only when
  forced — is the right one.
- **Native engine stack capture** (async/generator or WASM stack-switching state) —
  suspend-but-not-serialize, so it can't move a live computation across a process
  (design `§8`). The transportable continuation stays the compiler's own data
  structure.
