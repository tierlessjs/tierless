# Roadmap

Stackmix is a research-stage framework. The load-bearing claim — small,
serializable, migratable continuations with placement inferred from resources —
is proven (see the [README](./README.md) and `npm test`). What follows is where
it goes next. Items are grouped, not strictly ordered; see
[`docs/design.md`](./docs/design.md) `§10` for the original open questions.

## Wire format

- **Binary wire format — done (`packages/stackmix/src/wire-binary.mjs`).** 1-byte type tags + LEB128
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
- **Incremental / delta capture — done (`packages/stackmix/src/wire-delta.mjs`).** The oscillation case
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
- **Live pump — done (`demos/delta-live.mjs`).** The whole pipeline now runs over a real websocket: the
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
  frame, and `adoptBaseline` substitutes too, so ids stay consistent across a full↔delta switch. `demos/delta-live.mjs`
  now runs the **whole composition over a real socket** — a continuation bounces server↔browser carrying a 124 KB
  catalog that excises to a §5 handle (4.9 KB total wire vs 124 KB inline), ships `min(delta, full)` each crossing,
  and the browser derefs the catalog over the same socket — all on plain `--track-writes` source, in `npm test`.
- **Content-addressed subgraphs — done (`packages/stackmix/src/content.mjs`).** Some subgraphs are immutable — code,
  class shapes, config — so they need not travel as bytes more than once. The producer registers an
  immutable root (naming it by a content hash); the codec ships it inline the first time and ships just
  the hash on every later hop, and the receiver resolves the hash to the copy it cached — identity by
  content. It generalizes how globals already travel (a `Math` ships by name, never copied) from
  well-known names to any immutable subgraph, and is the known fix for resume identity under version
  skew between tiers (Unison's approach). `test/probes/wire-content.mjs`: a 36 KB config ships inline
  once then as a 319 B hash reference (**113×**), resolves to the same held instance across hops,
  preserves shared identity, and leaves the rest of the codec untouched (an unregistered cyclic object
  still round-trips). It is now carried through **the binary wire** (the frame that actually crosses the
  socket — two new slot tags: a content-ref leaf and a content-cache wrapper, both hardened and
  fuzz-tested) and **composes with the delta**: content rides the `min(delta, full)` FULL arm, so a
  re-frame ships an immutable subgraph by hash instead of re-inlining it (10.5 KB → 124 B in
  `wire-content`, composed with §5 excision in the same capture), while warm deltas already clean-prune
  it. Both arms stay id-consistent because neither `subForFullWire` nor `adoptBaseline` collapses the
  subgraph to a leaf — they walk it in full, exactly as the receiver does after resolving the hash.

## Compiler & language

- **`--auto-deref` liveness pass — done.** A read of a data-resource local is guarded so the first
  touch fetches it; once materialized it stays a plain object until a tier hop can re-excise it. The
  transform now prunes guards dominated by an earlier guard within a straight-line run with no hop
  between (a `yield` *or* a suspendable call), re-guarding after any hop or control-flow join. Exactly
  correct — `heap-auto`/`heap-write` are the runtime backstop, and `test/probes/deref-liveness.mjs` pins
  the guard count on the shapes that matter (consecutive reads → one guard; a re-guard after a
  commit/suspendable-call/branch; a pure call doesn't break a run). On `heap-write` it drops a redundant
  guard.
- **Broader language coverage in the transform — landed (`test/probes/lang-coverage.mjs`).**
  The suspendable path covers all ordinary control flow with suspensions in any position, and now the
  ordinary *binding* forms too: `for`/`of`/`in`, destructuring declarations (object/array/nested/default/
  rest, with a non-array iterable normalized via an `Array.isArray(x) ? x : Array.from(x)` guard — zero
  copy for a real array), default/destructured/rest parameters, and a suspension in an **optional-chain
  conditional** (`obj?.[api.x()]` / `obj?.(api.x())` / `obj.m?.(api.x())`). The optional chain is peeled
  into an explicit `== null` guard + temp (Babel's optional-chaining lowering, emitted as statements so
  the suspension hoists into the non-short-circuit branch), so the tier call is skipped on short-circuit
  and `this` is preserved — checked against a native-JS oracle for both value and call sequence. Each
  form is desugared to plain frame writes before lowering and proven to migrate across a JSON round-trip
  at every suspension. The one form that genuinely *can't* migrate is now rejected with a clear compile
  error instead of a silent miscompile: a tier call inside a nested function / callback / comparator /
  method (invoked synchronously by native code — `Array.map`/`sort`, a method dispatch — that can't
  suspend; lift it to a loop).
- **Write-back IS a delta — landed (`openSnapshot`/`diffSnapshot`/`applySnapshot`).** A write-back and
  the oscillation delta were the same operation wearing two hats — *ship the objects that changed to a
  holder of the prior version, applied in place.* So `--auto-writeback` no longer ships the whole edited
  snapshot; the host baselines a snapshot on fetch and, on write-back, ships only the changed objects
  (the §5 master is just another replica), applied in place under the same CAS. Because the codec is
  content-based — it diffs the *result*, not the operation — **collections fall out for free**: a member
  edit, an array push, a `Map.set`, a `Set.add` are all handled, only the changed containers crossing.
  The host ships `min(delta, whole)`, so it is **never larger** than the old whole-object write-back.
  `demos/heap-write-delta.mjs` measures it: member edits in a 1500-row dataset cross at **96×** smaller and
  collection mutations at **94×** (per the finer mode below), and the near-total case falls back to whole.
- **Per-field/element granularity — done (`session.fields`).** The delta now ships a changed container's
  changed *slots*, not the whole thing: an object's changed keys (+ deletes), an array's touched indices
  + length (a `push` is `splice(len-1, 0, [x])`), a Map's set/deleted entries, a Set's added/removed
  members. Per-object min (the patch is taken only when it touches fewer slots than the whole), backed by
  the message-level `min(delta, full)` for "never larger". It lives in the **shared codec**, so it sharpens
  **both** write-back (the array push that was 12.7 KB is now 738 B) and the oscillation delta (a push in
  an 800-element array crosses **113×** smaller). Opt-in — with it off the wire is byte-for-byte unchanged,
  and insertion order is preserved (a reorder that a patch can't reproduce falls back to the whole
  container). `test/probes/wire-delta-fields.mjs` proves all four kinds both directions of an oscillation;
  `wire-delta-fuzz` round-trips fields-mode over random mutating graphs and fuzzes the new patch tags.
- **Source maps — done (`transform.cjs --source-map`).** The transform stamps each block with the
  line of the statement it lowered and emits a per-program `pc`->line table plus a `frameSite` /
  `stackSites` helper, so a migrated continuation reports a portable `file:line`, not just a `pc`.
  Gated behind the flag, so a bundle built without it is byte-for-byte unchanged.
  `test/probes/source-maps.mjs` drives a continuation to each suspension and asserts the parked frame
  maps to the suspending statement's line (and that the off path is byte-identical).

## Ergonomics

- **Mix-in DX — landed.** The framework is an npm package with a real surface (`stackmix`,
  `/api`, `/server`, `/browser`, `/react`, `/vite`, `/compiler`; the Babel toolchain is a real
  dependency; `bin: stackmix`). The copy-pasted pump/wire/peer loops collapsed into a session
  host (`makeHost`, `attachStackmix` — mountable on any http server — `serveApp`, `connect`),
  which is also what enables **actions**: a `"use mix"` module's exported functions become
  plain calls from an existing app that run as migratable continuations — the api-heavy
  stretch executing on the server in one round trip through the reference monitor
  (`stackmix/vite` + `useAction`; `examples/react-vite` is the proof, validated with a real
  `vite build` and a Chromium-clicked `vite dev` run). The allow-list is configurable
  (`--resource=ns:tier` / opts.resources), a service is one `defineApi` literal +
  `sidecarMain` tail call, `npm create stackmix` scaffolds a working two-tier app (proven by
  a probe that builds, boots, and drives it), and `stackmix explain` makes the compiler's
  suspendability analysis inspectable. Remaining ergonomics threads: a production build story
  for the Vite plugin (today: dev-first; mount `attachStackmix` yourself with the built
  module), TypeScript sources for mix modules, and richer generated types than
  `(...args: any[]) => any`.

## Runtime & framework shape

- **Event-dispatch model.** The live page parks the whole continuation on one human
  click — right for "this flow needs the other tier," but a page with several
  independent event sources (a click here, a server push there) needs the next event
  routed to the right resumable point. This is an application-level concern (React
  already answers it without continuations); the framework's job is only to let a
  continuation suspend at a boundary, which it does.
- **A larger, framework-shaped sample app — done (`demos/conduit/`).** A RealWorld/Conduit reader
  written as ONE tier-fluid program: a routing loop across three views (home feed ↔ article page ↔
  editor) with tag filtering, favorites, comments, a new-article form, and a publish that validates
  on the server and is caught by a `try`/`catch` in the app across the tier boundary. It runs as one
  compiled continuation — `demos/conduit-verify.mjs` drives an eleven-step user journey headlessly and
  asserts the rendered state at each `commit` (in `npm test`). Writing it shook out a real compiler
  bug exactly as intended: a suspendable call on an assignment RHS in an UNBRACED `if`-branch
  (`if (route === "home") vdom = loadHome(tag);`) had its hoisted temp land *before* the `if`, so it
  ran unconditionally. Fixed in `transform.cjs` (normalize now blockifies a branch/loop-body when its
  suspension will be hoisted, gated so head-normal statements and Tasks-style code are untouched —
  every existing bundle regenerates byte-identical) and locked with two focused cases in
  `control-flow.mjs` that throw if it regresses.

## Security & the trust boundary

- **The api as an external reference monitor — landed (`demos/api/`).** The right axis: Stackmix's
  client is a fat web app that sometimes runs in Node, so BOTH halves — the browser client and the
  backend client (the "server" tier) — are untrusted. Authority therefore lives outside them, in the
  **api**: a small, stateless reference monitor in its own OS process, reached over a local pipe
  (sidecar) so a chained call stays a cheap same-host hop rather than a network round trip. It never
  trusts the control flow that reached a call — a forged continuation can jump anywhere, so every call
  is re-authorized against a freshly-verified principal. The interface is `api.fn(name, { authorize,
  run })` with **authorize mandatory at load time** (exposure and authorization are one act; `PUBLIC`
  and `DENY` are the explicit sentinels), and the principal is a **signed bearer token the monitor
  verifies** (`JwtApi` for the standard HMAC regime; any `Api` subclass for your own). Default-deny is
  the floor. `demos/api-verify.mjs` proves it end to end (in `npm test`), including — across a real
  forked process and pipe — that neither a forged continuation (an admin-only call reached as a
  non-admin) nor a forged token (a client-flipped `role` claim that breaks the signature) can escalate
  (design `§7`). This corrects an earlier false start that validated the incoming continuation *inside*
  the untrusted server — the wrong side of the boundary.
- **Pump integration — landed (`demos/api-pump.mjs`), with per-call budgets.** A real compiled
  continuation migrates across two tiers with every `api.*` serviced by the monitor over the pipe,
  authorized per principal, and the denial caught by the app's `try`/`catch` across the tier — the
  integration, not just the component. Same continuation, admin allowed / user denied / anonymous can't
  start. The monitor now also enforces per-call resource budgets (`maxArgsBytes`) and a per-principal
  rate window.
- **The monitor as the DEFAULT `api.*` path — landed (`demos/api-live.mjs`, `demos/api/tasks-fns.mjs`).**
  The model, stated plainly: a Stackmix program is untrusted client code — all of it, on every tier —
  and `api.*`/`dom.*` are edges to resources owned by other principals. The framework is opinionated
  about the *contract* at the api edge (`{ name, args, token }`, verified principal, mandatory
  `authorize`, default-deny, a denial thrown into the continuation and catchable across tiers —
  `makeApiExec` in `sidecar.mjs`) and agnostic about the *transport* (the pipe sidecar is the reference;
  the same contract over a network is a small adapter). Concretely, the Tasks app's DB moved out of the
  client's directory into its own trusted service (`tasks-fns.mjs`: reads `PUBLIC`, writes
  per-principal with args validated, budgets on) which `server-live.mjs` and `demo.mjs` now fork as a
  sidecar — the pump host holds only a pipe client and a per-session token, so the in-process shortcut
  is no longer expressible on the live path. `api-live.mjs` proves it in `npm test` on the runtime's own
  `pump`: the full journey through the monitor, anonymous `PUBLIC` reads standing, an unauthenticated or
  forged write denied in the monitor's process and thrown across the tier, an oversize call rejected by
  the args budget. In-process hosting remains the labeled degenerate mode for mechanics proofs
  (`verify.mjs`) and trusted single-tenant tools.

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
