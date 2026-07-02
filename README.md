# Stackmix

[![CI](https://github.com/bfulton/stackmix/actions/workflows/ci.yml/badge.svg)](https://github.com/bfulton/stackmix/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](./package.json)

**One program that runs across browser and server, with the runtime moving live
execution between tiers as needed — instead of you splitting it by hand.**

You write ordinary JavaScript with no tier annotations. A build step compiles each
function that touches a tier resource into a *serializable state machine*. When
execution reaches a resource the current tier doesn't own, the live continuation is
captured as plain JSON, shipped over a WebSocket to the other tier, and resumed
there. The big data stays where it lives; only the small continuation moves.

> **Status: research-stage.** The mechanism is proven end to end — a React-style app
> renders on the server, migrates into real headless Chromium to commit the DOM,
> takes a real click, and migrates back — but the API is pre-1.0 and Stackmix is not
> yet meant to run untrusted code across a trust boundary in production. See
> [`ROADMAP.md`](./ROADMAP.md).

## How it works

- **Resources are the boundaries.** An allow-list pins each tier call: `api.*` is the
  server tier, `commit()` / `dom.*` is the browser tier. Every tier call compiles to a
  single suspension point — the only place a migration can happen. Placement is
  *inferred* (you only leave a tier when forced) and decided at runtime.
- **The compiler turns plain functions into serializable state machines.**
  `transform.cjs` (Babel) lowers a function's control flow into a `while/switch`
  machine whose locals live on an explicit frame object `F` — no native stack, no
  closures captured in the continuation, so the continuation is plain JSON. A function
  that touches no resource is emitted verbatim and runs inline.
- **The continuation is data you own.** It's the live frame stack encoded through an
  identity-preserving, cycle-safe graph codec and shipped as one **compact binary frame**
  (type tags + varints + string/shape tables). A subgraph larger than a threshold
  becomes an opaque §5 *handle* into the owning tier's heap instead of being copied —
  the big dataset stays put and is fetched only if actually touched. Reads auto-fetch
  on touch (`--auto-deref`); writes auto-propagate back to the owner under optimistic
  CAS (`--auto-writeback`).
- **The runtime is one tier-agnostic pump.** The same `pump()` drives both tiers: it
  runs resources this tier owns inline and stops at the first foreign resource, handing
  the continuation across the socket. When the continuation is large and the data
  small, it can fetch the data instead of migrating — priced from real bytes (§6).
- **The program is untrusted client code — all of it, on every tier.** A migrating
  continuation can be forged, so authority never lives in the program: every `api.*` is
  serviced by a **reference monitor** in its own process (a local-pipe sidecar) that
  re-authorizes each call against a verified principal — the framework owns that contract
  (mandatory `authorize`, default-deny, a denial thrown back *into* the continuation,
  catchable across tiers); the transport is pluggable. The `dom.*` edge is the same shape
  with the user's own browser as the guard.

## Quick start

**Mix into an existing app** (Vite/React shown; the plugin is framework-agnostic — see
[`examples/react-vite`](./examples/react-vite)):

```js
// vite.config.mjs
import stackmix from "stackmix/vite";
export default { plugins: [react(), stackmix({ api: "./src/api.server.mjs" })] };
```

```js
// src/actions.mjs — "use mix" makes exported functions ACTIONS: plain calls from the
// page that run as migratable continuations, the api-heavy stretch executing on the
// server in ONE round trip, every call authorized by the reference monitor.
"use mix";
export function rebalance(holdings) {
  const orders = [];
  for (const h of holdings) {
    const px = api.getQuote(h.sym);              // server resource
    if (px > h.limit) orders.push(api.placeOrder({ sym: h.sym, qty: h.qty }));
  }
  return orders;
}
```

```jsx
const plan = useAction(rebalance);               // stackmix/react
<button onClick={() => plan.run(holdings)} disabled={plan.running}>Rebalance</button>
```

**Start fresh** — a running two-tier app in under a minute:

```bash
npm create stackmix@latest my-app
cd my-app && npm install && npm run dev
```

**Prove the claims** (this repo):

```bash
git clone https://github.com/bfulton/stackmix
cd stackmix
npm install
npm test          # runs every demo + probe headless and asserts the headline claims
npm run live      # the human-clickable two-tier page — open the printed URL and click
```

`npx stackmix explain src/actions.mjs` prints the compiler's analysis — which functions
become migratable machines and why, with every suspension point; `npx stackmix api
api.server.mjs` pre-ship-checks a service (an endpoint without `authorize` fails at load
time); `npx stackmix types api.server.mjs` emits the `declare const api` surface.

## The developer's code

The whole app is straight-line logic — [`test/demos/app/App.src.js`](./test/demos/app/App.src.js):

```js
function App() {
  let filter = "all";
  while (true) {
    const tasks = api.getTasks({ status: filter });   // server resource
    const stats = api.getStats();                     // server resource
    const vdom  = render(h(Dashboard, { tasks, stats, filter }));
    const ev    = commit(vdom);                       // browser resource — suspends here
    if (ev.ev === "filter") filter = ev.value;
    else if (ev.ev === "add") api.addTask({ title: ev.title });
    else if (ev.ev === "cycle") api.setStatus(ev.id, ev.next);
    else if (ev.ev === "delete") api.deleteTask(ev.id);
    else break;
  }
  return "session ended";
}
```

No `async`, no `fetch`, no client/server boilerplate, no hand-written state machine, no
hooks. `api.*` and `commit()` look like ordinary calls; the render starts on the server
and finishes in the browser the instant the vdom touches the real DOM.

## The evidence

`npm test` runs all of these headless and asserts their headline claims hold:

| proof | what it shows |
| --- | --- |
| `test/probes/codec.mjs` | the wire codec preserves identity, survives cycles, excises big subgraphs to §5 handles, and round-trips exotic values (undefined, BigInt) |
| `test/demos/verify.mjs` | the auto-compiled tier-split continuation reproduces the correct session across migrations |
| `test/demos/conduit-verify.mjs` | a larger, framework-shaped app — a RealWorld/Conduit reader with routing across three views (feed ↔ article ↔ editor), favorites, comments, a new-article form, and a server-side validation `throw` caught across the tier boundary — runs correctly as one compiled continuation |
| `test/demos/api-verify.mjs` | the trust boundary done right: the api is an external **reference monitor** in its own process (a local-pipe sidecar), `authorize` is mandatory at load time, and the principal is a signed token it verifies — so across a real forked process neither a forged continuation nor a forged token can escalate (authority is re-checked at every call, never inferred from control flow) |
| `test/demos/api-pump.mjs` | the monitor wired into the pump: a real compiled continuation migrates across tiers with every `api.*` serviced by the sidecar over the pipe — authorized per principal, a denial caught by the app's `try`/`catch` across the tier (same continuation, admin allowed / user denied) |
| `test/demos/api-live.mjs` | the monitor as the **default `api.*` path**: the Tasks app's DB lives in its own trusted service (`test/demos/api/tasks-fns.mjs`) which the demos fork as a sidecar — the pump host holds only a pipe and a per-session token. The real compiled App runs the full journey on the runtime's own `pump` through it; anonymous `PUBLIC` reads still render while an unauthenticated or forged write is **denied in the monitor's process** and thrown across the tier, and an oversize call is rejected by the args budget |
| `test/demos/control-flow.mjs` | loops, `break`/`continue`, labeled loops, `switch`, and `try`/`catch`/`finally` (including `return`/`break` across a `finally`) all survive migration |
| `test/probes/lang-coverage.mjs` | ordinary binding forms compile and migrate: `for`/`of`/`in`, destructuring (object/array/nested/default/rest, non-array iterables via an `Array.from` guard), default/destructured/rest parameters, and a suspension inside an **optional chain** (`obj?.[api.x()]` / `obj.m?.(api.x())` — short-circuit skips the tier call, `this` preserved, checked against a native-JS oracle) — each driven across a JSON round-trip of the continuation at every suspension. The one form that genuinely can't migrate — a tier call inside a callback/comparator/method, run synchronously by native code that can't suspend — is rejected with a clear compile error, not silently miscompiled |
| `test/demos/heap-probe.mjs`, `test/demos/heap-live.mjs` | a 1.1 MB dataset crosses a commit migration as a ~450-byte §5 handle and is fetched back over a real socket only when the browser derefs it |
| `test/demos/heap-auto.mjs`, `test/demos/heap-write.mjs` | transparent deref (reads auto-fetch on touch) and transparent write-back (a browser edit propagates to the server master under §5 CAS), with no `deref()`/`writeBack()` in the source |
| `test/demos/heap-writeback.mjs` | optimistic version-checked CAS: conflicts detected, refetch + retry, no lost updates |
| `test/demos/heap-write-delta.mjs`, `test/probes/wire-delta-fields.mjs` | a write-back IS a delta to the master, and the codec ships **per-field/element** patches — an object's changed keys, an array's touched indices, a Map/Set's set/deleted entries — applied in place under CAS, `min(delta, whole)` so it's never larger. A 6-way edit (incl. push/`Map.set`/`Set.add`) in a 1500-row dataset crosses ~94× smaller; the same patches sharpen the oscillation delta both directions |
| `test/demos/policy-live.mjs` | at a data boundary the driver prices migrate-vs-fetch from real bytes and steers what crosses (§6) — flipping to fetch a 23 B fact rather than ship a 97 KB continuation |
| `test/probes/wire-delta.mjs`, `test/probes/wire-delta-compiled.mjs` | the delta wire ships a capture as a patch over what the peer holds; `--track-writes` makes the compiler bump a version on every in-place mutation, so plain source ships only what changed — proven identical to a full re-scan, with Map/Set first-class |
| `test/probes/wire-content.mjs` | content-addressed immutable subgraphs: a registered config ships inline once then as a tiny hash reference (36 KB → 319 B), resolving to the copy the peer cached — identity by content. Carried through the **binary wire** (the socket frame) and composed with §5 excision + `min(delta, full)`, so a re-frame ships immutable code by hash, not re-inlined |
| `test/demos/delta-live.mjs` | over a real socket a continuation that bounces server↔browser each hop ships `min(delta, full)` — a compiler-tracked delta on warm hops, a full binary frame on the cold hop — reconstructing exactly and computing the right result |
| `test/probes/host.mjs` | the assembled host (`serveApp`/`connect`): client-started **actions** run out on the server in one hop, bounce back mid-flight at a browser resource, and interleave concurrently on one socket (the host is stateless — all state rides in the continuation); the server-started full-tierless mode completes over the same endpoint |
| `test/probes/compiler-api.mjs` | the compiler as an importable library: configurable resource namespaces (`db.*` → server, from opts or `--resource`), module-shaped input (`export function` → a named PROGRAM, imports/state preserved), and the `analyze()` suspendability report |
| `test/probes/define-api.mjs`, `test/probes/cli.mjs` | `defineApi` keeps the monitor's load-time mandate (no authorize → fails at create), and the `stackmix` CLI works end to end: `build`, `explain` (the analysis made visible), `api` (pre-ship check), `types` |
| `test/probes/vite-plugin.mjs` | the Vite plugin, headless: a `"use mix"` module becomes monitor-backed actions — transform + dev-server endpoint + ssr-loaded machine + sidecar authorization, with a loginless write denied. Verified for real too: `npm install` + `vite build` succeed in `examples/react-vite`, and a live `vite dev` + Chromium run clicks Rebalance and renders monitor-authorized orders |
| `test/probes/create-app.mjs` | `create-stackmix` scaffolds a WORKING app: built with the real bin, booted (api sidecar forked), and driven live — seeded render, authorized write with the principal attached, a blank write denied at the monitor and caught by the app's `try/catch` across the tier |

`test/demos/demo.mjs` and `test/demos/server-live.mjs` additionally run the whole thing across a real
WebSocket into **real headless Chromium** (Playwright) with real clicks; they need a
browser and so run on demand rather than in `npm test`.

## Repository layout

```
packages/
  stackmix/       the npm package `stackmix` — everything `npm i stackmix` delivers
    src/          compiler (transform.cjs), runtime/host/server/browser, wire + graph +
                  delta + content codecs, §5 heap, transport, the api reference monitor,
                  the Vite plugin, the react hook
    bin/          the stackmix CLI: build / explain / api / types
  create-stackmix/  the npm package behind `npm create stackmix` (scaffolder + template)
test/
  run.mjs         the regression runner (npm test)
  probes/         focused single-mechanism proofs
  demos/          app-shaped end-to-end proofs + the demo apps they drive (Tasks, conduit,
                  the live pages, heap/policy/delta demos, the sample trusted services) —
                  all importing the REAL package through its exports map
examples/         popular frameworks with Stackmix mixed in (react-vite)
docs/             architecture, design spec
```

## Documentation

- [`test/demos/README.md`](./test/demos/README.md) — the framework walkthrough (the live demo, what each piece does)
- [Architecture](./docs/architecture.md) — layout, the pump, the wire, the heap
- [Design](./docs/design.md) — the original vision and open questions
- [Roadmap](./ROADMAP.md) · [Contributing](./CONTRIBUTING.md)

## License

[Apache-2.0](./LICENSE) © Bright Fulton
