# The §6 migrate arm for compiled methods

Status: slices 1-2 shipped and proven (probe + live e2e + vite emit); slice-3 MECHANICS shipped (dynamic call parks, class-stamped handles, session twins, frame-aware fetch arm). The §6 decide loop is now LANDED in the shipped host's full-tierless drive path (host.mts `drive` + `placement`; see "LANDED" below) — fetch a first-class protocol message the driver prices against migrate per park. Closures in React components and hooks compile too (`closures`), a borrowed service's calls run on a session twin through the caps view's member handles, borrowed primitives and untaken branches don't send a chain home, and a profiled comparison run is measured end to end on Keycloak (ports/keycloak/README.md, "Chain migration"). Remaining: symmetric step-side fetch. The fetch arm (host.mts runLocal) stays the
default and the cold fallback; this document is the delta that lets a compiled method's
continuation MIGRATE to the server and run its request chain there — N crossings become 1.

## Why (measured)

The suite-at-the-socket runs (ports/vikunja/results/truth-*.jsonl, rtt80-*.jsonl):
bytes −35% median per test, trips −22% median — but wall time ±1% under real 80 ms RTT,
because every service call is still one crossing paying one RTT. Vikunja's
abstractService methods each make exactly ONE http call, so the chains that matter are
in callers (Pinia store closures: createNewTask → create + per-label create;
toggleFavorite → update + reload; project open → project/views/tasks). Slice 1 builds
the mechanics on class methods (the compiled surface we have); slice 3 widens the
compiled surface to those callers.

## The blocker the fetch arm dodged, solved with §5

A method frame holds live tier-owned values: `__self` (service instance — axios
instance, interceptor functions, sometimes a reactive proxy) and function locals
(`cancel` from setLoading). They cannot cross. The fetch arm's answer was "never ship
the frame". The migrate arm's answer is §5, applied by OWNERSHIP, not size:

- **Encode (leaving home):** any frame root that `ownsValues()` flags (functions,
  FormData/Blob — and therefore every service instance, via its interceptor functions)
  is excised into the local tier heap and crosses as a `{__tierless_handle__, owner, id}`
  leaf. The codec's handle slot tag and heap already exist (wire-binary.mts, heap.mts);
  what's new is excise-by-ownership (today's excision is size-threshold only).
- **Decode (coming home):** a handle whose `owner` is the local tier resolves back
  through `heap.get` to the SAME live object — master in place. The far side never
  resolves; it sees an opaque leaf.

## The pump rule: a segment may only run where its slots are real

The machine executes plain JS between parks — a segment that touches `__self` or
`cancel` cannot run on a tier where that slot is a handle, and sync code cannot suspend
mid-segment (design.md §8). So the check happens BEFORE the segment runs, in the pump:

- **Compiler metadata:** for each program, for each resume state, the set of frame
  slots the segment entered at that state references (computed on the LOWERED output —
  walk each switch case for identifiers naming frame slots). Emitted with PROGRAMS. A
  plain read of one member is recorded as that member (`args[0].id`), with a mode suffix
  for moves, computed access and writes (below); a call on a slot, or passing it to native
  code, records the whole slot. A branch whose two sides reference different slots is a
  **checkpoint** (it returns `{op:"check"}` once decided), so only the side taken counts;
  branches inside an in-step loop are not checkpoints.
- **Views:** an excised object (a closure's caps, a borrowed library instance, a big
  value) keeps its identity and its writes at home, but off its home tier it decodes as a
  VIEW: its own data as it shipped — primitives by value, nested objects and arrays as
  nested views, functions registered with `shareFunction` as this tier's copy, compiled
  closures as shipped closures — within a byte budget (`makeHost({ threshold })`, 8 KB);
  everything else (a function, a host object, a string or object over the budget) is a
  member handle; a RegExp is a value (source, flags, lastIndex). A class instance's view
  is marked `inst`: a member it lacks may be a prototype getter, so reading it parks —
  unless the class is registered here (`shareClass`; compiled classes are) and its
  prototype chain lacks the member too, which reads undefined. The compiler records what
  a segment reads, by mode: a member chain (`args[0].user.id`) stays when it reaches data;
  a read that only moves into a frame slot (`"="`: a test, a condition operand, a member
  of an object/array literal in a move statement) needs the chain to walk; a move through
  one computed level (`"[]="`) needs the object indexed to answer any key (a plain view or
  a local object, not an instance view); through more levels (`"[..]="`), or as a value
  (`"[]"`), the object reached must be complete; a value read of a view object, a call on
  it, or passing it to native code finds its handle and goes home.
