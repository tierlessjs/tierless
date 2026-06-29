# Architecture

How Stackmix is put together and why. For the original vision and the open
research questions, see [`design.md`](./design.md) (the spec).

## The model in one paragraph

You write one program in ordinary JavaScript. You do **not** annotate which parts
run on the browser and which on the server. Instead, placement is *inferred* from
the resources each call touches — `api.*` forces the server, `commit()`/`dom.*`
force the browser. When execution reaches a resource the current tier doesn't have,
the runtime captures the live continuation (the call stack, as plain serializable
data), ships it over a WebSocket to the tier that does have the resource, and
resumes it there. The big data stays where it lives; only the small continuation
moves.

## Repository layout

```
src/                the framework
  transform.cjs     the compiler: plain JS -> serializable state machine (Babel)
  runtime.mjs       the pump — one tier-agnostic continuation driver + the wire envelope
  graph.mjs         identity/cycle-safe graph codec for the wire
  heap.mjs          §5 distributed handle heap: encodeWire, makeTier, write-back CAS
  fetch.mjs         Heap / Channel / makeHost — fetch-on-deref with coherence
  transport.mjs     WebSocket framing + RPC peer (browser-safe)
  app/              the demo app (plain components -> serializable vdom)
  public/           the browser tier (runs in a real tab)
  *.mjs             the demos and headless proofs (also the regression suite)
test/               the regression runner + the wire-codec probe
docs/               this document, the design spec
```

## How a function becomes migratable

`transform.cjs` is a Babel transform that runs in two passes.

1. **Allow-list rewrite.** A call to a tier-pinned namespace becomes a suspension:
   `api.getRows(x)` → `yield R("server", "api.getRows", x)`, `commit(v)` →
   `yield R("browser", "dom.commit", v)`. The allow-list (`TIER_OF`) is the only
   place tier identity is declared; everything else is inferred.
2. **State-machine lowering.** A function that (transitively) touches a resource is
   **suspendable** and is compiled into a `while (true) switch (F.pc) { … }` machine:
   control flow becomes `pc` transitions, and every local is hoisted onto an explicit
   frame object `F` (`F.x`, not a closed-over `x`). Suspensions in expression
   positions are first hoisted into frame temps (an ANF normalize pass), and loops,
   `switch`, labeled `break`/`continue`, and `try`/`catch`/`finally` (including
   `return`/`break`/`continue` *across* a `finally`) all lower to serializable form.
   A function that touches no resource is **pure** and is emitted verbatim, called
   inline like any ordinary function.

Because the continuation is just `F` (a plain object: `fn`, `pc`, and named locals)
plus the small call stack of such frames, it is plain JSON — there is no native
stack frame and no closure to capture.

## The pump (`runtime.mjs`)

One tier-agnostic driver runs the continuation on whichever tier holds it:

```
pump(stack, ownsHere, execHere, incoming?):
  step the top frame's machine; on a result:
    return  -> pop the frame (or finish)
    call    -> push a sub-frame (the continuation spans call boundaries)
    resource this tier owns      -> run it inline, feed the value back
    resource this tier does NOT  -> stop, hand back { stack, request } to ship
```

The same `pump` runs on both tiers; only `ownsHere`/`execHere` differ. A continuation
therefore flows back and forth across the socket, finishing wherever the last
resource lands. Exceptions propagate across frames via a serializable handler stack,
so a resource that throws on one tier is caught by a `try` on the other.

## The wire (`graph.mjs` + `wire-binary.mjs`)

What crosses the socket is an envelope — `{ frames, req, graph }` — where `frames`
is the call-stack skeleton (`fn`, `pc`, which locals, where they start in the graph),
`req` is the resource boundary it suspended at (name + tier + already-evaluated
args), and `graph` is the object graph the locals point into.

`encodeGraph` walks every value reachable from the roots and emits a flat table where
each distinct object is one entry and every reference is `{k:"r", id}`. That:

- **preserves identity** — a shared object is one entry, referenced by id from
  everywhere; it does not split into copies;
- **survives cycles** — an object's id is reserved before its fields recurse, and
  `decodeGraph` pre-creates every object before filling it, so back-edges resolve;
- **keeps continuations small** — a subgraph larger than `threshold` becomes a §5
  *handle* into the owning tier's heap (a leaf — it stays tier-local) instead of being
  copied;
- carries the non-JSON cases faithfully (`undefined`, BigInt, symbols, Map/Set,
  non-enumerable + symbol-keyed props) and ships host globals and well-known symbols
  by reference rather than copying them.

