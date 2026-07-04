# Tierless — Design Document

**One line:** Write one program that runs across client and server as a single stateful application; the runtime moves execution between tiers as needed instead of making you split it by hand.

> **Orientation.** This is the design rationale — the "why" behind the choices in
> [`architecture.md`](./architecture.md), which describes what actually shipped. What's
> still open is tracked in [`../ROADMAP.md`](../ROADMAP.md), not here.

---

## 1. The idea

Today you write web apps as two programs pretending to be one. UI code lives on the client, data/secret/orchestration code lives on the server, and a whole layer of machinery — REST endpoints, GraphQL schemas, RPC, loaders — exists mostly to paper over the seam between them. The tier split has been internalized as a *design virtue* ("be explicit about where code runs"), but it's really a workaround for not having a better abstraction.

Tierless treats the application as **one stateful program with access to both client and server resources**. You write business logic and presentation logic together. When execution touches a resource that only exists on one tier — the DOM on the client, the database on the server — the runtime ensures execution is on the correct side, migrating the live continuation across the wire if necessary.

This is *tierless programming* (cf. Eliom, Links, Ur/Web) but with two distinctive bets that no existing system combines:

1. **Placement is inferred from resource dependencies, not declared.** You don't annotate `"use server"`. Touching `db.query` implies server; touching `document` implies client. The resource you reference determines the tier.
2. **Execution migrates as a live continuation.** When you cross a tier boundary mid-computation, the runtime serializes the (small) execution state and resumes on the other side — rather than forcing you to restructure the crossing as an RPC call.

Existing frameworks aren't replaced by this — they run *inside* it, unmodified. React already
serializes its work down to DOM operations and doesn't know or care what tier it's on; when it
hits a DOM call it doesn't have, that's an ordinary resource boundary and the continuation
migrates. You take an existing app, draw a boundary around a portion that's safe to run on
either side, and let that portion become tier-fluid — the rest stays as-is.

---

## 2. Why this is worth building (and where it isn't)

The mainstream (React Server Components, Qwik) deliberately retreated from both of Tierless's bets: they split statically, declare placement with directives, and cross via RPC, never migrating a live continuation. They did this to avoid two real problems (chattiness and the trust boundary — see §7). So the honest framing is: Tierless occupies a genuinely unexplored point in the design space, and the reasons others avoided it are the exact problems Tierless's design must answer, not proof that it can't work.