- **Writable views:** a write (`"!"` names the member: `args[0].opts.sep!`; `"[]!"`
  through a computed key) lands on the view when the object written is a plain view, a
  local object, or a registered class's instance view whose prototype lacks the member (a
  setter would have run at home); anything else parks the write home. The view's writes
  since it arrived — members assigned or added (by identity), deleted, an array's new
  length — are diffed when the run leaves (`viewDelta`) and ride the crossing's graph, so
  a value shared with a frame slot is one object at home, and a handle stays a handle;
  the owner applies them as it decodes (`applyDeltas`), before anything reads them. Same
  model as session twins' deltas, same caveat: home code running meanwhile sees the old
  state until the crossing lands. `test/probes/views.mts` holds each case.
- **Shipped sync closures (`syncClosures`):** a `const f = () => …` in a class method —
  i18next's `getFixedT` returning `t` — compiles into a program over explicit caps
  (captures, `this` as `__self`; module-level code stays a free reference); the kept
  closure is a stub carrying program name and caps builder. The codec ships it as program
  + caps (slot `fn`) with its home identity: the far tier calls its own copy of the program,
  synchronously; a tier without that program gets an opaque handle instead (the stop rule
  parks the segment that would call it home); and coming home it is the original closure
  again, never a fresh one. A captured `let` a closure assigns is boxed first (`found.v`:
  the frame and the closure share one object through the graph); a closure that awaits,
  reads `arguments`, or is a function expression using its own `this` stays native. Every
  top-level class of the module is stamped (`shareClass`, module hash + name) so instances
  keep their class across tiers.
- **Module code by name (`moduleCode`, default on):** a component closure captures every
  outside binding into its caps — except module code it only CALLS: an import or a
  module-level function (`addTrailingSlash(url)`, `await fetchWithError(url, init)`) is
  the same on every tier that loads the module, so the program references it freely and
  the gateway's bundle carries it (vite.mts bundles the import; browser-bound modules it
  drags in are stubbed by `twinsStubs`, assets are empty). An awaited call of one is a
  park (`call:<name>`) the pump settles where the run is: this tier's function, a compiled
  one as a sub-frame, a handle home. Used as a value — passed on, a member read — an
  import stays a capture: a module singleton (a router, an i18n instance) is browser-owned
  and fences through the caps. Found by the gateway's park log (`TIERLESS_PARK_LOG`): 34
  of the 38 home parks on the Keycloak chain specs were loaders parking on a captured
  helper right after their first twin call — a migration that gained nothing.
- **Sync calls of values (`syncCalls`, `syncMethods`):** a synchronous call of a value a
  segment holds — a captured `t(k)`, `this.translate(k)`, `lib.get(k)`, `h.call(this, k)`
  on a local arrow — lowers to a park the pump resolves where the run is: a shipped
  closure's or a compiled class's program as a sub-frame (its segments under the stop
  rule), a session twin or a live object natively, or home with the call when an argument
  or the receiver is another tier's object (a few pure builtins — `Object.keys`,
  `Array.isArray`, `hasOwnProperty` — read a plain view directly). Under `syncMethods`
  every method of the module's classes and every module-level function is a program too.
  `fn.bind(self, …)` becomes a tracked bind (`bindTracked`): a bound method of a shared
  class ships as class + name + receiver and runs as the class's program over the
  receiver's view (i18next's `bindMemberFunctions`). `forEach`/`map`/`filter`/`some`
  callbacks inline as loops of the method's own code (a native fallback stays for
  non-arrays).
