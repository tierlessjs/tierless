# Stackmix — Design Document

**Working title:** Stackmix (WASM Stack Oscillator)
**Status:** Early design / pre-prototype
**One line:** Write one program that runs across client and server as a single stateful application; the runtime moves execution between tiers as needed instead of making you split it by hand.

> **Orientation.** This is the original vision and the open research questions — kept as
> the "why," not a description of the current code. The prototype realizes this goal as a
> Babel **state-machine transform on V8** (see [`architecture.md`](./architecture.md)); a
> few sections below explore an IR/WASM continuation representation the prototype does not
> use. The load-bearing ideas it *does* implement — resource boundaries, the §5 handle
> heap, the §6 migrate-vs-fetch policy, the §7 trust boundary — are live and proven.

---

## 1. The idea

Today you write web apps as two programs pretending to be one. UI code lives on the client, data/secret/orchestration code lives on the server, and a whole layer of machinery — REST endpoints, GraphQL schemas, RPC, loaders — exists mostly to paper over the seam between them. The tier split has been internalized as a *design virtue* ("be explicit about where code runs"), but it's really a workaround for not having a better abstraction.

Stackmix treats the application as **one stateful program with access to both client and server resources**. You write business logic and presentation logic together. When execution touches a resource that only exists on one tier — the DOM on the client, the database on the server — the runtime ensures execution is on the correct side, migrating the live continuation across the wire if necessary.

This is *tierless programming* (cf. Eliom, Links, Ur/Web) but with two distinctive bets that no existing system combines:

1. **Placement is inferred from resource dependencies, not declared.** You don't annotate `"use server"`. Touching `db.query` implies server; touching `document` implies client. The resource you reference determines the tier.
2. **Execution migrates as a live continuation.** When you cross a tier boundary mid-computation, the runtime serializes the (small) execution state and resumes on the other side — rather than forcing you to restructure the crossing as an RPC call.

---

## 2. Why this is worth building (and where it isn't)

The mainstream (React Server Components, Qwik) deliberately retreated from both of Stackmix's bets: they split statically, declare placement with directives, and cross via RPC, never migrating a live continuation. They did this to avoid two real problems (chattiness and the trust boundary — see §7). So the honest framing is: Stackmix occupies a genuinely unexplored point in the design space, and the reasons others avoided it are the exact problems Stackmix's design must answer, not proof that it can't work.