### Real use cases
- **Dynamic filtering of large result sets.** Fetch a big query, filter by a user-supplied predicate. Today you either ship all rows to the client (huge transfer) or pre-build a GraphQL endpoint for every filter you anticipate (boilerplate, and you can't anticipate them all). With Tierless you write the filter inline; because you're already on the server where the data is, the filter runs there and only matching rows cross.
- **Complex orchestration of uncertain shape.** A server action that conditionally fans out to several backend calls. Moving it to the client costs ~50–100ms latency per hop; building a bespoke endpoint is rigid. Tierless lets you write the orchestration straight and have it run server-side because that's where the latency wins are — without committing to an API shape before you know it.
- **Performance: stack smaller than heap.** Sometimes the state needed to *continue* a computation is far smaller than the data needed to *reconstruct* it on the other side. A cursor walk or tree traversal holds a few locals (kilobytes) while the dataset is megabytes. Shipping the continuation beats shipping the data. Static-split frameworks can't express this; they optimize for "keep data on the server," not "minimize continuation size."

### Honest limits
The need is **narrower than it would have been a decade ago.** Fat clients + managed services (Firestore, direct-auth'd cloud resources, GraphQL) have thinned out server logic, so the population of apps that genuinely need bidirectional code has shrunk. Tierless is most compelling for interactive apps with real server-side logic that isn't worth pre-specifying as an API, where a few ms of migration latency doesn't wreck UX. It is not a universal replacement for the current model.

---

## 3. Design principles

1. **Author writes ordinary source.** No tier annotations, no thinking about where code runs by default. It should read like Node + browser code combined into one program. (JavaScript today; TypeScript *sources* for tier-fluid modules are a roadmap item — the public API is already fully typed.)
2. **Resources are the tier model.** Every resource is an imported function. The set of imports available on a tier *is* that tier's capability set. Hit a function you don't have locally → migrate.
3. **Lazy placement.** Crossing the boundary is the expensive operation, so stay on whichever side you're already on until a resource forces you to move. This yields few, large migrations instead of chatty back-and-forth — and falls out of the cost model without a clever optimizer.
4. **Small continuations by default.** Only checkpoint at resource boundaries; serialize only the live locals in scope plus a resume token, not the whole stack or heap.
5. **Explicit opt-in at the boundary of the unified region.** You mark which modules are tier-agnostic. Everything else stays put. (You do *not* want to assume arbitrary backend Node code is safe to ship to a client — see §7.)
6. **Correctness before efficiency.** Sloppy code should still *work*, even if it's slow. Performance problems should be visible and measurable, then fixable — not silent correctness bugs.

---

## 5. Heap and shared state

The hard part. A migrated continuation references locals; some of those are pointers into a heap that stays on the originating tier. A raw pointer is meaningless in another tier's separate memory. Goals: keep author code natural, keep common cases cheap, don't silently corrupt.

### Model
- **Default: heaps are tier-local.** Most objects live and stay on one side. Cheap, no sync.
- **Small captured locals travel with the continuation.** Below a size threshold, just serialize them into the continuation.
- **Large objects become references, not copies.** Above the threshold, replace with an opaque handle (`obj#1234` = "object 1234, lives on tier X"). Dereferencing a handle you don't have locally triggers a fetch from the owning tier. The author doesn't see this; it just works, sometimes slowly.
- **Explicit shared state for genuinely cross-tier data.** A distinguished namespace (e.g. `shared.userData`) that authors hang shared domains off of. These get the full distributed-object treatment — tagged, tracked, fetched/synced lazily. This is the one place the author opts into "this is shared," and it keeps the expensive machinery scoped to where it's actually wanted rather than wrapping every closure variable.

### Coherence
The owning tier is the **master** — the single point where writes serialize. Readers on other tiers hold snapshots stamped with the master's version; a deref consults the master's current version (an invalidating cache), so a snapshot goes stale the moment the master changes and is refetched on next touch. That covers reads.

Writes are **optimistic, not locked.** A reader that mutates a fetched snapshot may propose it back to the master under the version it read — a compare-and-set. The master accepts only if no one bumped the version in between; otherwise the write is rejected as a conflict and the writer refetches (now seeing the winner's change), re-applies, and retries. This keeps the master as the sole serialization point (no distributed locks, no two-phase commit) while letting *any* tier be the writer, and it degrades to the simple single-writer case when there's no contention. The cost of a lost race is a refetch + retry, made measurable, never a silent lost update.

### Why not mirror the whole heap
Keeping both linear memories in full sync was considered and rejected: global/singleton/cache mutations would thrash constantly across the wire (megabytes, every mutation, every GC cycle). People *do* write code with lots of global state, so full sync is a performance disaster. Reference-on-demand + explicit shared state localizes the cost.

### Handling sloppy code
The system should still be *correct* for code that carelessly traverses `parent.child.grandchild` across a boundary — it just fetches transitively on demand and runs slow. The relief valve is visibility: profiling shows you the chatty path, and you refactor (batch-fetch, move the loop, restructure). Same philosophy as lazy placement — correctness by default, performance by discipline, badness made measurable.

---

## 6. Placement optimization (migrate vs. fetch)

"Always migrate to the resource" is the simple rule, but it's wrong when the continuation is large and the result is small (huge closure, tiny DB answer) — sometimes you'd rather fetch the data back and stay put. This needs a cost comparison, and the design intentionally keeps it **empirical, not speculative**:

- **Default / cold:** staying local = ~0 cost, migrating = effectively infinite. This reproduces the naive "only cross when forced" behavior and is a safe starting point.
- **Profiling:** instrument scopes to learn typical time-in-function and continuation size per call path. Over time, decide migrate-vs-fetch from real measured costs, not guesses. The estimate that's hard to get statically (result size) comes from history; the one that's easy (continuation size) is known.
- **Sampling, not always-on:** building a continuation and measuring its serialized size on *every* scope entry would be ruinously expensive, so this is sampled. A profile can be built once (e.g. from end-to-end tests), **locked in**, and shipped — with no sampling overhead in production.

This is the "is there actually a clean solution, or are we hand-waving?" question, and the running-cost-from-history approach is the answer the author was satisfied with: it degrades gracefully to the naive case when uninformed, and improves with data.

---

## 7. Security and the trust boundary

The client/server line is not just performance — it's a security boundary, and it constrains the design hard:

- **The server must never execute client-originated code as server code.** A continuation that "decided" it wants DB access cannot simply migrate to the server and run with server authority — that's RCE by design. Migration toward higher authority must be mediated: the server runs *its own* code for the resource, treating incoming continuation state as untrusted data, exactly as RSC treats server-function arguments as untrusted client input.
- **Explicit opt-in for the unified region (Principle 5) is partly a safety mechanism.** Backend Node code routinely holds secrets, credentials, privileged operations you would never ship to a client. Implicit "infer what's shippable" is too dangerous; the author must mark what's allowed to be tier-fluid. This was a deliberate choice in favor of explicit over implicit at *this* boundary (even though placement *within* the region is inferred).
- **Capability scoping is natural here.** Because resources are imports, the client module is simply instantiated with a restricted import set (no secrets, no DB, DOM-only). It physically cannot call what it isn't given.

---

## 8. Why not native engine continuations

Modern JS has `async`/`await` and generators, and there's an in-flight WASM proposal for
first-class continuations (stack-switching / WasmFX: `cont.new`, `suspend`, `resume`,
`switch`). Neither unblocks Tierless, for the same reason: both are
**suspend-but-not-serialize**. A paused generator's state, and a WASM continuation (a
`(ref $ct)`), are both live pointers into the *engine's own* stack memory — you can
resume or switch them, but there is no instruction to read one out as bytes, ship it
elsewhere, and rematerialize it on another host. Cross-host transport, which is what
Tierless actually needs, is out of scope for both mechanisms.

The stack-switching proposal is also not enabled in any shipping browser engine as of
early 2026 (V8, SpiderMonkey, JavaScriptCore) — the browser's closest shipping primitive
is JSPI, a narrower JS-level async-suspension bridge — and its continuations are
one-shot: resume/switch destructively consumes them, foreclosing speculative placement
(try a fetch, and on failure resume the same capture as a migrate instead).

So the transportable continuation is Tierless's own data structure — a plain frame
object the compiler produces, readable and serializable — never the engine's opaque
internal state. See [`architecture.md`](./architecture.md) ("Why the transportable
continuation is ours to build").

---

## 9. Prior art (where Tierless sits)

Grouped by *who decides placement* and *what crosses the wire*:

- **Compile-time split, declared boundary, RPC across (no migration):** React Server Components / Server Functions (`"use server"`/`"use client"`), Qwik (resumability with `$`-split lazy-loaded closures; one-directional server→client; `server$` for callbacks), TanStack Start, Waku, Remix/React Router. The whole mainstream. Kept JS, gave up *both* migration and inference — on purpose, to dodge chattiness and the trust boundary.
- **Tierless single-program, declared placement, split-compilation:** Eliom/Ocsigen (sections + `~%` injections, type-safe cross-tier references, both directions). Closest in spirit, but **explicitly rejects inference** — their stated belief is the programmer must know where code runs to avoid hidden round-trips. Links, Ur/Web, Hop.js, Opa, Scalagna are the same family.
- **Compile-time split, INFERRED placement (static slicing):** Stip.js / jspdg (Philips et al., Onward! 2014 — the lab that put "tierless" on the map). Build a Program Dependence Graph over one JS program, slice it into a client program and a server program (guided by `@client`/`@server` annotation blocks, later by search-based tier assignment optimizing communication/offline availability), and generate RPC stubs + data replication at every dependence edge the cut crosses. The dual of Tierless on the core axis: **they decide where code *lives*; Tierless decides where execution *stands*.** A static cut must answer placement for every statement once, globally, and pays for wrong answers in RPC forever; migration never answers it — the same compiled function runs wherever the continuation happens to be, and only resources force a side. The price they don't pay: their client bundle omits server-only code entirely (see the per-tier shake in the ROADMAP), and their global view can optimize placement whole-program where §6 prices one hop at a time.
- **Runtime split, SECURITY-driven placement (dynamic IFC):** Fission (Guha, Jeannin, et al., SNAPL 2017), descending from Swift/Jif (Chong et al., SOSP 2007 — static security-partitioning of Java). One JS program with *security labels* instead of placement annotations; the runtime executes with faceted values (Austin–Flanagan) and interposes on every operation, RPCing implicitly whenever a label pins a value to the other tier. Placement is per value, per operation — the finest split of any system here — and buys end-to-end **confidentiality** (a secret provably never flows client-ward, even through your own logic) and **integrity** (tainted client data can't corrupt server-trusted computation). The costs: program-wide interposition overhead, and chattiness that's hard to reason about (an RPC can hide behind any operation). Tierless's answer to the same threat model is the reference monitor (§7): accept that the migrating program is forgeable and gate its *effects* per call, rather than making the program itself safe to distribute — coarser, far cheaper, no interposition; Fission catches a class of leaks the monitor cannot. Complementary, and the best stealable idea in the paper is label-driven excision (ROADMAP). Lineage note: Fission's group went on to build **Stopify** (PLDI 2018), the JS-to-JS first-class-continuation compiler — the same transform family as Tierless's `transform.cts`. Tierless is, in effect, Stopify-style compilation applied to Fission's problem, with the security moved from IFC to a monitor.
- **Runtime live migration, content-addressed code:** Unison (`Remote.transfer`; definitions identified by content hash; ship bytecode, sync missing hashes on the fly; placement via effect-handler `Remote` ability). The cleanest realization of "ship the continuation, sync deps." Not JS, not web-tiered, placement explicit. Ancestors: Cloud Haskell, Erlang, mobile-agent literature.

**Tierless's unoccupied cell:** Unison-style live migration, driven by RSC-style resource-dependency *inference*, in the JS ecosystem, with lazy placement. Each half exists separately and in production-adjacent form; nobody has combined them. The objections each camp cites (chattiness, trust) are precisely the items §5–§7 must answer.

Qwik's `$`-optimizer (making closures individually addressable/movable in real JS) and Unison's effect-handler placement are the two most worth studying closely; Stip.js's whole-program placement search and Fission's label-driven splits are the two academic mechanisms worth folding in (both have concrete ROADMAP entries).

---

What's still open, and what's already shipped with its measurements and proofs, is
tracked in [`../ROADMAP.md`](../ROADMAP.md) and [`../CHANGELOG.md`](../CHANGELOG.md) —
not here.