- **Value twins:** inside a shipped closure's caps the engine chooses data or stack per
  value: a stamped instance that holds only data (no function but a compiled closure whose
  caps are data too, no host object, accessor or handle anywhere in it) and fits the
  threshold ships whole (slot `o` + `tw`, its home identity); the copy is tracked like a
  session twin — its writes ride home as deltas, and it goes home as the original.
  Otherwise it excises and the stop rule parks the calling segment home. The receiving
  tier re-checks the promise over the slot graph (§7: a copy that would hide a foreign
  handle, or a closure it can't run, decodes as its handle) — `test/probes/value-twins.mts`
  holds these invariants over 400 random graphs. `makeHost({ threshold })` is the policy
  knob. Measured on a reduced i18next shape
  (`test/probes/sync-closures.mts`): a 3-key instance ships in 376 B and a chain calling
  `t` between two twin calls is one crossing instead of two; a 3,001-key instance stays
  home at the default 8 KB and ships (211 KB) at 1 MB.
- **Hydration:** when a migrated stack arrives, a view member (a nested instance view,
  or a member handle carrying the instance's data fields) that has a session twin here
  becomes the twin itself (`hydrateViews`). Plain code the machine runs — an inline
  `async p => await client.x(p)` handed to `Promise.all` — then calls the twin natively,
  and the stop rule sees a live object, so a list-then-fan-out loader is one crossing.
  Twins' field changes are diffed once per crossing; a twin that escaped into a local is
  encoded back as its member handle going home.
- **Pump stop rule:** before stepping a frame, if any slot referenced by the current
  state holds a handle → park with `{op:"home", tier: handle.owner}` and ship the stack
  there. The pump stays tier-agnostic: no configuration, the VALUES say where segments
  can run. This covers the normal path and error unwind identically (a catch/finally
  that calls `cancel()` parks home before executing — getAll's finally does exactly
  this).
- **Carry home:** the stack that parks home after a serviced request carries the value
  in `frame.ret` (already part of the encoded frame); ship `(stack, null)` — the
  existing resume path pumps straight on from `ret`. No new message type; no re-servicing.

### The i18next experiment (2026-11-01): the real `t()` runs on the gateway

Goal: `t()` called mid-chain with no port code. The real i18next ESM compiles with
`syncClosures + syncCalls + syncMethods` (220 programs: every class method, every
module function, every closure — one stays native for assigning a parameter) and its `t`
translates Keycloak's 4,170 keys identically through the stub
(`test/probes/sync-closures-i18next.mts`). A dialog that calls `t()` for three keys
between two gateway calls, with the instance excised as a view:

| threshold | crossings | shipped | where `t()` ran |
|---|---|---|---|
| 8 KB (default) | 2 | 15 KB | home: the 337 KB table is a member handle, `resolve` parks at it |
| 4 MB | 1 | 338 KB | gateway: `translate → resolve → interpolate` over the view, no copy |

What the chain needed, each found by tracing the park and fixed generally (above): moves
into literals and conditions, a registered class's missing members, a RegExp by value,
writes to the view (`resetRegExp` rewrites three regexps per call — the same objects, so
no delta), one-level computed reads, boxed captured writes (`nest`'s `handleHasOptions`),
`call`/`apply` on arrows, and `bindMemberFunctions`' bound methods. Not measured on
Keycloak: no compiled Keycloak program calls `t()` before a later server call. The table
ships on every crossing at 4 MB; shipping it once per session (content addressing) is
the next step for that arm.

## Protocol shape (no new messages)

Browser runLocal grows a migrate branch: at a park it may ship `(stack, request)` as a
`resume` to the gateway instead of exec-carrying. The gateway host — which for compiled
app modules today is EXEC_ONLY — gains the module's real machine (vite emits a server
bundle for compile targets into the dist-tierless manifest, as it always did for
workflow modules; §7 posture unchanged: the server runs its OWN build's code, incoming
stack state is untrusted data). The gateway pumps with the twin exec: http.* requests
service locally against the backend; when the pump hits the stop rule it ships the
stack home; `done` returns the value. Pinned requests (FormData, blob, progress
callbacks) never migrate — the ownership scan on the REQUEST already pins them to the
fetch-arm local path, unchanged.

## §6 decide (slice 2)

Cold default: fetch arm (stay put) — migrating on no evidence is the "effectively
infinite" cost of design.md §6. The trajectory machinery (trace.mts recorder, profile
artifact, decide()) prices the choice per call path: a path whose profile shows ≥2
server-priced resource touches before any home-parking segment migrates; everything
else keeps exec-carrying. Comparison runs use a locked profile; profiling runs, not
comparison runs, do the exploration (run protocol, docs/corpus.md).

### LANDED in the shipped host (full-tierless drive path)

The §6 decide loop now lives in `makeHost`'s `drive` (host.mts), not in a test driver.
Pass `placement: { profile, mode }` to `makeHost`; at every park `drive` prices the REAL
shipped bytes against the profile and either MIGRATES (ships the continuation as
`type:"resume"`) or FETCHES (pulls just the value as `type:"exec"`, the fetch arm, and
resumes the stack at home via a carry). A §5 home park and a cold/unpriced site keep the
floor — migrate — so a host with no `placement` behaves exactly as before (proven: the
whole suite is unchanged). Proof it reproduces the hand-rolled driver byte-for-byte:
test/e2e/trio-live.mts §3a runs Trio through `host.run` with a locked profile and counts
the real protocol — greedy emits 3 `exec` + 0 `resume` (19.7 KB), trajectory 0 `exec` +
1 `resume` (8.5 KB, 57% less), identical to the driver's own numbers below. Scope: the
decision is made by the DRIVING side (`drive`); the answering `step` still always suspends
— symmetric step-side fetch (a migrated continuation that parks back at a driver resource)
is the next increment, rarer than the primary browser-drives-server case.

## Slice plan

1. **Mechanics** (in progress): codec excise-by-ownership + decode-resolve-at-owner;
   compiler per-state slot metadata; pump stop rule; vite server emit for compiled app
   modules; browser migrate branch behind an explicit opt (no pricing yet). Proof: a
   fixture class whose method chains two http calls — 2 crossings → 1 — plus unwind
   (finally with a function local) and single-call parity, live over a real socket.
2. **decide()**: profile-driven fetch-vs-migrate at the park site; frozen for
   comparison runs.
3. **The app's real chains**: compile the Pinia store functions that orchestrate
   multi-call sequences (closures over reactive refs → §5 handles, same stop rule).
   This is where the RTT verdict should finally move.

## Slice-3 ground truth (read from their code, 2026-07-07)

- The project-open read chain (project → views → tasks) is NOT a function in their
  code — it emerges from router + component composition (useTaskList's loadTasks makes
  exactly one getAll). No compile surface can batch it without rewriting intent, which
  is the retired shadow approach. State this in the results; it is the honest §6
  finding about where batching lives.
- The single-function chains that DO exist are store functions, mostly writes:
  createNewTask (create + per-label creates), toggleFavorite (update + loadAllProjects),
  saved-filter favorite (get + update), kanban bucket flows. Chain length 2-3: each
  migration saves 1-2 RTTs on those interactions. Expectation for the final shaped
  runs: movement on chain-bearing specs, not the suite median.
- Store functions suspend on COMPILED-METHOD CALLS (taskService.update(...)), not on
  this.http.*. So slice 3 is method-to-method suspendability:
  1. compiled method stubs carry `__tierless_program`; lowering `await x.m(a)` emits a
     DYNAMIC call park — at runtime, if x.m names a program, push its frame
     (op:"call" with runtime fn, args [x, ...a]); otherwise a new op:"await" parks the
     plain promise and the pump awaits it in place (promises never cross: they sit in
     ret through a same-segment await, and a promise in a slot is ownedUnit — the stop
     rule parks home before any segment could touch it elsewhere).
  2. setup-closure extraction: functions inside defineStore(name, () => {...}) with
     tier-reaching awaits compile with their free setup-scope bindings rewritten to
     __caps.<name>; the stub passes a caps object (const bindings as plain properties —
     Vikunja's setups are const-heavy; let-bindings need getter/setter). The caps
     object is ownedUnit (refs/instances inside) — it excises whole, and segments
     touching __caps park home, exactly like __self.
  3. the twin applies the app's pure request-interceptor transform for writes (option
     (a) below): Vikunja's is objectToSnakeCase from '@/helpers/case' — pure, importable
     into the machine bundle.

### The dispatch problem (and its §5 answer): op:"dyn" in the PUMP

A dynamic call park that reads `recv[member].__tierless_program` needs the LIVE
receiver — but a migrated caller holds a §5 handle, so the slot rule would park every
method-call segment home: one crossing per method, no better than the fetch arm. And
even pushing the callee's machine server-side would thrash: their service methods'
prefixes read live instance state (this.paths, getReplacedRoute), fencing every
call home anyway. Both problems fall to one move — dispatch in the PUMP, which holds
PROGRAMS, isHandle, and (new) a session TWIN REGISTRY:

- `await x.m(a)` lowers to `yield D(x, "m", a)` → the machine returns
  `{ op:"dyn", recv, member, args }`. The pump resolves it:
  1. recv is a class-stamped handle and the registry has a twin for that class →
     call the TWIN INSTANCE's method and settle the promise in place. The twin is a
     server-side instance of THEIR OWN class (fetcher made Node-safe), so the real
     request-interceptor chain runs — the interceptor wall disappears, self-touches
     are twin-local, and an N-call store chain is genuinely ONE crossing.
  2. recv is live and m is a stamped stub → push the callee's frame (nested machine).
  3. recv is live and uncompiled → settle `recv.m(...)` in place (this also covers
     `await Promise.all(...)`, `await response.blob()`, and every other awaited
     member call — they never cross).
  A class-stamped handle with NO twin and no program parks home (op:"home") and
  re-dispatches live.
- The compiler stamps `Cls.prototype.__tierless_cls = "Cls"` beside the stub program
  names; ownership excision copies it onto the handle (`h.cls`); the wire carries it
  as one optional interned string on the handle slot.
- The slot scanner strips the dyn term's `recv:` expression before scanning (the
  dispatch is handle-aware by construction); argument expressions stay scanned.