### Real use cases
- **Dynamic filtering of large result sets.** Fetch a big query, filter by a user-supplied predicate. Today you either ship all rows to the client (huge transfer) or pre-build a GraphQL endpoint for every filter you anticipate (boilerplate, and you can't anticipate them all). With Stackmix you write the filter inline; because you're already on the server where the data is, the filter runs there and only matching rows cross.
- **Complex orchestration of uncertain shape.** A server action that conditionally fans out to several backend calls. Moving it to the client costs ~50–100ms latency per hop; building a bespoke endpoint is rigid. Stackmix lets you write the orchestration straight and have it run server-side because that's where the latency wins are — without committing to an API shape before you know it.
- **Performance: stack smaller than heap.** Sometimes the state needed to *continue* a computation is far smaller than the data needed to *reconstruct* it on the other side. A cursor walk or tree traversal holds a few locals (kilobytes) while the dataset is megabytes. Shipping the continuation beats shipping the data. Static-split frameworks can't express this; they optimize for "keep data on the server," not "minimize continuation size."

### Honest limits
The need is **narrower than it would have been a decade ago.** Fat clients + managed services (Firestore, direct-auth'd cloud resources, GraphQL) have thinned out server logic, so the population of apps that genuinely need bidirectional code has shrunk. Stackmix is most compelling for interactive apps with real server-side logic that isn't worth pre-specifying as an API, where a few ms of migration latency doesn't wreck UX. It is not a universal replacement for the current model.

---

## 3. Design principles

1. **Author writes ordinary TypeScript.** No tier annotations, no thinking about where code runs by default. It should read like Node + browser code combined into one program.
2. **Resources are the tier model.** Every resource is an imported function. The set of imports available on a tier *is* that tier's capability set. Hit a function you don't have locally → migrate.
3. **Lazy placement.** Crossing the boundary is the expensive operation, so stay on whichever side you're already on until a resource forces you to move. This yields few, large migrations instead of chatty back-and-forth — and falls out of the cost model without a clever optimizer.
4. **Small continuations by default.** Only checkpoint at resource boundaries; serialize only the live locals in scope plus a resume token, not the whole stack or heap.
5. **Explicit opt-in at the boundary of the unified region.** You mark which modules are tier-agnostic. Everything else stays put. (You do *not* want to assume arbitrary backend Node code is safe to ship to a client — see §7.)
6. **Correctness before efficiency.** Sloppy code should still *work*, even if it's slow. Performance problems should be visible and measurable, then fixable — not silent correctness bugs.

---

## 4. Architecture

### 4.1 Pipeline
```
TypeScript  ──►  Stackmix IR  ──►  WASM (per tier)
                  │
                  └─► carries: continuation/checkpoint metadata,
                      resource-boundary markers, type info for
                      serializing locals, source maps
```

- **Authoring language:** TypeScript first. The framework is **not** TS-only by construction — the IR is the real interface, and TS is the reference frontend. Other languages can be added later by writing a frontend that lowers to the Stackmix IR. (Note: languages that bring their own runtime — Python, Go — are the *hard* ones to add, because you'd be at the mercy of their runtime's ability to checkpoint itself; a language you lower yourself is easier. Multi-language is a latent capability, not a v1 goal.)
  - **Roadmap targets beyond TS — Rust and Dart.** Both have communities already invested in this substrate (Rust: **Yew**, Leptos; Dart: **Flutter** targeting wasm via dart2wasm), a real signal that the multi-substrate door is worth walking through. The load-bearing subtlety: their value to Stackmix is a *frontend that lowers to the Stackmix IR* — interpreter-level, serializable capture (§4.2.2) — **not** their native wasm output, whose call stack is exactly the thing §8 (and the prototype's honest limits) says you cannot snapshot in a browser. So "Rust support" means a Rust→IR frontend running on Stackmix's own interpreter, the same shape as the TS frontend; compiling Rust to stock wasm gets you wasm *execution* but not migratable *continuations*. On the easy/hard axis above, both sit on the easy side of the Python/Go line (you lower them yourself), but they are large languages and the frontends are real work: Rust brings the least runtime to model (no GC) but a big type/trait surface, while Dart brings more (a rich async/isolate model and GC semantics) that the lowering has to express in IR continuation terms. The migration property is the prize either way — a Rust or Dart continuation frozen to bytes and thawed on another tier — and nothing about the IR is TS-shaped, so it stays reachable.
- **IR level:** Closer to WASM than to TypeScript. It's essentially WASM-shaped (linear memory, explicit locals, typed) plus the metadata WASM doesn't carry: where the resource boundaries are, what's live at each, and how to serialize it. Lowering IR→WASM is then a thin pass.
- **Execution target:** WASM on both client and server. Same module both sides; tiers differ only in which imports are wired up.

### 4.2 Why WASM (and what's essential vs. incidental)
In the browser the only execution targets are JS or WASM. WASM is the better fit, for three concrete, load-bearing reasons:
1. **Capability boundary by construction.** A WASM module reaches the outside world only through declared imports. That import table *is* the tier model. JS has ambient access to globals, so you'd have to impose a boundary WASM gives you for free.
2. **Serializable-ish execution state.** WASM's linear memory + explicit locals is a more uniform thing to snapshot than JS's engine-internal stack (which you can't introspect without CPS-compiling or running your own interpreter).
3. **Uniform semantics both sides.** Identical bytecode runs identically on client and server, which is what makes resuming a migrated continuation coherent.

WASM is a **hard dependency of this (browser-targeting) design** — not decorative. The narrower claim is that the *concept* (resource-as-continuation, inferred placement) isn't *defined by* WASM — the JVM PoC proved that — which is exactly what keeps the multi-language/multi-substrate door open. But for what's being built here, in a browser, today: WASM, committed.

### 4.3 Resources as imports → migration points
Every resource access (`DOM.createElement`, `db.query`, `fetch`, secret access, file I/O) compiles to an imported function call. At compile time you therefore know **every** site where a migration *could* happen — they're exactly the resource-import call sites. You do **not** know statically which side the *caller* will be on (a function may be reached from either tier), so the decision is a runtime one:

> At a resource-import call site: do I have this resource locally? If yes, call it and continue. If no, capture the continuation and migrate to the side that does.

Compile-time visibility of boundaries; runtime decision at them. This is the minimal check, and it falls straight out of the imports-as-capabilities model.

### 4.4 What a continuation ships
Both tiers run the **same module**, so continuations reference shared code by position (instruction offset), not by shipping code. No content-addressing needed (unlike Unison, which needs it for dynamic/independent deployment). A migrated continuation carries:
- the resume point (instruction offset into the shared module),
- the live locals in scope (values, or references for large/heap objects — see §5),
- enough call-stack frame info to resume,
- nothing else: not the code, not the heap.

This is what keeps it small — and "small" is the central empirical claim the prototype must validate (§8).

### 4.5 React (and existing frameworks) sit on top, unmodified
Stackmix does not replace React. React runs *inside* the unified program. React already serializes its work down to DOM operations; it doesn't know or care what tier it's on. When React (running on the server) hits a DOM API it doesn't have there, that's a resource boundary — the continuation migrates to the client and React keeps going with the real DOM. Same component code throughout. The tier migration is invisible to React.

This makes Stackmix **additive, not a rewrite.** You take an existing Node + browser app, draw a boundary around a portion that's safe to run on either side, and let that portion become tier-fluid. The rest stays as-is.

---

## 5. Heap and shared state

The hard part. A migrated continuation references locals; some of those are pointers into a heap that stays on the originating tier. A raw pointer is meaningless in the other tier's separate linear memory. Goals: keep author code natural, keep common cases cheap, don't silently corrupt.

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

> **Open tension:** the author asked for sloppy code to "just work even if slow." Transparent on-demand fetch of arbitrary object graphs delivers that but risks unpredictable performance cliffs. The size-threshold + handle model is the current best answer; whether it's clean enough, or whether some cases need author-visible structure, is unresolved and is a prototype question.

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

## 8. The WASM stack-switching proposal — relevance and reality

There is an in-flight WASM proposal (WebAssembly/stack-switching, "typed continuations" / WasmFX, effect-handler based) that adds first-class continuations: `cont.new`, `suspend`, `resume`, `switch`. It is directly adjacent and worth tracking, but it does **not** unblock Stackmix, for two reasons that must be understood precisely:

### 8.1 It's in-process by construction
A continuation in that proposal is a `(ref $ct)` — an address into the *engine's* store (a live pointer into VM stack memory). You can `resume`/`switch`/`cont.bind`/abort it, all of which consume it **on the same machine**. There is **no instruction, and none on the roadmap, to serialize it to bytes, ship it, and rematerialize it on another host.** The proposal is about switching between stacks *within one instance*. Cross-host transport — Stackmix's actual need — is explicitly out of scope, and the blessed opaque-reference model arguably makes introspection *harder*, not easier.

So the scorecard:
- *"WASM has no native continuation capture"* → becoming **false for in-process** capture/resume (good: removes the CPS-compilation burden for the same-machine half).
- *Serializable, transportable continuations* → **still entirely Stackmix's to build.** This was always the hard part, and the proposal doesn't touch it.

### 8.2 It's not in browsers yet, and it's one-shot
As of early 2026 the typed stack-switching proposal is experimental and **not enabled in any shipping browser engine** (V8, SpiderMonkey, JavaScriptCore) or in Wasmer/Wasmi. Server-side runtimes are ahead: Wasmtime has a prototype (WasmFX, on its fibers API); Wasmer 7.0 shipped a WASIX `wasix_context_*` switching API. The browser's closest shipping primitive is **JSPI** (Chrome, 2024) — a JS-API-level async-suspension bridge, narrower than the instruction-level proposal.

Also: the proposal's continuations are **one-shot/linear** — resume/switch/bind destructively consume them; a second use traps. (There's an open request, issue #110, for optional multi-shot, but it's not in.) For Stackmix, one-shot is fine for a plain migration (capture once, resume once on the other side), but it forecloses *speculative* placement — you can't "try fetch, and on failure re-resume the same captured point to migrate instead." One resume per capture.

### 8.3 What to actually take from it
1. **Don't architect around waiting for it.** Capture must be done in Stackmix's own IR, where the continuation is *Stackmix's* data structure (readable, serializable), not the engine's opaque ref — substrate-independent.
2. **Borrow the interface, build the transport.** The effect-handler shape (tag + handler) is the right model for resource boundaries: hit a resource → `suspend` with a tag → host handler decides migrate-vs-fetch. This is the same structure Unison uses for its `Remote` ability. Model resource access as typed effects/tags; implement the cross-host mechanism yourself.
3. **Hybrid is viable and matches the architecture.** Use the engine's `suspend` (where available) purely as a clean unwind-to-host-handler trigger, while Stackmix maintains the serializable *shadow* state (the live locals at the boundary). Because Stackmix only checkpoints at resource boundaries — not arbitrary points — that shadow state is bounded and known, not a whole-stack blob.
4. **Engine introspection helps only on the side you own.** On the server you *can* fork Wasmtime/read its fibers, so engine-level capture might populate Stackmix's serializable representation more cheaply there. But the browser end exposes only the opaque ref, so a portable self-owned representation is mandatory regardless. Engine-reading is an optional server-side optimization, never the mechanism for the client.

> **Concrete next research task (definite answer, changes server design):** read Wasmtime's fibers/WasmFX code and determine whether a captured continuation can be reconstructed into *instruction-offset + typed-locals*, or only an opaque stack pointer. That decides whether server-side engine introspection meaningfully helps or whether the shadow-state representation must be hand-rolled everywhere.

---

## 9. Prior art (where Stackmix sits)

Grouped by *who decides placement* and *what crosses the wire*:

- **Compile-time split, declared boundary, RPC across (no migration):** React Server Components / Server Functions (`"use server"`/`"use client"`), Qwik (resumability with `$`-split lazy-loaded closures; one-directional server→client; `server$` for callbacks), TanStack Start, Waku, Remix/React Router. The whole mainstream. Kept JS, gave up *both* migration and inference — on purpose, to dodge chattiness and the trust boundary.
- **Tierless single-program, declared placement, split-compilation:** Eliom/Ocsigen (sections + `~%` injections, type-safe cross-tier references, both directions). Closest in spirit, but **explicitly rejects inference** — their stated belief is the programmer must know where code runs to avoid hidden round-trips. Links, Ur/Web, Hop.js, Opa, Scalagna are the same family.
- **Compile-time split, INFERRED placement (static slicing):** Stip.js / jspdg (Philips et al., Onward! 2014 — the lab that put "tierless" on the map). Build a Program Dependence Graph over one JS program, slice it into a client program and a server program (guided by `@client`/`@server` annotation blocks, later by search-based tier assignment optimizing communication/offline availability), and generate RPC stubs + data replication at every dependence edge the cut crosses. The dual of Stackmix on the core axis: **they decide where code *lives*; Stackmix decides where execution *stands*.** A static cut must answer placement for every statement once, globally, and pays for wrong answers in RPC forever; migration never answers it — the same compiled function runs wherever the continuation happens to be, and only resources force a side. The price they don't pay: their client bundle omits server-only code entirely (see the per-tier shake in the ROADMAP), and their global view can optimize placement whole-program where §6 prices one hop at a time.
- **Runtime split, SECURITY-driven placement (dynamic IFC):** Fission (Guha, Jeannin, et al., SNAPL 2017), descending from Swift/Jif (Chong et al., SOSP 2007 — static security-partitioning of Java). One JS program with *security labels* instead of placement annotations; the runtime executes with faceted values (Austin–Flanagan) and interposes on every operation, RPCing implicitly whenever a label pins a value to the other tier. Placement is per value, per operation — the finest split of any system here — and buys end-to-end **confidentiality** (a secret provably never flows client-ward, even through your own logic) and **integrity** (tainted client data can't corrupt server-trusted computation). The costs: program-wide interposition overhead, and chattiness that's hard to reason about (an RPC can hide behind any operation). Stackmix's answer to the same threat model is the reference monitor (§7): accept that the migrating program is forgeable and gate its *effects* per call, rather than making the program itself safe to distribute — coarser, far cheaper, no interposition; Fission catches a class of leaks the monitor cannot. Complementary, and the best stealable idea in the paper is label-driven excision (ROADMAP). Lineage note: Fission's group went on to build **Stopify** (PLDI 2018), the JS-to-JS first-class-continuation compiler — the same transform family as Stackmix's `transform.cjs`. Stackmix is, in effect, Stopify-style compilation applied to Fission's problem, with the security moved from IFC to a monitor.
- **Runtime live migration, content-addressed code:** Unison (`Remote.transfer`; definitions identified by content hash; ship bytecode, sync missing hashes on the fly; placement via effect-handler `Remote` ability). The cleanest realization of "ship the continuation, sync deps." Not JS, not web-tiered, placement explicit. Ancestors: Cloud Haskell, Erlang, mobile-agent literature.

**Stackmix's unoccupied cell:** Unison-style live migration, driven by RSC-style resource-dependency *inference*, in the JS/TS+WASM ecosystem, with lazy placement. Each half exists separately and in production-adjacent form; nobody has combined them. The objections each camp cites (chattiness, trust) are precisely the items §5–§7 must answer.

Qwik's `$`-optimizer (making closures individually addressable/movable in real JS) and Unison's effect-handler placement are the two most worth studying closely; Stip.js's whole-program placement search and Fission's label-driven splits are the two academic mechanisms worth folding in (both have concrete ROADMAP entries).

---

## 10. Open questions / risks

1. **Does the continuation actually stay small on real code?** The central empirical bet. Closures capture more than you'd think; the execution context may be fatter than hoped. *Answerable today on Node, in Stackmix's own IR, with no dependency on the WASM proposal — this is the first prototype.*
2. **Heap model cleanliness (§5).** Size-threshold + handles + explicit `shared.*` is the current answer; whether it handles genuinely sloppy code acceptably, or needs author-visible structure in some cases, is unresolved.
3. **IR design.** "WASM-shaped + continuation metadata" is the working assumption; the right abstraction layer may only become clear once capture/serialize is actually implemented.
4. **Migrate-vs-fetch profiling (§6).** Cold-start-naive + sampled-history-locked-profile is the plan; needs validation that locked profiles generalize and that sampling overhead is acceptable in dev/E2E.
5. **Browser substrate timing.** Native stack-switching isn't in browsers; near-term you're on your-own-IR capture (+ possibly JSPI). Budget accordingly; treat native stack-switching as a later optimization, not a foundation.
6. **Tooling/DX.** Source maps from TS through IR through WASM (so serialized continuations and debugging show TS line numbers and variable names, not instruction offsets) is necessary, standard, but real work.
7. **Scope of value.** Honest market is narrower than a decade ago (§2). Worth confirming the target app class (interactive, real server logic, API-shape-uncertain) is big enough to matter to you before heavy investment.

---

## 11. First prototype (smallest thing that proves the core)

**Goal:** show that a continuation can be captured at a resource boundary and serialized *small*.

- Run on Node, both "tiers" as two processes (or two WASM instances), no browser yet.
- One client-only resource (`DOM.*` stub) and one server-only resource (`db.query` stub).
- Author a single TS function that: queries the DB (server resource), filters results with an inline predicate, then writes each to the DOM (client resource) — i.e. it *must* cross at least once each way.
- Implement capture-at-boundary in your own IR; serialize live locals + resume offset; resume on the other process.
- **Measure the serialized continuation size** against the alternative (shipping the full result set). The cursor/filter case should show kilobytes-of-stack vs. megabytes-of-data.

If that size claim holds, the idea has legs and you move to the heap model and the browser substrate. If the continuation is fat, you learn the limits immediately and cheaply.
