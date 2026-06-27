# Contributing to Stackmix

Thanks for your interest. Stackmix is a research-stage framework, and the most
valuable contributions right now are sharp test cases, language-fidelity bug
reports, and improvements to the items on the [roadmap](./ROADMAP.md).

## Getting started

```bash
git clone https://github.com/bfulton/stackmix
cd stackmix
npm install
npm test        # runs every demo + probe headless and asserts the headline claims
```

Read [`docs/architecture.md`](./docs/architecture.md) first — it explains the
repository layout, the compiler, the pump, the wire, and the heap. For the live
two-tier walkthrough, see [`src/README.md`](./src/README.md).

## The checks that must pass

CI runs two gates, and both should be green locally before you open a PR:

```bash
npm run lint        # ESLint (correctness-focused)
npm test            # the full regression suite (every demo + probe)
```

`npm test` is not just "exit 0" — `test/run.mjs` asserts the headline claim of each
demo (continuation sizes, migrate-vs-fetch decisions, cross-tier correctness). If you
change runtime or compiler behavior, the relevant proof should still pass; if you add
behavior, add a proof and wire it into `test/run.mjs`.

## Working with the compiler

The compiler (`src/transform.cjs`) lowers a plain `*.src.js` function into a generated
`*.gen.mjs` state machine. The generated bundles are **committed** so `npm test` runs
without a build step. Regenerating them needs the Babel toolchain (not a runtime
dependency):

```bash
npm i -D @babel/parser@8 @babel/traverse@8 @babel/generator@8 @babel/types@8
node src/transform.cjs src/app/App.src.js src/app/bundle.gen.mjs
node src/transform.cjs src/heap-write.src.js src/heap-write.gen.mjs --bare --auto-deref --auto-writeback
```

If you change a `*.src.js` input or the compiler, regenerate and commit the matching
`*.gen.mjs`.

## Code style

- **Match the surrounding code.** The pump and the codec are written in a deliberately
  dense, one-line-per-case style; please keep it that way rather than reformatting.
  There is no Prettier step on purpose.
- Two-space indent, LF line endings, UTF-8, final newline (enforced by
  `.editorconfig`).
- `*.src.js` (compiler inputs) and `*.gen.mjs` (compiler outputs) are eslint-ignored
  by design — don't hand-edit a `.gen.mjs`.

## Where things live

| You want to change... | Edit... |
|---|---|
| the compiler (plain JS → state machine) | `src/transform.cjs` |
| the pump / wire envelope | `src/runtime.mjs` |
| the graph/wire codec | `src/graph.mjs` |
| the §5 heap, write-back, §6 policy | `src/heap.mjs`, `src/fetch.mjs` |
| the WebSocket transport | `src/transport.mjs` |
| the demo app | `src/app/` |
| the browser tier | `src/public/` |
| a proof / regression case | `src/*.mjs` + `test/run.mjs` |

## Commits & pull requests

- Keep commits focused and write a clear message explaining *why*, not just *what*.
- In the PR description, say what changed and how you tested it.
- For anything architecturally significant, opening an issue to discuss first will
  save everyone time.

## Reporting bugs

For a language-fidelity bug, the most useful report is the **smallest** JavaScript
snippet that behaves differently after migration than when run straight. Security
issues should follow [`SECURITY.md`](./SECURITY.md) instead of a public issue.

By contributing, you agree that your contributions are licensed under the project's
[Apache License 2.0](./LICENSE).