- Twin-instance state divergence is real (their services mutate this.totalPages,
  loading flags — reads of those on the browser instance after a twinned call would
  miss the mutation), so twin rebinding is OPT-IN PER CLASS in the app port, declared
  where the twin registry is built.

### VALIDITY NOTE on the 2026-07-07 profile verdict (found 2026-07-07, later)

The "3,916 runs, 3 chains, nothing stable to batch" verdict was profiled against a
work-tree build whose vite.config predated the stores-compile patch (APPLIED-tracking
drift: patch 0006 was updated in the repo but never re-applied to the tree — no store
was compiled, and no dist-tierless was emitted at all). It is a valid profile of the
SERVICE-METHOD surface only. Whether compiled STORE functions (toggleFavorite,
createNewTask, kanban flows) show stable chains is unmeasured until the rebuild with
stores + twins; the re-profiling on that build supersedes this verdict either way.

### Crossing parity without twins (measured expectation, 2026-07-07)

Vikunja's store chains call SUBCLASS instances (new TaskService()), which the
correctness guard leaves unstamped — their dyn parks dispatch at home. Per method:
one ship-out + one park-home = one round trip, exactly the fetch arm's exec round
trip. So WITHOUT twins the comparison run should show crossing/wall PARITY on store
chains (no regression — the §6 profile simply can't win here), and the whole
wall-time case for this app rides on the TWIN registry:
- app patch stamps the twinned subclasses (Cls.prototype.__tierless_cls) so handles
  carry their real class;
- a server-only twins module constructs THEIR service classes per session (fetcher
  Node-guarded: axios.getAdapter('xhr') behind typeof XMLHttpRequest; window.API_URL /
  localStorage.getItem(token) shimmed per session — single-session-safe for the
  measurement harness, a real lease design for production);
- gateway session() returns twins from it (TIERLESS_TWINS -> module path), so an
  N-call chain settles N methods server-side in ONE crossing with their own
  interceptors — the interceptor wall solved by construction.
Divergence audit before enabling a class: compiled store flows must read only
RETURN VALUES of twinned calls (loadTasks/update/toggleFavorite do; anything reading
instance state after a call stays untwinned).

## Slice-3 wall, found early: interceptor semantics for calls 2..N

The fetch arm runs the app's request-interceptor chain browser-side per request
(crossHttpRequest). A migrated chain's later calls park server-side, where those
closures don't exist — Vikunja's per-service interceptor (objectToSnakeCase on the
model) would be silently skipped and the backend would reject the write. Options,
in current order of preference: (a) apply the pure part of the chain in the twin
by importing the same helpers server-side (they're pure module functions in this
app); (b) compile the interceptor functions themselves; (c) pin write-bearing
requests to the fetch arm and migrate only read chains — the profile can encode
that per-site today. Slice 1's fixtures don't have interceptors; this decision
gates slice 3, not the mechanics.
