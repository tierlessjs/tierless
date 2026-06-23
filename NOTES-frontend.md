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

## #4 step 1 (done — stackmix-tsc.mjs, probe-frontend.mjs)
Built a TS->JS-IR frontend targeting the de-risked runtime (NOT the wasm IR).
Done: closure conversion (free-var analysis -> MAKECLOSURE + LOADENV; top-level
fn ref = closure with no captures), CALLV over first-class closures, multi-frame
CALL/RET in stackmix-core, and `await` lowering (await expr -> expr; AWAIT). Proven:
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
  via DUP), ternary, unary !/-, += -= *=, true/false. Added DUP/NOT to stackmix-core.
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
probe-realts.mjs compiles 5 real JS snippets and checks Stackmix's output EQUALS
Node's own eval (templates+defaults+for-of+nested fn; array-lit+ternary+while+
break/continue; destructuring+template; closures-in-array+higher-order;
nested-destructuring-in-for-of+default+compound). All match.
## #4 step 5 (done — stdlib + exceptions, verified vs eval)
- Array higher-order methods (.map/.filter/.forEach/.reduce) inline-compiled to
  IR loops + CALLV, so callbacks are real Stackmix closures (suspendable — proven a
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
- **getters/setters**: a property *access* would have to invoke a Stackmix closure,
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

## #4 step 13 (done — BigInt; deferred-feature build-out 1 of 4)
First of the four deferred features (sequenced: BigInt -> getters/setters ->
static -> generators; risk-ascending, each builds a primitive the next reuses).
BigInt is nearly free on the JS path because the native engine does the
arithmetic (incl. correct TypeError-on-mixing, integer-division, `**`):
- frontend: `123n` literal (ts.isBigIntLiteral; hex/oct/bin via BigInt(text)),
  and `BigInt(x)` conversion (TOBIG op).
- type-aware `++`/`--`: new INC/DEC ops pick `1n` vs `1` by operand type (a plain
  `PUSH 1; BIN +` mixed BigInt with Number and threw, as it should).
- fixed a latent bug while here: `==`/`!=` were mapped to `===`/`!==`. Now real
  loose equality (binop ==/!=), so `1n == 1` is true and `1n === 1` is false.
- codec: BigInt isn't JSON-safe, so encodeGraph emits `{k:"big", v: str}` /
  decodeGraph rebuilds via BigInt(str) — a BigInt now survives a migration
  (probe-heap). This establishes the "add a value kind to the codec" pattern that
  the migrating-generator work (step 4c) reuses for frame-stacks.
Verified vs Node's eval (probe-realts: 25-digit factorial, 2n**64n, 7n/2n=3n,
bitwise, mixed-type compare, typeof, BigInt()). All match.

## #4 step 14 (done — getters/setters; deferred build-out 2 of 4)
The read path stays branchless for the common case via COMPILE-TIME NAME
SPECIALIZATION: the frontend collects `accessorNames` (every property that is a
get/set in any class); a read/write of a name in that set emits the accessor-aware
op (GETPROPA/SETPROPA), everything else stays the plain GETPROP/SETPROP. So
`.length`/`.id`/methods never pay a check; only accessor-named accesses do, and
even those fall through to a plain field when the receiver has no such accessor.
- Instances carry an `__accessors__` table built at `new` (base..derived, derived
  overrides), each entry { get?, set? } a closure capturing `this`.
- GETPROPA calls the getter as a real frame (RET lands the value on the caller);
  SETPROPA calls the setter(v) as a frame (RETs undefined, satisfying SETPROP's
  value contract). Compound `obj.x += 1` and `obj.x++` route through both.
- Pausable getters need NO dispatch: a value whose access may suspend is a handle,
  and the existing `d()` on the object operand already pauses at use. Computational
  getters (recompute/side-effect) are the GETPROPA path.
- Payoff proven (probe-frontend §I): a getter that touches a server resource
  SUSPENDS AND MIGRATES *inside the property read* — the getter's own half-evaluated
  frame rides the wire and resumes on the other tier. Native JS can't: getters
  can't be `async`, so the platform cannot suspend there at all.
Verified vs eval (probe-realts): get/set pair (Temp °C/°F), read-only getter
(Rect.area), compound-through-accessor, getter override via inheritance.

