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

## Quick start

```bash
git clone https://github.com/bfulton/stackmix
cd stackmix
npm install
npm test          # runs every demo + probe headless and asserts the headline claims
```

Open the live two-tier page (a real browser tab, real clicks):

```bash
npm run live      # then open the printed URL and click the dashboard
```

## The developer's code

The whole app is straight-line logic — [`src/app/App.src.js`](./src/app/App.src.js):

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
| `src/verify.mjs` | the auto-compiled tier-split continuation reproduces the correct session across migrations |
| `src/control-flow.mjs` | loops, `break`/`continue`, labeled loops, `switch`, and `try`/`catch`/`finally` (including `return`/`break` across a `finally`) all survive migration |
| `src/heap-probe.mjs`, `src/heap-live.mjs` | a 1.1 MB dataset crosses a commit migration as a ~450-byte §5 handle and is fetched back over a real socket only when the browser derefs it |
| `src/heap-auto.mjs`, `src/heap-write.mjs` | transparent deref (reads auto-fetch on touch) and transparent write-back (a browser edit propagates to the server master under §5 CAS), with no `deref()`/`writeBack()` in the source |
| `src/heap-writeback.mjs` | optimistic version-checked CAS: conflicts detected, refetch + retry, no lost updates |
| `src/policy-live.mjs` | at a data boundary the driver prices migrate-vs-fetch from real bytes and steers what crosses (§6) — flipping to fetch a 23 B fact rather than ship a 97 KB continuation |

`src/demo.mjs` and `src/server-live.mjs` additionally run the whole thing across a real
WebSocket into **real headless Chromium** (Playwright) with real clicks; they need a
browser and so run on demand rather than in `npm test`.

## Repository layout

```
src/              the framework
  transform.cjs   the compiler: plain JS -> serializable state machine (Babel)
  runtime.mjs     the pump — one tier-agnostic continuation driver + the wire envelope
  graph.mjs       identity/cycle-safe graph codec for the wire
  wire-binary.mjs the compact binary wire (type tags + varints + string/shape tables)
  heap.mjs        §5 distributed handle heap: encodeWire, makeTier, write-back CAS
  fetch.mjs       Heap / Channel / makeHost — fetch-on-deref with coherence
  transport.mjs   WebSocket framing + RPC peer (browser-safe)
  app/            the demo app (plain components -> serializable vdom)
  public/         the browser tier (runs in a real tab)
  *.mjs           the demos and headless proofs (also the test suite)
test/             the regression runner + the wire-codec probe
docs/             architecture, design spec
```

## Documentation

- [`src/README.md`](./src/README.md) — the framework walkthrough (the live demo, what each piece does)
- [Architecture](./docs/architecture.md) — layout, the pump, the wire, the heap
- [Design](./docs/design.md) — the original vision and open questions
- [Roadmap](./ROADMAP.md) · [Contributing](./CONTRIBUTING.md)

## License

[Apache-2.0](./LICENSE) © Bright Fulton
