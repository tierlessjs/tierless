# Stackmix — the live two-tier walkthrough

This is the framework end to end: a single codebase, written as if it ran in one place,
that **runs fluidly across a browser tier and a server tier**, using a serialized
continuation to bridge them. No GraphQL, no hand-written client/server split, no
hand-written state machine — the server API is *just function calls*, and the
React-style render starts on the server and finishes in the browser the instant the
vdom touches the real DOM.

The same continuation crosses **a real websocket** into **real headless Chromium**
(Playwright), commits to the **real DOM**, takes a **real click**, and migrates back to
the server for the next data call.

## What it proves

`demo.mjs` runs one task-dashboard app across two tiers and prints the migration trace:

```
  server  api.getTasks({"status":"all"})        ← render starts on the server
  server  api.getStats()
  ── migrate → browser (dom.commit)              ← continuation serializes, crosses the socket
  browser dom.commit  «Tasks 5 tasks · 20% done · todo 2 / doing 2 / done 1 …»   ← real Chromium DOM + real click
  ── migrate ← browser (api.getTasks)            ← bounces back the instant it needs server data
  server  api.getTasks({"status":"done"})
  …
=> session ended
```

A scripted user drives **real Chromium interactions** — clicking filter buttons, cycling
a task's status, *typing into a real `<input>`* and clicking "+ add", deleting a row. Each
produces a serializable event token that resumes the continuation. The stats recompute
correctly across the boundary every time (cycle → `todo 1 / doing 3`, add → `6 tasks /
17%`, delete → back to `5 tasks / 20%`), proving app state lives in the continuation's
frame locals, pinned to neither tier.

## The developer's code

The whole app is written as straight-line logic — `app/App.src.js`:

```js
function App() {
  let filter = "all";
  while (true) {
    const tasks = api.getTasks({ status: filter });   // server resource
    const stats = api.getStats();                     // server resource
    const vdom = render(h(Dashboard, { tasks, stats, filter }));
    const ev = commit(vdom);                          // browser resource — suspends here
    if (ev.ev === "filter") filter = ev.value;
    else if (ev.ev === "add") api.addTask({ title: ev.title });
    else if (ev.ev === "cycle") api.setStatus(ev.id, ev.next);
    else if (ev.ev === "delete") api.deleteTask(ev.id);
    else break;
  }
  return "session ended";
}
```

There is **no** `async`, no `fetch`, no client/server boilerplate, no state machine, no
hooks. `api.*` and `commit()` look like ordinary calls.

## How it works

1. **Allow-list + tier-split compile** (`transform.cjs`). An allow-list pins namespaces
   to tiers (`api.*` → server, `commit()` → browser). The compiler rewrites each pinned
   call into a tier-named resource request and lowers the whole function into a
   **serializable state machine** — a `while(true) switch(F.pc)` whose locals live on an
   explicit frame object `F`. Output: `app/bundle.gen.mjs` (committed, so the demo runs
   without the Babel toolchain). This is the V8-native analog of asyncify: the
   continuation is plain data, no native stack. **All ordinary control flow is covered**:
   sequence, `if/else`, `while`/`for`/`do-while`, `break`/`continue` (incl. **labeled**),
   `return`, `throw`, `switch`, `&&`/`||`/`??`/`?:`, `try/catch/finally`, an early
   `return`/`break`/`continue` **out of a `try` — running every crossed `finally` in order
   on the way** (completion records: `F.__c` + `__unwindStep`), and **calls between
   functions** — **including a resource that fails on another tier being caught by a
   `catch` up the call stack in the migrated code**, because the handler stack (`F.__h`)
   rides along in the serialized continuation. A suspension may appear in **any** position:
   expression (`return f(x)`, `out = api.get()`, `a + f(x)`, `g(api.h())`), `if`/`while`/
   `switch` tests, `for`-init/test/update and `do-while` tests (loop headers desugar so the
   suspension moves into the body), and conditional positions (`cond ? api.a() : api.b()`,
   `x || api.y()` — lowered to if-statements so only the taken branch runs). An ANF pass
   hoists each into a frame temp in evaluation order before lowering. (`control-flow.mjs`
   proves each — 26 cases — survives a wire round-trip at every suspend.)

   **Suspendability is inferred.** A function is compiled into a state machine only if it
   (transitively) touches a tier-pinned resource; pure single-tier helpers (here `render`,
   `h`, the components) are left untouched and called synchronously. A call from one
   suspendable function into another becomes a **CALL op that pushes a sub-frame** — so the
   continuation is a *stack* of frames that spans call boundaries. In this app, `App` calls
   the suspendable `loadView`, so a real run carries an `[App, loadView]` stack.