## #4 step 15 (done — static members; deferred build-out 3 of 4)
Reified the class as a runtime object (statics live on it):
- a 0-arg builder fn `%ClassName` builds-or-returns the singleton, cached per
  tier (CLSGET/CLSPUT on tier.statics). Bare `ClassName` -> `MAKECLOSURE %Name []
  ; CALLV 0`. Builders are generated AFTER all classes compile (fixpoint over
  field-init class refs), so a static method referencing its own class mid-compile
  doesn't hit a half-populated table. Emitted as raw IR via a new compileFn
  `emitBody` hook so static-field inits reuse expr().
- static methods (this = the class object, distinct staticThisId), static fields
  (init runs code), static get/set (reuse the __accessors__ machinery on the class
  object), base-first inheritance (derived overrides base).
- as predicted, this reused the getter muscle ("a reference that runs code") and
  the codec is untouched on the happy path.
Boundary (consistent with the design analysis): the class object is per-tier, so
within a tier statics are a true singleton (mutation works); across a migration
each tier rebuilds — i.e. class objects travel by reference and re-bind per tier,
like closures/fn-names. Mutable *shared/inherited* static state is therefore §5
handle/coherence territory, not a plain migrating field (derived statics are a
copy of base, not prototype-shared — diverges from JS only in that one case).
Verified vs eval: static method+field+mutation+static-this+factory; 3-level static
inheritance with override; static getter/setter.

## #4 step 16 (done — generators; deferred build-out 4 of 4)
Generators, the on-thesis one: a generator's state IS our continuation frame, so
`yield` is cheap and the payoff (migration) falls out.
- `yield` = YIELD op: a LOCAL/bounded suspension (throws Yielded out of the sub-run
  driving the generator), distinct from Suspend (whole-program migrate). `yield e`
  leaves the sent value as the expression's value; two-way `next(v)` works.
- a generator object is an iterator wrapping its OWN paused frame stack
  ({ __gen__, frames, done, started }). `gen()` -> GENMAKE builds it (top-level
  `function*` and nested `function*` decls; via the closure so env/`this` ride
  along). genAdvance drives it (a recursive run() on its frames to the next yield
  or completion).
- 4b iterator protocol: for-of now lowers to ITER/ITERNEXT and consumes arrays AND
  generators uniformly; `it.next(v)` -> GENNEXT (falls back to a plain `.next()`
  method call for non-generators); `yield*` delegates (drives an inner iterator,
  result = its return value; sent values not forwarded — noted).
- 4c migration (the headline): a generator's frames are plain data, so a paused,
  half-consumed generator rides the graph codec UNCHANGED as part of the
  continuation and keeps yielding on the other tier (probe-frontend §J:
  counter() consumed to 0, migrated mid-await, resumes 1,2). Native JS generators
  are engine-internal and cannot serialize at all — same suspend-but-not-serialize
  gap as async.
Verified vs eval (probe-realts): range/fib via for-of, two-way echo via next(),
yield* delegation with return value.
## #4 step 17 (done — generator tail; completes generators)
Closed out the 4d tail:
- generator METHODS (`*m()`, `static *m()`, `async *m()`): solved by marking the
  CLOSURE as a generator (MAKECLOSURE 4th arg) and having CALLV/CALLVS build the
  iterator when `callee.gen`. This replaced GENMAKE and unified top-level / nested
  / method / `const g = gen; g()` — no call-site type knowledge needed.
- `.return(v)`: GENRET — injects a sentinel that the finally machinery propagates
  back out (carrying v), so FINALLY-ON-ABANDON runs; a finally that returns/throws
  overrides. `.throw(e)`: GENTHROW — injects e at the suspension point (caught by
  an in-generator try/catch -> may yield again; else propagates to the caller).
  Both fall back to a plain `.return`/`.throw` method call for non-generators.
- spread over generators: APPENDALL drives the iterator (so `[...gen()]` and
  `f(...gen())` work).
- async generators: `async function*` is already a generator (asterisk) whose body
  has AWAIT ops; added `for await` (awaits each value — identity for a plain/
  resolved value). Verified vs Node's real async generators.
Remaining frontier (one, honest): a GENUINE async resource awaited *inside* a
generator, suspending to the host mid-iteration. genAdvance drives the generator
on a recursive run(); a Suspend there carries the generator's frames, not the
outer continuation, so the two would need to be composed/linked and resumed in
order (the outer op GENNEXT/ITERNEXT becoming a resumable suspension point). The
local case (await of plain/resolved values) works; cross-tier migration of an
*outer* continuation that merely *holds* a paused generator also works (§J). It's
mid-generator host-suspension specifically that's unbuilt.

