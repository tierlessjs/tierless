# Architecture

How Tierless is put together and why. For the original vision and the open
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
packages/tierless/  the npm package — what `npm i tierless` delivers
  src/
    transform.cjs   the compiler: plain JS -> serializable state machine (Babel; importable + CLI)
    runtime.mjs     makePump: one tier-agnostic continuation driver, generic over any bundle
    host.mjs        the session host both tiers share; server.mjs/browser.mjs assemble it
                    (attachTierless/serveApp on node, connect/bindActions in the page)
    graph.mjs       identity/cycle-safe graph codec for the wire
    wire-binary.mjs the compact binary wire; wire-delta.mjs the delta wire; content.mjs
    heap.mjs        §5 distributed handle heap; fetch.mjs Heap/Channel/makeHost
    transport.mjs   WebSocket framing + RPC peer (browser-safe)
    api/            the trust boundary — the reference monitor + sidecar transport
    vite.mjs        the Vite plugin ("use tierless" modules -> monitor-backed actions)
    react.mjs       useAction
  bin/              the tierless CLI
packages/create-tierless/  the scaffolder behind `npm create tierless`
test/               the regression runner + all proofs, importing the real package
  probes/           focused single-mechanism proofs
  e2e/              app-shaped end-to-end proofs + the demo apps they drive (Tasks, conduit,
                    the live pages, heap/policy/delta demos, the sample services)
examples/           react-vite — Tierless mixed into an ordinary React app
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
- **content-addresses immutable subgraphs** — a registered immutable subgraph (code,
  class shapes, config) ships inline once and then by content hash, resolving on the
  peer to the copy it cached (`content.mjs`); the same by-reference idea as globals,
  generalized from well-known names to any immutable subgraph;
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
(O(reachable), no cooperation needed) and **write-tracked** marks an object dirty the instant it
is mutated and ships the dirty set directly — O(changed), so warm encode/apply stay flat (~10 µs /
~5 µs) where rescan climbs into the milliseconds as the model grows (`npm run bench:delta`). The
mark is emitted by the **compiler** (`transform.cjs --track-writes`, the symmetric cousin of
`--auto-writeback`): every in-place mutation compiles with its target wrapped in `__dirty(obj)`,
so write-tracking works on **plain unannotated source** — no `touch()` in the developer's code.
Both modes reconstruct identically; the probes cross-check write-tracked against rescan as the
oracle, including end-to-end on compiled plain source (`test/probes/wire-delta{,-compiled}.mjs`).
This runs **live over a real socket** (`test/e2e/delta-live.mjs`): a continuation that bounces
server↔browser each hop ships `min(delta, full)` — the compact full binary frame on the cold hop
(both tiers then `adoptBaseline` to a shared, DFS-deterministic baseline so ids agree), a
write-tracked delta on every warm hop, and a fall back to full + re-adopt if a near-total change
ever makes a delta no smaller. Map and Set are first-class kinds in the delta codec, with identity
preserved across Map keys and Set members. The delta also **composes with §5 excision**
(`encodeDeltaTracked(…, { tier, threshold })`): a big subgraph excises into the owning tier's heap
and the delta carries a handle leaf in its place, so the big data stays home *and* only the changed
UI ships — an 80 KB inline capture becomes 115 B (`test/probes/wire-delta-handle.mjs`).

## The heap (`heap.mjs` + `fetch.mjs`)

The §5 distributed heap is how the big data stays put.