2. **One pump, two tiers** (`runtime.mjs`). `pump(stack, ownsHere, execHere)` steps the
   machine, pushes a sub-frame on a CALL, runs every resource the local tier owns inline,
   and **stops at the first resource it doesn't** — returning the whole (possibly
   multi-frame) frame stack to ship. The same pump runs on both sides; only "what do I own"
   differs. Errors unwind across frames, so a callee's failure reaches a caller's `catch`.

3. **Real transport** (`transport.mjs`, the project's own). The continuation serializes
   through the **binary wire codec** (`wire-binary.mjs` — type tags + varints + a string and
   a shape table over the identity/cycle-safe graph codec) and crosses a real `ws` socket as
   one binary frame via `wsPort`/`makePeer`. The boundary is a true serialize/deserialize —
   no shared memory — so a separate process or machine resumes it identically. (A readable
   JSON form, `encodeWire`, is kept for debugging.)

4. **Real DOM + real clicks.** Two browser tiers are included:
   - `demo.mjs` — a scripted, deterministic run: a Node+Playwright tier paints the vdom
     into Chromium with `setContent` (onClick **event tokens** — plain objects, never
     closures — carried as `data-ev` attributes) and drives clicks, so the demo asserts an
     exact session end to end.
   - `server-live.mjs` + `public/client.mjs` — a **live, human-clickable page**: the same
     `pump` runs IN the browser tab, builds the DOM with `document.createElement` and real
     `el.onclick` handlers, and parks the continuation on a real human click. Open the URL
     and click. `verify-live.mjs` drives this live page headlessly with real Chromium
     clicks.

5. **§5 distributed handle heap** (`heap.mjs`, `heap-live.mjs`). Small locals travel with
   the continuation; a **big** local stays on its owning tier as an opaque handle
   (`{owner, id}`) and is fetched only if the other tier actually touches it — the
   *stack-smaller-than-heap* win (design.md §5). `encodeWire` flattens each frame's locals
   into individual roots so a big one excises into the tier's versioned heap while the
   frame skeleton stays tiny; the project's `Heap`/`Channel`/`makeHost`
   (`fetch.mjs`) provide fetch-on-deref with **single-writer** coherence (owner
   is master, bumps a version on mutate, readers hold a version-invalidated snapshot cache).
   Wired into the live two-tier pump over a **real `ws` socket** (`heap-live.mjs`): a 1.1 MB
   dataset crosses the commit migration as a **452-byte handle** and is fetched back over
   the same socket only when the browser derefs it (the §6 fetch path).

6. **Transparent deref** (`--auto-deref`, `heap-auto.mjs`). The developer writes ordinary
   `rows[i].title` — no `deref()` call. Compiled with `--auto-deref`, the machine guards
   each read of a data-resource local with `if (isHandle(rows)) rows = deref(rows)`, so the
   first touch on the tier where it arrived as a handle fetches it and materializes it in
   place (later touches are cheap checks). On the owning tier the guards are no-ops — this
   is deref-on-touch, in the compiled continuation.

7. **Write-back coherence** (`heap-writeback.mjs`). The §5 heap was single-writer (readers
   held snapshots and never wrote). This lifts it to single-**master** with optimistic
   concurrency: a reader that mutated a fetched snapshot proposes it back under the version
   it read (a compare-and-set). The master accepts only if no one bumped the version in
   between, so a stale write is rejected as a conflict and the writer refetches (now seeing
   the winner's change), re-applies, and retries — no distributed locks, no lost updates.
   `writeBack` is the owner-side CAS; `commitWrite` is the reader-side retry loop. The probe
   shows two writers racing (one rejected, refetched, retried; both edits survive) and the
   helper resolving an injected race in two tries.

8. **§6 migrate-vs-fetch, live** (`policy-app.src.js` → `policy-app.gen.mjs`, `policy-live.mjs`).
   At a pure-**data** foreign resource the driver has a real choice: ship THIS continuation
   to the resource's tier (migrate — the working set travels), or pull the resource's data
   back over the socket and finish where it is (fetch — only the result travels). It prices
   both options with **real measured bytes** and picks the cheaper one (design.md §6), then
   actually performs the chosen path over the **real `ws` socket**, so the bytes that cross
   are the bytes it priced. Two regimes show the flip: a tiny continuation + a big page →
   migrate (337 B continuation beats a 107 KB fetch); a big working set + one small fact →
   the **flip**, where the cold "always migrate" rule would ship 96.9 KB but the informed
   rule fetches **23 B** and stays put (a 4312× saving). Result identical either way; the
   informed sizes come from a one-time profiling sample that's locked in (§6 "sampling, not
   always-on").

9. **Transparent write-back** (`--auto-writeback`, `heap-write.src.js` → `heap-write.gen.mjs`,
   `heap-write.mjs`). The symmetric partner of transparent deref (item 6): the developer
   writes an ordinary mutation `rows[i].score = v` — no `deref()`, no `writeBack()`. Compiled
   `--auto-deref --auto-writeback`, the machine guards each *read* of the data-resource local
   (fetching it on the tier where it arrived as a §5 handle) **and** emits a write-back after
   each member *mutation* through it, propagating the edited snapshot to the owning master
   under optimistic CAS (item 7). The probe shows a browser-side `rows[2].score = 777` fetch
   the dataset once, edit it, and make the **server master coherent** (the edit lands on the
   owner, its version bumps so other tiers invalidate, the rest of the dataset survives
   intact) — with no `deref`/`writeBack` in the source. On the owning tier the read guard and
   write-back are no-ops/local. Reads auto-fetch on touch; writes auto-propagate on mutation.

## Files

| file | what |
| --- | --- |
| `app/App.src.js` | the developer's code: plain functions (`App` calls the suspendable `loadView`), no tier split |
| `app/components.mjs`, `app/h.mjs`, `app/render.mjs` | presentational components → serializable vdom (no React dep) |
| `app/api.mjs` | the "server module": a file-backed task DB (`getTasks`/`getStats`/`addTask`/…) |
| `transform.cjs` | the allow-list + state-machine compiler (App.src.js → bundle.gen.mjs) |
| `app/bundle.gen.mjs` | **generated** continuation bundle (committed; demo runs without Babel) |
| `runtime.mjs` | `pump` — the one tier-agnostic continuation driver + the wire codec + resource-error routing into `catch` |
| `dom.mjs` | vdom → real HTML with `data-ev` event tokens (used by `demo.mjs`) |
| `demo.mjs` | scripted two-tier run: `ws` server tier ↔ Node+Playwright Chromium tier |
| `server-live.mjs` | the live page server: http static + `ws`, drives the continuation |
| `public/client.mjs` | the live **browser** tier — runs in the tab, real DOM + real `onclick` |
| `public/transport.mjs` | browser-safe transport (the 4 transport fns, same as `transport.mjs`) |
| `verify.mjs` | headless regression (no browser/socket); asserts the compiled session — in `npm test` |
| `cf-fixtures.src.js` → `cf-fixtures.gen.mjs` | control-flow test functions and their compiled bundle |
| `control-flow.mjs` | headless regression for loops/continue/try-catch-finally across migration — in `npm test` |
| `heap.mjs` | §5 distributed handle heap: frame-flattening tier-aware wire + `Heap`/`Channel`/`makeHost` reuse |
| `heap-probe.mjs` | headless proof: big locals stay home as handles, fetched on deref, single-writer coherent — in `npm test` |
| `heap-app.src.js` → `heap-app.gen.mjs` | a big-data Report (explicit `deref`) for the live heap demo |
| `heap-live.mjs` | the §5 heap over a **real `ws` socket**: dataset stays server-side, fetched on deref — in `npm test` |
| `heap-auto.src.js` → `heap-auto.gen.mjs` | the same Report with **no `deref()`** (compiled `--auto-deref`) |
| `heap-auto.mjs` | proof of **transparent deref**: ordinary `rows[i]` auto-fetches a handle on touch — in `npm test` |
| `heap-writeback.mjs` | proof of **write-back coherence**: optimistic CAS, conflict → refetch + retry, no lost updates — in `npm test` |
| `heap-write.src.js` → `heap-write.gen.mjs` | ordinary `rows[i].x = v` (no `deref`/`writeBack`), compiled `--auto-deref --auto-writeback` |
| `heap-write.mjs` | proof of **transparent write-back**: a browser edit auto-propagates to the server master under §5 CAS — in `npm test` |
| `policy-app.src.js` → `policy-app.gen.mjs` | a Survey that builds a working set then needs a server data resource (the §6 boundary) |
| `policy-live.mjs` | **§6 migrate-vs-fetch over a real socket**: prices both from real bytes and steers what crosses — in `npm test` |
| `verify-live.mjs` | headless check of the live page via real Chromium clicks (run on demand) |

## Running

```sh
node src/verify.mjs        # headless: drives the compiled bundle, asserts the session
node src/control-flow.mjs  # headless: loops/continue/try-catch-finally survive migration
node src/demo.mjs          # scripted two-tier run: real websocket + real Chromium
node src/server-live.mjs   # LIVE page — open the printed URL and click the dashboard
node src/verify-live.mjs   # headless drive of the live page with real Chromium clicks
```

The headless regressions — `verify.mjs`, `control-flow.mjs`, and the heap/policy probes
(`heap-probe.mjs`, `heap-live.mjs`, `heap-auto.mjs`, `heap-writeback.mjs`, `heap-write.mjs`,
`policy-live.mjs`) — run as part of `npm test` (no browser needed). The
Chromium runs (`demo.mjs`, `server-live.mjs`, `verify-live.mjs`) need Playwright; this repo
env ships it pre-installed (`PLAYWRIGHT_BROWSERS_PATH`), resolved from the global install —
override the resolver root with `PLAYWRIGHT_REQUIRE` if needed.

Regenerating the bundles needs the Babel toolchain (not a runtime dependency):

```sh
npm i -D @babel/parser@8 @babel/traverse@8 @babel/generator@8 @babel/types@8
node src/transform.cjs src/app/App.src.js src/app/bundle.gen.mjs
node src/transform.cjs src/cf-fixtures.src.js src/cf-fixtures.gen.mjs --bare
node src/transform.cjs src/policy-app.src.js src/policy-app.gen.mjs --bare
node src/transform.cjs src/heap-write.src.js src/heap-write.gen.mjs --bare --auto-deref --auto-writeback
```

## Caveats / not-yet

- `transform.cjs` covers all ordinary control flow with suspensions in any position (see
  the list above), all serializable and migrating across tiers. The two remaining limits
  are deliberate, not control-flow gaps: (1) a suspension in the *conditional* part of an
  optional chain (`obj?.m(api.x())` / `a?.[api.x()]`) throws a clear error — lift it to a
  statement (the suspendable *base*, `api.get()?.x`, is fine); (2) the source is a plain
  function — `async`/generator source is unnecessary here because tier calls suspend
  implicitly, so it's intentionally unsupported rather than a missing feature.
- Render runs wholesale on the server and the browser only commits. Splitting render
  itself across tiers (per-component continuation identity) is the larger follow-on.
- The §5 handle heap runs over the live `ws` socket (`heap-live.mjs`); reads auto-fetch on
  touch (`--auto-deref`, `heap-auto.mjs`) and writes auto-propagate on mutation
  (`--auto-writeback`, `heap-write.mjs`); the §6 migrate-vs-fetch *policy* (ship the
  continuation vs fetch the data) is consulted by the live driver (`policy-live.mjs`), which
  prices both from real bytes and steers what crosses the socket. Remaining heap refinements
  are optimizations, not gaps: the deref guard re-checks each read past a hop because a round-trip
  migration can re-excise a big local back into a handle (so it's *correct*, not merely
  pessimistic; a liveness pass prunes the guards a straight-line run makes redundant, re-guarding
  after any hop or join — `test/probes/deref-liveness.mjs`), a write-back ships the whole edited
  object rather than a field-level diff, and the §6 fetch-size profile is sampled once and locked in
  (no online re-profiling — by design).
- Cross-tier **shared mutable state** has the design's full answer now: read-mostly via
  single-master + version-invalidated cache; **write-back** — a reader's mutation propagating
  to the owner — via optimistic version-checked CAS (`heap-writeback.mjs`: conflicts detected,
  refetch + retry, no lost updates); and it's **transparent end to end** — the developer
  writes ordinary `obj.field = v` and the compiler inserts the deref + CAS-write-back
  (`heap-write.mjs`), symmetric with reads.
