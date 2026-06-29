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
  Next lever: track dirty objects at mutation time (the §5 heap already bumps a version on
  write) to avoid re-hashing the whole graph each capture.
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
- **A larger, framework-shaped sample app** to shake out what real app code hits now
  that the control-flow and heap stories are complete.

## Security & the trust boundary

- **Mediated migration toward authority.** The server must never execute
  client-originated code as server code; an incoming continuation is untrusted data,
  and the server runs *its own* resource handlers over it. The allow-list is partly
  this safety mechanism (the browser tier is instantiated without server
  capabilities). Hardening this boundary is prerequisite to running across a real
  trust boundary in production (design `§7`).

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
