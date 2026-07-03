# Contributing to Tierless

Thanks for your interest. Tierless is a research-stage framework, and the most
valuable contributions right now are sharp test cases, language-fidelity bug
reports, and improvements to the items on the [roadmap](./ROADMAP.md).

## Getting started

```bash
git clone https://github.com/tierlessjs/tierless
cd tierless
npm install
npm test        # runs every demo + probe headless and asserts the headline claims
```

Read [`docs/architecture.md`](./docs/architecture.md) first — it explains the
repository layout, the compiler, the pump, the wire, and the heap. For the live
two-tier walkthrough, see [`test/e2e/README.md`](./test/e2e/README.md).

## The checks that must pass

CI runs three gates, and all three should be green locally before you open a PR:

```bash
npm run build -w tierless   # compile packages/tierless/src/*.mts to .mjs + .d.mts, then:
git diff --exit-code -- packages/tierless/src packages/tierless/types   # ...and commit the result
npm run lint                # ESLint (correctness-focused)
npm test                    # the full regression suite (every demo + probe)
```

If you edit anything under `packages/tierless/src/*.mts`, rebuild and commit the
generated `.mjs`/`.d.mts` — CI fails if they're out of sync with the source.

`npm test` is not just "exit 0" — `test/run.mts` asserts the headline claim of each
demo (continuation sizes, migrate-vs-fetch decisions, cross-tier correctness). If you
change runtime or compiler behavior, the relevant proof should still pass; if you add
behavior, add a proof and wire it into `test/run.mts`.

## Working with the compiler

The compiler (`packages/tierless/src/transform.cjs`) lowers a plain `*.src.js` function into a generated
`*.gen.mjs` state machine. The generated bundles are **committed** so `npm test` runs
without a build step. Regenerating them needs the Babel toolchain (not a runtime
dependency):

```bash
npm i -D @babel/parser@8 @babel/traverse@8 @babel/generator@8 @babel/types@8
npx tierless build test/e2e/app/App.src.js test/e2e/app/bundle.gen.mjs
npx tierless build test/e2e/heap-write.src.js test/e2e/heap-write.gen.mjs --bare --auto-deref --auto-writeback
```

If you change a `*.src.js` input or the compiler, regenerate and commit the matching
`*.gen.mjs`.

A mix module can also be authored as `*.src.ts` (or `.mts`): the compiler detects the
extension and strips TypeScript syntax before parsing (erasable TS only — no enums, no
namespaces, no parameter properties, same as `node --experimental-strip-types`), so it
compiles through the same pipeline as `.src.js`.

## Code style

- **Match the surrounding code.** The pump and the codec are written in a deliberately
  dense, one-line-per-case style; please keep it that way rather than reformatting.
  There is no Prettier step on purpose.
- Two-space indent, LF line endings, UTF-8, final newline (enforced by
  `.editorconfig`).
- `*.src.js` (compiler inputs) and `*.gen.mjs` (compiler outputs) are eslint-ignored
  by design — don't hand-edit a `.gen.mjs`.
- Everything under `packages/tierless/src/` is TypeScript (`*.mts`) except
  `transform.cjs`. Edit the `.mts` file; `tsc` compiles it to the `.mjs` + `.d.mts`
  that ship (also eslint-ignored — don't hand-edit those either). The dense,
  one-line style applies to the `.mts` source the same as everywhere else.

## Where things live

| You want to change... | Edit... |
|---|---|
| the compiler (plain JS → state machine) | `packages/tierless/src/transform.cjs` |
| the pump / wire envelope | `packages/tierless/src/runtime.mts` |
| the graph/wire codec | `packages/tierless/src/graph.mts` |
| the §5 heap, write-back, §6 policy | `packages/tierless/src/heap.mts`, `packages/tierless/src/fetch.mts` |
| the WebSocket transport | `packages/tierless/src/transport.mts` |
| the demo app | `test/e2e/app/` |
| the browser tier | `test/e2e/public/` |
| a proof / regression case | `test/e2e/*.mjs` + `test/run.mts` |

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
