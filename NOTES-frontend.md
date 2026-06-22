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
## #4 step 5 (done — stdlib + exceptions, verified vs eval)
- Array higher-order methods (.map/.filter/.forEach/.reduce) inline-compiled to
  IR loops + CALLV, so callbacks are real Waso closures (suspendable — proven a
  callback could await). Plain methods (slice/join/split/toUpperCase/... string
  + array) via a new CALLM op that delegates to the host value's method.
- try/catch/throw: new PUSHTRY/POPTRY/THROW ops + a per-frame handler stack;
  THROW unwinds frames to the nearest handler (works across calls). Handlers are
  part of the serialized continuation -> a try/catch survives migration mid-await
  (proven: thrown-after-resume value is caught). finally not yet supported.
- probe-realts.mjs now checks 9 real-JS snippets === Node's eval, incl.
  map/filter/reduce, chained string methods, throw caught locally, and throw
  propagating across a call frame.
## #4 step 6 (done — classes)
Classes: `class`/`new`/`this`, fields (defaults + ctor-set), methods, constructor.
An instance is an object whose method properties are closures capturing `this`
(synthetic thisId per class, provided as the closure's first capture at `new`);
so `obj.method()` works via the existing GETPROP+CALLV path, and methods can call
each other via this.m(). Field initializers run in the constructor prologue (with
`this` bound); a class with no constructor inits fields inline at `new`. Added
property/element assignment (obj.p = v / arr[i] = v via new SETINDEX op),
compound (this.x += y), and ++/-- on properties. Verified vs Node's eval:
counter (ctor/fields/methods/this), cart (method using reduce + this), greeter
(method calling method + string method), box (field defaults, no ctor). All match.
## #4 steps 7-10 (done — operators, modern syntax, rest, classes/inheritance)
Verified vs Node's eval (probe-realts.mjs, 22 snippets):
- null/undefined/NaN/Infinity, typeof, void, ?? , ??=/||=/&&=, switch, **, let-no-init
- optional chaining ?. (property/index/call, short-circuit to chain end)
- spread: array [...a], object {...o}, call f(...args) (CALLVS); rest params (GATHERREST)
  (calling convention no longer pads locals; wire codec encodes arrays by index)
- classes: fields, methods, this, new; AND extends/super (super(...) ctor chain,
  super.method(), method override, base-first method binding).
Still TODO for arbitrary files: getters/setters/static members, real Promise +
async stdlib, for-in, finally, generators, regex/bigint, labeled statements,
computed member names, comma operator. Known limits: inheritance requires
explicit constructors; derived field inits run at ctor entry (before super);
boxing/scoping is function-scoped (no block-scoped shadowing).

## #4 step 11 (done — Promise/async stdlib, no colored functions)
Promise.resolve/reject/all/race lowered onto AWAIT (await of a plain value =
identity; reject = MKREJECT -> throw at AWAIT; all/race = sequential awaits).

## #4 step 12 (done — the language tail: finally/for-in/regex/labels/instanceof)
Verified vs Node's eval (probe-realts.mjs, now 32 snippets). Added:
- **for-in** (KEYS op), **computed object keys** `{[e]: v}`, **delete** (DELPROP/
  DELINDEX), **regex literals** + test/exec/match/replace, **comma** operator,
  **bitwise** `& | ^ << >> >>>` + unary `~` (BITNOT), `in`, **do-while**,
  for(;;) with a non-declaration initializer.
- **try/finally with FULL abrupt-completion semantics.** Rewrote control flow
  onto ONE unified stack (`cf`): loops/switch break-continue targets AND active
  try handlers / finally blocks, innermost last. A `return`/`break`/`continue`
  that crosses a try now POPTRYs its handler and emits its `finally` inline on the
  way out (`unwind`), so finally runs on every exit path — normal, throw, return,
  break, continue — including **nested** finally (innermost first) and **finally-
  override** (a finally that itself returns/throws wins). `return e` evaluates `e`
  *before* running finally (return value snapshotted into a temp). try/catch/
  finally is lowered as `try { try/catch } finally` so a throw from the catch
  body still runs finally. This is the real JS semantics, not a caveat.
- **labeled statements**: `label: for(...)`, `break label` / `continue label`
  resolve to the named loop on `cf` and unwind any finally between (proven:
  labeled-continue runs the intervening finally).
- **instanceof**: instances carry a `__class__` chain tag (base..derived) set at
  `new`; `x instanceof C` (ISA op) checks membership — works through inheritance,
  false for primitives/plain objects. (Note: the tag is an enumerable own prop,
  so a *raw* instance shipped as JSON differs from Node — but raw instances were
  already non-round-trippable since methods are own closure props; computed
  values are unaffected. A real impl would mark it non-enumerable.)

Still deferred (genuine model friction, not just unwritten) — all would need work
beyond lowering:
- **getters/setters**: a property *access* would have to invoke a Waso closure,
  i.e. GETPROP/SETPROP would push a frame and themselves become suspension points.
  Doable but invasive (every member access is potentially a migration point).
- **static members**: need to reify a runtime class object (statics live on it)
  and resolve a bare `ClassName` identifier to it; `new` is currently a special
  form, not a value.
- **generators**: a second flavor of suspendable frame (yield). Our continuation
  machinery could host it, but it needs its own lowering + a resumable-iterator
  protocol; for-of currently assumes array-shaped iterables.
- **BigInt**: literals + a numeric tower the i32/JS-number interpreter doesn't model.
Known limits unchanged: inheritance requires explicit constructors; derived field
inits run at ctor entry (before super); boxing/scoping is function-scoped.

## Don't forget
- **Source maps**: NJS captured the stack but deferred line/file metadata. Our
  §10.6. Design it into the transform from the start, don't bolt on.
- **Heap deref shape** (from the email; informs #2 now): a deref consults an
  invalidating cache and resolves three ways —
  `local? use master : movable-data? fetch (+cache) : pinned-resource? migrate`.