- **Handles.** A big local excises into its owning tier's versioned `Heap` and travels
  as `{ __tierless_handle__, owner, id }`. The other tier fetches it (over the same
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

## The trust boundary (`test/e2e/api/`)

Tierless is a fat web-app *client* that grew too fat for the browser, so it sometimes runs in Node
too. "The client" is therefore two halves — the **browser client** and the **backend client** (what
the rest of these docs call the "server tier") — and the business trusts **neither**. Both are just
relocated app code; a continuation arriving from either is untrusted data that can be forged, replayed,
or mangled, so no authorization, access control, or audit can live inside them.

Authority lives instead in the **api**: a small, stateless **reference monitor** that runs in its own
OS process and mediates every resource call. The three reference-monitor properties map onto the
process boundary directly:

- **complete mediation** — every call goes through one gate (`Api.handle`); there is no side door;
- **tamperproof** — it runs in a separate process, so the untrusted client holds only a pipe to it (a
  `SidecarClient`), never its memory, its signing key, or its registry;
- **verifiable** — it is small, and every path that is not an explicit allow falls through to deny.

The decisive property is that **the monitor never trusts the control flow that reached a call.** A
forged continuation can jump to any `api.*` the app mentions anywhere, so authority is re-checked at
*this* call, for *this* verified principal, every time. From the monitor's side a forged continuation
is indistinguishable from a hostile client invoking the endpoint directly — which is the whole point:
authorizing the *call* rather than validating the *continuation* is what makes it robust. (An earlier
attempt validated the incoming continuation *inside* the server; that was the wrong axis — you cannot
validate your way out of an untrusted process, you move authority into a trusted one.)

**Co-location, not co-trust.** The api boundary is an RPC, but it is implemented as a **local OS pipe**
(a sidecar on the same host), so a chained call costs a cheap same-host hop, not a network round trip.
A browser→api call is "migrate the continuation one socket hop to the backend client, then RPC one pipe
hop to the monitor"; the pipe hop is ~free next to the network hop, so the whole thing still reads as a
single api round trip — the cost a traditional client→server call already pays — with the trust
boundary where it belongs.

**The interface (`packages/tierless/src/api/api.mjs`).** A server-only function is `api.fn(name, { authorize, run })`.
`authorize` is **mandatory**: exposing an endpoint and stating who may call it are the same act, so
omitting it is a **load-time error** (thrown at registration, before the process serves a single call)
— an unauthorized endpoint cannot ship. To mean "anyone" you say so with the `PUBLIC` sentinel; `DENY`
wires an endpoint closed. The framework is *not* prescriptive about the regime: the principal is a
**signed bearer token the client carries and the monitor verifies** — never injected, never a frame
local, so a forged continuation can swap args but cannot forge a valid principal. `JwtApi` ships a
standard HMAC regime (Cognito/OIDC is the same shape with an RS256-over-JWKS `verify`); rolling your
own is just an `Api` subclass overriding `verify`. The base `Api` is a safe floor — it trusts no token,
so without a regime only `PUBLIC` calls pass.

`test/e2e/api-verify.mjs` proves all of this headless (in `npm test`): the load-time mandate, default-deny,
`PUBLIC`/`DENY`, the JWT regime (sign/verify/tamper/expiry), fail-closed authorizers, and roll-your-own
— then, **across a real forked process and pipe**, that neither a forged continuation (reaching an
admin-only call as a non-admin) nor a forged token (a client-flipped `role` claim that breaks the
signature) can escalate. `test/e2e/api-pump.mjs` then runs a **real compiled continuation across two tiers** with every
`api.*` serviced by the monitor over the pipe — authorized per principal, the denial caught by the app's
`try`/`catch` across the tier (same continuation, admin allowed / user denied) — so the *integration* is
proven, not just the component. The monitor also enforces per-call resource budgets (`maxArgsBytes` and
a per-principal rate window).

**The monitor is the DEFAULT `api.*` path.** A Tierless program is untrusted client code — all of it,
on every tier; `api.*` and `dom.*` are edges to resources owned by *other principals* (the api by the
business, guarded by the monitor; the dom by the user, guarded by their browser). The framework is
opinionated about the **contract** at that edge — `{ name, args, token }` in, verified principal,
mandatory `authorize`, default-deny, a denial thrown *into* the continuation so a `try`/`catch`
catches it across tiers (`makeApiExec` in `sidecar.mjs` is that adapter) — and agnostic about the
**transport**: the pipe sidecar is the reference implementation; the same contract over HTTPS to a
separately-deployed monitor is a small adapter. Concretely: the Tasks app's DB and endpoints live in
`test/e2e/api/tasks-fns.mjs`, a separate trusted service the demos fork as a sidecar — the pump host holds
only a pipe client and a per-session token (reads `PUBLIC`, writes re-authorized per call), and the
in-process shortcut is no longer expressible on the live path. `test/e2e/api-live.mjs` proves the default
path in `npm test`: the real compiled App on the runtime's own `pump`, every `api.*` over the pipe,
anonymous `PUBLIC` reads standing while an unauthenticated or forged write is denied in the monitor's
process and thrown across the tier, and the args budget rejecting an oversize call. An in-process
resource host remains available as the labeled **degenerate mode** for single-process mechanics proofs
(`verify.mjs`) and trusted single-tenant deployments — an explicit opt-out, never the default.

## Why the transportable continuation is ours to build

Modern JS has `async`/`await` and generators — native suspension — so why not capture
those? Because native async is **suspend-but-not-serialize**: a paused async or
generator state is engine-internal; you cannot read it out as bytes and ship it to
another process. (Same limitation as the WebAssembly stack-switching proposal — see
design `§8`.) Tierless reuses async *semantics* for the boundary shape (a resource
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
- **`--auto-deref` guards each read, then prunes the redundant ones.** Guarding every read
  is correct, not merely conservative: a round-trip migration can re-excise a big local back
  into a handle, so a read *past a hop* must re-check. A liveness pass keeps the first guard in
  each straight-line run and prunes the rest, re-guarding after any hop (a tier resource or a
  suspendable call) or control-flow join — so correctness is unchanged and the repeated
  re-checks are gone (`test/probes/deref-liveness.mjs`).
- **Write-back is a delta to the master** (`openSnapshot`/`diffSnapshot`/`applySnapshot`): it ships
  only the objects that changed in the snapshot — member edits and collection mutations alike, since
  the codec diffs the result, not the operation — applied in place under the same CAS, never larger than
  the old whole-object form (`min(delta, whole)`). With the codec's `session.fields` mode it ships only
  the changed *slots* of a changed container (an object's changed keys, an array's touched indices, a
  Map/Set's set/deleted entries) — per-field/element, sharpening both write-back and the oscillation
  delta, opt-in and order-preserving. The §6
  fetch-size profile is sampled once and locked in (no online re-profiling, by design).

Broader open questions — broader language coverage and content-addressed code identity
(the binary wire, delta capture, and the trust-boundary reference monitor are done) — are
tracked in [`../ROADMAP.md`](../ROADMAP.md) and line up with the design doc's own open
questions (`§10`).