## #4 step 18 (done — block scoping + per-iteration let)
Rewrote resolveBindings to be properly LEXICAL:
- `let`/`const`/`class` are block-scoped (each Block / for-header / catch-clause
  pushes a scope); `var`/params/function-declarations are function-scoped (hoisted).
  Each declaration still gets a unique id + a flat slot in its OWNING function's
  frame, so compileFn is UNCHANGED — only resolution (which id an identifier maps
  to) became lexical. Capture = used from a deeper function than the one that owns
  the binding (compare scope.fnNode to the current function).
  Fixes the big one: two same-named block-locals in a function (`for (const v of
  a){} for (const v of b){}`) are now distinct — the first loop no longer reads the
  second's slot. Plus nested shadowing and if/else block lets.
- per-iteration `let` in C-style `for`: a boxed loop var gets a FRESH cell each
  iteration (copy current cell AFTER the body, BEFORE the incrementor — the spec's
  CreatePerIterationEnvironment), so `for (let i...) fns.push(()=>i)` captures
  [0,1,2] not [3,3,3]. (for-of/for-in already got a fresh cell per iteration via
  bindStackTop.) continue routes through the copy; nested loops compose.
Verified vs eval: sibling/nested/shadowing blocks; per-iteration capture simple +
nested + with-continue.

## #4 step 19 (done — "known issues" sweep across all 6 areas)
A pass over the documented gaps, ordered traps-first. All verified vs Node's eval
(probe-realts) unless noted; full suite green at each step.

1. Silent correctness bugs (FIXED):
   - destructuring defaults `{a=5}`/`[a=5]` + rest `{a,...r}`/`[x,...r]` (nested, for-of).
   - `yield*` forwards sent values into the delegated iterator (+ delegates return).
   - implicit/empty `return` yields `undefined`, not `0` (void fns; done generators).
   - `Promise.all` resolves elements CONCURRENTLY (AWAITALL op + awaitAll wire
     boundary; host resolves together). Proven concurrent (probe-async, max-in-flight=3).
2. Stdlib reach (FIXED): Math/JSON/Object/Array/Number/String/Boolean/parseInt/
   parseFloat/isNaN/isFinite/console/Date via a GLOBAL registry shipped BY REFERENCE
   through the codec; `Global.method(...)`->CALLM/CALLMS, bare `fn(...)`->CALLG.
   Array HOFs find/findIndex/some/every (early-terminating) + flat. Map/Set
   (construct via CTORG, methods, for-of via the iterator protocol, codec {k:map|set}).
   CALLMETHOD dispatches user-closure vs host method at runtime (fixes host methods
   AND stops user methods named get/set/has being hijacked).
3. Lowering gaps (FIXED): arrow `this` capture (incl. nested) + regular-fn `this`=
   undefined; private fields/methods `#x`; `typeof undeclared`->"undefined";
   destructuring parameters (slot-per-position calling convention).
4. Model/serialization caveats (FIXED): instance methods/__class__/__accessors__ are
   non-enumerable (SETHIDDEN), so JSON.stringify/Object.keys/for-in over an instance
   see only data — matching JS; the codec preserves non-enumerability across the wire.
   Computed access `obj[k]` fires accessors (INDEX/SETINDEX accessor-aware).
5. Async-inside-generator (MADE SAFE + documented): a genuine async resource awaited
   inside a generator mid-iteration now throws a clear error instead of corrupting the
   outer continuation. Full fix = splice generator frames onto the main stack (one
   flattened stack so a Suspend captures everything); designed, deferred (large blast
   radius across the working generator suite — wants a reviewed change).
6. WASM path (DOCUMENTED): i32-only by design — the linear-memory-continuation proof,
   not where language coverage lives (README "Two execution paths"). Not a gap.

Still deferred (loud compile errors + reasons), all "just unwritten lowering":
- LOCAL class declarations (class inside a function) — name-collision/unique-naming
  work; workaround: hoist to module scope.
- object-literal getters/setters `{ get x(){} }` — class accessors are supported;
  object-literal ones need `this`=the-literal binding while it's being built.
