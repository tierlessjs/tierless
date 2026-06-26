# Tierless React over a real browser/server boundary (proof of concept)

This validates the **primary** Stackmix goal on V8 (not the QuickJS track): a single
codebase, written as if it ran in one place, that **runs fluidly across a browser tier
and a server tier**, using a serialized continuation to bridge them. No GraphQL, no
hand-written client/server split, no hand-written state machine — the server API is
*just function calls*, and the React-style render starts on the server and finishes in
the browser the instant the vdom touches the real DOM.

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
   continuation is plain data, no native stack. Control flow covered: sequence, `if/else`,
   `while`/`for`, `break`/`continue`, `return`, `throw`, `try/catch/finally`, and **calls
   between functions** — **including a resource that fails on another tier being caught by
   a `catch` up the call stack in the migrated code**, because the handler stack (`F.__h`)
   rides along in the serialized continuation. (`control-flow.mjs` proves each of these
   survives a wire round-trip at every suspend.)

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

3. **Real transport** (`src/runtime/wss.mjs`, the project's own). The continuation
   serializes through the project's identity/cycle-preserving graph codec
   (`src/runtime/heap.mjs`) to a JSON string and crosses a real `ws` socket via
   `wsPort`/`makePeer`. The boundary is a true serialize/deserialize — no shared memory —
   so a separate process or machine would resume it identically.

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
| `public/transport.mjs` | browser-safe transport (the 4 transport fns from `wss.mjs`, no `core.mjs`) |
| `verify.mjs` | headless regression (no browser/socket); asserts the compiled session — in `npm test` |
| `cf-fixtures.src.js` → `cf-fixtures.gen.mjs` | control-flow test functions and their compiled bundle |
| `control-flow.mjs` | headless regression for loops/continue/try-catch-finally across migration — in `npm test` |
| `verify-live.mjs` | headless check of the live page via real Chromium clicks (run on demand) |

## Running

```sh
node experiments/react-tiers/verify.mjs        # headless: drives the compiled bundle, asserts the session
node experiments/react-tiers/control-flow.mjs  # headless: loops/continue/try-catch-finally survive migration
node experiments/react-tiers/demo.mjs          # scripted two-tier run: real websocket + real Chromium
node experiments/react-tiers/server-live.mjs   # LIVE page — open the printed URL and click the dashboard
node experiments/react-tiers/verify-live.mjs   # headless drive of the live page with real Chromium clicks
```

`verify.mjs` and `control-flow.mjs` run as part of `npm test` (no browser needed). The
Chromium runs (`demo.mjs`, `server-live.mjs`, `verify-live.mjs`) need Playwright; this repo
env ships it pre-installed (`PLAYWRIGHT_BROWSERS_PATH`), resolved from the global install —
override the resolver root with `PLAYWRIGHT_REQUIRE` if needed.

Regenerating the bundles needs the Babel toolchain (not a repo dependency, like emscripten
for `qjs-migrate`):

```sh
npm i -D @babel/parser@8 @babel/traverse@8 @babel/generator@8 @babel/types@8
node experiments/react-tiers/transform.cjs experiments/react-tiers/app/App.src.js experiments/react-tiers/app/bundle.gen.mjs
node experiments/react-tiers/transform.cjs experiments/react-tiers/cf-fixtures.src.js experiments/react-tiers/cf-fixtures.gen.mjs --bare
```

## Caveats / not-yet

- `transform.cjs` now covers sequence, `if/else`, `while`/`for`, `break`/`continue`,
  `return`, `throw`, `try/catch/finally`, and **calls between suspendable functions**
  (sub-frames; the continuation spans the call stack), all across suspends. Remaining gaps
  (the compiler throws a clear error rather than miscompile): a `break`/`continue`/`return`
  that **exits** a `try`, a suspendable call used as a **sub-expression** (assign it to a
  local first), `switch`, and labeled loops. `@babel/plugin-transform-regenerator` is the
  reference for the rest, onto this same explicit-frame model.
- Render runs wholesale on the server and the browser only commits. Splitting render
  itself across tiers (per-component continuation identity) is the larger follow-on.
- Cross-tier **shared mutable state** is left where the design notes put it: single JS
  event thread per session here, so there's one writer; coherence for concurrent sessions
  is the genuine deferred problem.
