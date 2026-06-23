# Stackmix

[![CI](https://github.com/bfulton/stackmix/actions/workflows/ci.yml/badge.svg)](https://github.com/bfulton/stackmix/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](./package.json)

**One program that runs across client and server, with the runtime moving live
execution between tiers as needed — instead of you splitting it by hand.**

You write ordinary TypeScript with no tier annotations. Placement is *inferred*
from which resources each call touches. When execution crosses a tier boundary
mid-computation, the live continuation is captured as plain serializable data,
shipped to the other tier, and resumed there. The big data stays where it lives;
only the small continuation moves.

> **Status: research-stage.** The load-bearing idea is proven and every benchmark
> below is executed, not modeled — but the API is pre-1.0 and Stackmix is not yet
> meant to run untrusted code across a trust boundary in production. See
> [`ROADMAP.md`](./ROADMAP.md).

## Why

The usual client/server split forces you to design an API for every interaction
ahead of time: a waterfall of dependent requests becomes N round trips, and a
filter the API didn't anticipate forces you to over-fetch and filter on the
client. Stackmix lets you write the obvious sequential code and runs it where the
data is — the runtime migrates the computation, not the data.

The central empirical bet: **does the continuation actually stay small on real
code?** Yes. A program queries a large dataset on the server, filters it, and
renders the result on the client, forced to cross once each way:

```
continuation crossing the wire : 8.2 KB
full dataset, had we shipped it : 8.00 MB
ratio                          : ~978x smaller
```

## Quick start

Stackmix is not yet published to npm; run it from a checkout:

```bash
git clone https://github.com/bfulton/stackmix
cd stackmix
npm install
npm test          # builds the wasm, runs every demo + the conformance suites
```

Scaffold a starter app with the CLI:

```bash
node bin/stackmix.mjs new my-app
```

Or use the API directly. One program, two tiers, migrating in-process:

```js
import {
  createRuntime, Tier, Suspend,
  serializeContinuation, deserializeContinuation, initialFrames,
} from "stackmix";

const rt = createRuntime();
rt.load(`
  declare const db: { products(): { name: string; price: number }[] };
  declare const ui: { show(lines: string[]): number };
  function main(): number {
    const cheap = [];
    for (const p of db.products()) if (p.price < 50) cheap.push(p.name);
    return ui.show(cheap);            // migrates to the client to render
  }
`, { entry: "main", resources: ["db.products", "ui.show"] });

const server = new Tier("server", { "db.products": () => [/* ...big list... */] });
const client = new Tier("client", { "ui.show": ([lines]) => lines.length });
// ...drive rt.run(tier, frames, host), migrating the continuation on Suspend.
```

`templates/basic/` (what `stackmix new` copies) is a complete, runnable version of
this. The CLI also offers `stackmix compile <file.ts>` (lower TypeScript to IR) and
`stackmix run <file.ts>` (run a resource-free program).

## The evidence

`npm test` runs all of the following and asserts their headline claims hold.

### Benchmark 1 — Hacker News waterfall (round trips / latency)

Loading an HN thread is the canonical client-side waterfall: fetch the story,
then each comment, then its children — one dependent request per node. The same
traversal, run under the runtime across a 2×2 of concurrency × placement (all four
cells executed, not modeled):

```
                       per-item (sequential)     per-level (concurrent)
  client (REST, stay)   13208ms / 254 rt            312ms /   6 rt
  Stackmix  (migrate)      608ms /   2 rt            112ms /   2 rt
```

Stackmix (migrate + concurrent) = **112ms** beats naive REST (13208ms, **118×**)
and even a hand-tuned parallel client (312ms, **2.8×**): the client still pays one
round trip per tree level, while Stackmix pays 2 client round trips total
regardless of depth. `npm run bench:sweep` shows this as a curve — REST round trips
grow O(nodes), the parallel client O(depth), Stackmix stays flat at 2.

### Benchmark 2 — Conduit home feed (bandwidth / over-fetch)

A feed filtered by a predicate the public API doesn't support: a REST client must
drag every article body to the client to filter and join locally, plus an N+1 hop
per author. Stackmix runs the same assembly on the server and ships back only the
small projected feed:

```
  strategy               round trips    bytes      latency
  REST (over-fetch)       202 rt     4.08 MB    10504ms
  Stackmix (migrate)        2 rt     11.3 KB      504ms
       -> 362x less data, 21x faster, identical result
```

Run them yourself: `npm run bench:hn`, `npm run bench:sweep`, `npm run bench:conduit`
(add `--real` to inject real network sleeps for genuine wall-clock numbers).

## How it works

- **Resources are the boundaries.** Every resource access compiles to a single
  `RES` instruction — the only place a migration can happen. Boundaries are
  visible at compile time; the decision to migrate is made at runtime, and lazy
  placement falls out for free (you only leave a tier when forced).
- **The continuation is data you own.** It's the live frame stack encoded through
  an identity-preserving, cycle-safe graph codec. A subgraph larger than a
  threshold becomes an opaque *handle* into the owning tier's heap instead of being
  copied — so the big dataset stays put and is fetched only if actually touched.
- **Two execution paths, on purpose.** A JS interpreter is the language substrate
  (it spans essentially the whole language — closures, classes, generators, async,
  decorators + DI, multi-module programs — all proven to survive migration). A
  minimal WASM interpreter proves the same continuation can live in linear memory
  and cross a real pipe between processes.

For the full picture see [`docs/architecture.md`](./docs/architecture.md); for the
original vision and open questions, [`docs/design.md`](./docs/design.md).

## Repository layout

```
src/         the framework (runtime/, compiler/, wasm/, index.mjs)
bin/         the stackmix CLI
types/       hand-written public type declarations
examples/    runnable demos (spike, two-process, wasm, hn-thread, handle-fetch, ...)
bench/       the HN and Conduit benchmarks
test/        conformance, differential, decorator, multi-module suites + probes
templates/   the `stackmix new` scaffold
docs/        architecture, design spec, prior art
```

## Documentation

- [Architecture](./docs/architecture.md) — layout, public API, design rationale
- [Design](./docs/design.md) — the original spec and open questions
- [Prior art](./docs/prior-art.md) — where Stackmix sits among related systems
- [Roadmap](./ROADMAP.md) · [Changelog](./CHANGELOG.md) · [Contributing](./CONTRIBUTING.md)

## License

[MIT](./LICENSE) © Bright Fulton