- `arguments` object — rest params cover the common case.
- tagged templates, computed method names `[e](){}`, `new.target`, `with`.
Representational caveats (intrinsic to the model): `typeof ClassName` is "object"
(the reified class object), not "function"; a mutable static shared ACROSS tiers is
§5 handle/coherence territory (per-tier class object), not a plain migrating field.

## #4 step 20 (done — cleared the deferrals + a conformance suite)
Closed essentially every remaining deferral and added a general-purpose conformance
suite (the bar for a framework: not "the frontend parses X" but "a live computation
using X freezes to bytes, ships, and thaws correctly").
- async-INSIDE-a-generator frontier CLOSED via the splice model: a generator
  advances by splicing its frames onto the MAIN stack beneath a boundary frame
  (YIELD unwinds to it, or throws Yielded when driven recursively by .return/
  .throw/spread; RET past it completes). A Suspend (await of a real resource inside
  a generator) now captures the whole flattened stack -> it migrates. Proven: a
  `for await` over an `async function*` awaiting a resource each step round-trips
  the continuation 3x and resumes correctly (probe-frontend K, conformance).
- ++/-- fixed as EXPRESSION values (postfix old / prefix new; props/elements);
  unary + (numeric coercion). Was a pre-existing silent bug.
- arguments (snapshot, nested-arrow capture); tagged templates (+ String.raw);
  object literals with methods/getters/setters/generator methods (this-bound,
  data enumerable); local class declarations (unique names, no collisions, capture,
  instanceof, extends); IMPLICIT constructors (super(...args)+field inits — removes
  "inheritance needs an explicit ctor"); destructuring ASSIGNMENT ([a,b]=.., {x}=..,
  defaults/rest/nested); new.target.
- Still deferred (intentional boundary): computed method names `[e](){}` (main use
  is Symbol.iterator -> needs Symbol, a separate track); `with` (forbidden in
  strict/module mode — correctly rejected); module-level (top-level) variable
  bindings (the entry is a function — no module-init phase).
- conformance.mjs: PART 1 fidelity (Stackmix === Node across the whole language), PART 2
  continuation (the SAME programs frozen to bytes & resumed at every `await ckpt()`
  checkpoint, with closures/boxed cells/Maps/Sets/class instances/generators/cyclic
  graphs/live handlers alive across the wire). 56 checks; max continuation 682 B.
  This is the reusable template for any other language that targets the IR.

## #4 step 21 (done — completeness-first sweep + differential testing)
Switched from "support the common case" to "MEASURE completeness against Node, fix
every divergence." New `difftest.mjs` runs ~217 semantic-corner snippets through
both Stackmix and Node and flags any divergence (it can't be asserted, only measured).
Now 214/217, with 3 *documented* caveats (see below). What got fixed:
- **Dynamic `this`**: methods read `this` from the call-site receiver (frame.thisVal),
  not a value baked at definition. Fixes method borrowing, plain-fn-as-method,
  dynamic dispatch. Arrows stay lexical; a non-arrow owner snapshots its dynamic
  this as the MAKECLOSURE "T" env source, so arrows inside borrowed methods are
  correct. frame.thisVal travels in serializeContinuation (an identity-shared root)
  — caught by a migration test where a borrowed async method reads `this` only
  after a checkpoint.
- **Function.prototype.call/apply/bind** on user closures (shared `enter` helper +
  a flattened bound-closure rep honored by every call path). **ToPrimitive** for
  coercing ops (`'' + new P()` calls the instance's valueOf/toString).
- **Error semantics**: instanceof against built-ins (ISAB op), `class X extends Error`
  (message/name/chain), `new TypeError/RangeError/...`. **typeof** "function" for
  closures and class objects (a __classobj__ marker keeps instances "object").
- **Iterator-protocol array destructuring** (`[a,b] = set/gen`, TOARRAY op).
  **Accessor inheritance** matches JS prototype shadowing; getter-only write is a
  no-op. **Map/Set.forEach**, **JSON.stringify** drops functions, computed
  object-literal accessors. Fixed an unbounded-recursion OOM (`static b = C.a+1`).
- **Latent HOF-name collision**: methods named find/map/filter/forEach/... (a
  repository's `.find()`, Map/Set.forEach) were force-dispatched to the array-HOF
  inliner; `hof` now guards on isArray at runtime and short-circuits no-callback.
- A throw inside a nested synchronous run (proxy trap, toString coercion) now
  routes into the caller's try/catch instead of escaping as StackmixUncaught.

## #4 step 22 (done — metaprogramming: Proxy, Reflect, decorators, DI)
The framework story (Vue/Nest/Angular). `decorators.mjs` (25 checks) diffs against
the TS `experimentalDecorators` transpile (Node can't run decorator syntax in plain
JS, so the *reference* is the compiler's own lowering).
- **Proxy**: get/set/has/deleteProperty/ownKeys traps. A wrapper carries a
  non-enumerable `__proxy__ = {target, handler}`; every property op checks proxyOf
  first and drives the matching trap synchronously (HASKEY op for `in`, KEYS for
  for-in/Object.keys). Plain objects pay one `__proxy__` read — benchmarks
  unchanged. Proxies migrate (handler closures travel; traps keep firing).
- **Reflect**: get/set/has/deleteProperty/ownKeys/apply/construct (reuse the
  trap-aware ops), plus a **metadata store** (defineMetadata/getMetadata/...). Metadata
  lives ON the target as a non-enumerable `__meta__` Map, so it travels through the
  codec instead of a side WeakMap.
- **Decorators** (legacy): **class** decorators run at module load, bottom-up, with
  the class object as target; a non-null return rebinds it. **method** decorators get
  a real {value,writable,enumerable,configurable} descriptor and can wrap/replace
  (instance methods become ONE shared closure via dynamic this, stashed at
  __dm_<name> for `new` to attach); **property/parameter** decorators run for their
  side effects. Classes with decorators build their class object EAGERLY at module
  load. `Class.prototype` aliases the class object (we collapse prototype/constructor).
- **emitDecoratorMetadata**: a decorated class with an explicit ctor carries
  `design:paramtypes` — param types resolved to runtime constructors (same-module
  classes + serializable builtins syntactically; interfaces/unions → Object).
- **Dynamic `new C(...)`** (C a runtime class value) and **Reflect.construct**: each
  top-level class object carries a `__construct__` callable (the instance-assembly +
  ctor call factored into a per-class `%new_<cname>` builder, shared with the inline
  `new ClassName` path). This is what lets a DI container instantiate by type, end to
  end: `resolve(C) = new C(...getMetadata("design:paramtypes",C).map(resolve))`.

## #4 step 23 (done — multi-module + a real type checker)
A Stackmix program can now span multiple files. The frontend compiles a **`ts.Program`**
(in-memory host, `noLib` so it's fast — ~0.8ms/program) and has a real **type
checker**. `multimodule.mjs` (11 checks) proves imports, namespacing, dependency
ordering, AND that a multi-module program migrates as ONE.
- `compileProgram(files, {entry, entryFile})` compiles an import graph into one
  PROGRAM. `compileModule(source)` is now a thin wrapper (single, unprefixed module
  — back-compat, the whole pre-existing suite stays green).
- Each module is **namespaced** (entry keeps "" so its entry-fn name is stable);
  the per-module compile logic is factored into `compileInto(sf, checker, opts)`
  threading a `prefix` applied to out keys, module-binding registry keys, and class
  unames. Single-module behaviour is identical (prefix "").
- **Imports resolve through the checker**: getSymbolAtLocation + getAliasedSymbol →
  the exporting declaration → its namespaced global. A module eagerly compiles its
  exports so importers reference them by name (fns via MAKECLOSURE, classes via
  their %builder/__construct__, consts via the per-tier registry).
- `new ImportedClass()` flows through the dynamic-construct path; imported
  `instanceof` and `design:paramtypes` resolve to the namespaced uname. **Cross-module
  inheritance** works: `classes` is SHARED across the program, so a derived class
  references an imported base compiled by the base's own module (top-level class
  methods capture only module bindings + `this`, so no cross-context closure issue).
- Module inits run in **dependency (topological) order** from a master "%moduleinit"
  (each module's init is `%init$<prefix>`); the entry runs after, all per tier.

## #4 step 24 (done — deref-miss re-runnability hardening, from PR #1 review)
A continuation can reference a remote heap object as a §5 handle; touching it where
it isn't resident makes `host.deref` return a Miss → the interpreter throws Suspend
(a deref-miss is an await on the fetch) and RE-RUNS the op from the same ip once the
value arrives. So every deref-touching op must touch the stack only AFTER the deref
succeeds, or the re-run sees a corrupted stack (lost args / shifted operands). Many
ops already did this (peek-then-deref); a PR review (gemini-code-assist) found the
rest didn't.
- Made **peek-then-deref** (were pop-then-deref): KEYS, DELPROP, DELINDEX, NEWPROXY,
  HASKEY, DEFMETA/GETMETA/HASMETA/METAKEYS/DELMETA, ISARRAY, CALLM/CALLMS,
  CALLDYN/CALLDYNS, CALLMETHOD/CALLMETHODS, ITER, GENNEXT/GENRET/GENTHROW.
- Added a **missing deref**: BIN (a handle OPERAND now resolves to its value, not the
  raw wrapper — `'' + handle`, comparisons), ITERNEXT (a remote iterator), AWAITALL
  (a remote array of promises).
- `approxExceeds` (stackmix-heap) was undercounting **Map/Set** (Object.keys(map) is []),
  so a huge Map/Set shipped INLINE instead of becoming a handle — now traverses
  entries.
- **This path is NOT a non-goal** (the README said so; corrected). The invariant is
  load-bearing and now tested directly: `probe-deref.mjs` makes a handle miss exactly
  once mid-op, asserts the op suspends, resumes, and keeps its args (11 checks; the
  test is non-vacuous — it fails against the old pop-then-deref code). Only the live
  fetch *transport* (cost model in stackmix-policy.mjs) remains unwired.

## Public API (stackmix-tsc.mjs)
- `loadModule(PROGRAM, source, {entry, resources})` — single module (existing).
- `loadProgram(PROGRAM, files, {entry, entryFile, resources})` — `files` is
  Map<absPath, source>; the rest mirrors loadModule.
- `compileModule` / `compileProgram` return the frag without mutating a PROGRAM.
- Test suites (all in `test.mjs`): `difftest.mjs` (vs Node, completeness),
  `conformance.mjs` (fidelity + migration), `decorators.mjs` (vs TS transpile),
  `multimodule.mjs` (imports + migration), `probe-deref.mjs` (deref-miss
  re-runnability). difftest 214/217, conformance 77, decorators 25, multimodule 11,
  probe-deref 11.

## Documented caveats (intentional — affect only buggy/exotic code)
- **TDZ non-enforcement**: reading a let/const before its decl yields undefined, not
  a ReferenceError (would cost a sentinel check on every let/const read).
- **Dynamic accessor keys**: `Object.defineProperty` accessors / computed-name
  accessors aren't fired by a *static* `obj.x` read (those are branchless); computed
  access `obj[k]` works. Belongs with a future reactivity push.
- **Dynamic `new` / `Reflect.construct` target TOP-LEVEL classes** (a local class's
  methods can close over enclosing scope the class-object builder can't reach); the
  inline `new LocalClass()` path is unaffected.
- **emitDecoratorMetadata across *imported type aliases***: same-module + imported
  *classes* resolve via the checker; following an imported `type X = ...` alias to its
  ultimate type would need deeper checker use. Class types (the DI case) work.

## Pick up here (next)
- **Sample app** (the agreed next direction, after a PR): a small Nest/Angular-shaped
  app SPANNING FILES — DI graph, decorated controllers/providers, a request that
  migrates mid-handler. Goal: shake out what real framework code hits now that
  imports + decorators + DI work. Likely surfaces: lifecycle hooks, async providers,
  guard/interceptor chains, request scoping.
- **Remaining ES-module surface**: default exports (`export default`), `export *` /
  re-exports (`export { x } from`), namespace imports (`import * as M`). Current
  support is named imports/exports of fns/classes/consts. The import resolver is
  checker-based so these are mostly wiring in `compileProgram`'s declRef + emitImport.
- **Source maps** (still open, §10.6): every IR instruction already carries a TS
  position (lineColOf → describeContinuation); the unfinished part is real
  file/line metadata surviving into a portable map. Design in, don't bolt on.

## Don't forget
- **Source maps**: NJS captured the stack but deferred line/file metadata. Our
  §10.6. Design it into the transform from the start, don't bolt on.
- **Heap deref shape** (from the email; informs #2 now): a deref consults an
  invalidating cache and resolves three ways —
  `local? use master : movable-data? fetch (+cache) : pinned-resource? migrate`.
