# Working notes — for #4 (the frontend transform). TEMP / scratch.

Context dump so it's fresh when we get to #4. Not polished.

## Lineage
The design's Rhino/"Aesop" PoC (design doc §1) traces to a 2006 thread with
Neil Mix (author of **NJS / Narrative JavaScript**). NJS = a CPS source-to-source
compiler that reified the JS stack into a continuation *object* via a blocking
operator, running on stock engines (incl. Rhino). The 2006 design already had,
by name: migrate-vs-fetch, lazy placement ("opportunistic context oscillation"),
resource-pinning (DOM/native = can't move → transfer the stack), and usage-based
prefetch. i.e. the model has been stable for ~20 years; that's reassuring.

## #4 approach (frontend: getting real TS into capturable form)
- Go the **NJS route: a CPS / state-machine source transform over a TS subset**
  (TS compiler API / SWC / Babel), NOT a full interpreter. More deployable for
  real TS than the interpreter we used for the toy subset.
- Emit **our own serializable continuation** at boundary points. The transform
  owns the reification; the runtime (this repo) owns capture/serialize/migrate.

## The one thing that changed in 20 years (and the trap)
- `async/await` + generators are now **native suspension**. Use them as the
  *boundary shape*: a resource access is just an `await`. NJS had to invent the
  blocking operator; we don't.
- TRAP: native async is **suspend-but-not-serialize**. A suspended async/gen
  state is engine-internal — you can't capture it as bytes and ship it. This is
  exactly §8's line about the stack-switching proposal being in-process/one-shot.
  So: reuse async semantics for the boundary + local suspend, but the
  transportable continuation is still ours to build (CPS-to-data), same as NJS.

## #3 result (done — probe-async.mjs)
Modeled `await` as a suspension point (AWAIT op): a call returns an awaitable
descriptor, AWAIT suspends, the host resolves it async, then resumes. Proven:
the async program runs on the runtime AND runs end-to-end through
serialize/deserialize at every await (~316 B continuation) — i.e. an
await-suspended continuation IS serializable/migratable, the exact thing native
async can't do. So for #4 the boundary shape is `await`, and the transform's job
is to emit our AWAIT (+ serializable descriptor) at each suspension, not to rely
on the engine's async state. Same suspension also resolves a remote handle fetch.

## #4 step 1 (done — waso-tsc.mjs, probe-frontend.mjs)
Built a TS->JS-IR frontend targeting the de-risked runtime (NOT the wasm IR).
Done: closure conversion (free-var analysis -> MAKECLOSURE + LOADENV; top-level
fn ref = closure with no captures), CALLV over first-class closures, multi-frame
CALL/RET in waso-core, and `await` lowering (await expr -> expr; AWAIT). Proven:
real TS `makeAdder`/`main` compiles + runs (=32); and a closure that is live
across an `await` survives a serialize/deserialize boundary mid-await (env
travels as data, code by fn-name) and still works (=105). Confirms: async needs
NO colored functions here — `await` is just a suspension, any fn can suspend.

Subset so far: number/string literals, identifiers, +-* and comparisons,
member/element access, object/empty-array literals, calls (closure + resource +
.push), const/let, if/for, return, arrow/function expressions, await.
TODO next: mutable captured vars (currently env is by-value snapshot — fine for
read; shared mutation across a closure boundary is the open case), broader
control flow, and source-map metadata (line/file through the transform).

## #4 step 2 (done — mutable captured variables)
Added assignment (`x = e`), `++`/`--`, and BOXING: a variable that is captured by
a nested closure AND assigned is stored in a shared cell {v} (analyzeBoxing finds
them). Reads/writes go through the cell; closures capture the cell by reference.
Because the wire format preserves object identity, the cell stays ONE node, so
two closures sharing a mutable `let` remain shared across a migration. Proven
with makeCounter: inc/inc/get = 2 locally AND after serialize-at-await.
Remaining: broader control flow/subset; lexical shadowing (boxing is by name,
not by binding — known limitation); source-map metadata.

## #4 step 3 (done — binding-keyed scoping, control flow, source maps)
- Rewrote scoping to be BINDING-keyed (resolveBindings assigns each declaration
  a unique id; uses resolve to it). Lexical shadowing now correct: two `n`s in
  different scopes are distinct bindings; boxing is per-binding, not per-name.
- Control flow: while, break/continue (loop label stack), &&/|| (short-circuit
  via DUP), ternary, unary !/-, += -= *=, true/false. Added DUP/NOT to waso-core.
- Source maps: every emitted instruction records its TS line/col/text; a
  serialized continuation maps back to a TS stack trace (describeContinuation).
  Demo prints `#1 task app.ts:4 step()` / `#0 step app.ts:3 await fetchThing()`.
Remaining subset gaps: block-scoped shadowing within ONE function (function-
scoped only), nested function *declarations* (arrows/exprs ok), classes,
destructuring, spread, template strings, try/catch, real Promise/stdlib.

## #4 step 4 (done — breadth, verified vs Node's eval)
Added: template literals, array literals with elements, for-of (incl. nested
destructuring patterns), default parameters, nested function declarations
(hoisted as local closures), object/array destructuring in declarations,
== / != (mapped to ===/!==), synthetic temp slots for loop/destructure scratch.
probe-realts.mjs compiles 5 real JS snippets and checks Waso's output EQUALS
Node's own eval (templates+defaults+for-of+nested fn; array-lit+ternary+while+
break/continue; destructuring+template; closures-in-array+higher-order;
nested-destructuring-in-for-of+default+compound). All match.
Still TODO for real files: classes, try/catch/throw (needs interpreter
exception unwinding), spread, array higher-order builtins (.map/.filter — need
stdlib), real Promise, switch, block-scoped shadowing, for-in.

## Don't forget
- **Source maps**: NJS captured the stack but deferred line/file metadata. Our
  §10.6. Design it into the transform from the start, don't bolt on.
- **Heap deref shape** (from the email; informs #2 now): a deref consults an
  invalidating cache and resolves three ways —
  `local? use master : movable-data? fetch (+cache) : pinned-resource? migrate`.