That `{ frames, req, graph }` structure is serialized for the socket by the **binary wire
codec** (`wire-binary.mjs`): 1-byte type tags + LEB128 varints replace the `{k,id}` ref
objects, a **string table** interns every key and value, a **shape table** lets same-shaped
records emit their keys once, and homogeneous numeric arrays pack with no per-element tag —
1.9×–5.4× smaller than the JSON form on record-heavy payloads. This is what crosses the
socket (one binary `ws` frame); the JSON form (`encodeWire`) is kept only as a readable
debug serialization. Because the wire is deserialized from the *other* tier (§7), the
decoder is hardened (bounds-checked, count-guarded, `__proto__`-stripping) and fuzz-tested.

For the **oscillation case** — a session that crosses the boundary many times, re-shipping a
near-identical continuation each hop — `wire-delta.mjs` ships a capture as a *patch* over what
the peer already holds: each tier keeps a replicated, stably-identified object store, and only
the changed objects travel (a deep edit bumps just its own object, not its ancestors, because
content versions are shallow — children by id). The strategy is `min(delta, full wire)` per
message (the §6 cost decision), so the cold first hop falls back to the full frame and the wire
is never worse than full; warm hops ship a flat ~175 B regardless of model size. *Finding* the
change has two modes over the same wire: **rescan** re-hashes the reachable graph each capture
(O(reachable), no cooperation needed) and **write-tracked** marks an object dirty when it is
mutated (`touch()`, the same hook `--auto-writeback` emits) and ships the dirty set directly —
O(changed), so warm encode/apply stay flat (~10 µs / ~5 µs) where rescan climbs into the
milliseconds as the model grows (`npm run bench:delta`). Both reconstruct identically (the probe
cross-checks write-tracked against rescan as the oracle). It is a proven codec
(`test/probes/wire-delta.mjs`), the next optimization to fold into the live pump.

## The heap (`heap.mjs` + `fetch.mjs`)

The §5 distributed heap is how the big data stays put.

- **Handles.** A big local excises into its owning tier's versioned `Heap` and travels
  as `{ __stackmix_handle__, owner, id }`. The other tier fetches it (over the same
  socket) only if it dereferences the handle.
- **Read coherence (single-master).** The owner is the master and bumps a version on
  mutation; a reader caches fetched snapshots keyed by version and re-fetches when the
  master moves. With `--auto-deref` the compiler guards each read of a data-resource
  local so the first touch fetches transparently.
- **Write coherence (optimistic CAS).** A reader that mutates a fetched snapshot
  proposes it back to the master under the version it read (`writeBack`); the master
  accepts only if no one bumped it in between, else the writer refetches and retries —
  no lost updates. With `--auto-writeback` the compiler emits that propagation after
  each member mutation through a data-resource local.
- **Placement (§6).** At a pure-data boundary the driver can either ship the
  continuation to the data (migrate) or pull the data back and stay put (fetch),
  priced from real measured bytes — cheaper side wins, cold defaults to migrate.

## Why the transportable continuation is ours to build

Modern JS has `async`/`await` and generators — native suspension — so why not capture
those? Because native async is **suspend-but-not-serialize**: a paused async or
generator state is engine-internal; you cannot read it out as bytes and ship it to
another process. (Same limitation as the WebAssembly stack-switching proposal — see
design `§8`.) Stackmix reuses async *semantics* for the boundary shape (a resource
access is a suspension), but the *transportable* continuation is its own data
structure — a plain frame object the compiler produces — so the prototype depends on
no unreleased platform feature.

## Known limitations and intentional caveats

These are deliberate trade-offs in the compiler, not accidental gaps:

- **Source is a plain function.** `async`/generator *source* is intentionally
  unsupported — tier calls suspend implicitly, so the developer never writes `await`.
- **Suspension in an optional-chain conditional.** `obj?.m(api.x())` /
  `a?.[api.x()]` throws a clear compile error; lift it to a statement (the suspendable
  *base*, `api.get()?.x`, is fine).
- **`--auto-deref` guards every read.** This is correct, not merely conservative: a
  round-trip migration can re-excise a big local back into a handle, so each read must
  re-check. A liveness pass could prune guards provably dominated by an earlier one
  with no intervening suspension.
- **Write-back ships the whole edited object**, not a field-level diff; the §6
  fetch-size profile is sampled once and locked in (no online re-profiling, by design).

Broader open questions — broader language coverage, the trust boundary, and
content-addressed code identity (the binary wire and delta capture are done) — are
tracked in [`../ROADMAP.md`](../ROADMAP.md) and line up with the design doc's own open
questions (`§10`).
