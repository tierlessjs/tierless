# Contributing to Stackmix

Thanks for your interest. Stackmix is a research-stage framework, and the most
valuable contributions right now are sharp test cases, language-fidelity bug
reports, and improvements to the items on the [roadmap](./ROADMAP.md).

## Getting started

```bash
git clone https://github.com/bfulton/stackmix
cd stackmix
npm install
npm test        # builds the wasm and runs every demo + the conformance/differential suites
```

Read [`docs/architecture.md`](./docs/architecture.md) first — it explains the
repository layout, the public API, and the two execution paths.

## The checks that must pass

CI runs three gates, and they should all be green locally before you open a PR:

```bash
npm run lint        # ESLint (correctness-focused)
npm run typecheck   # tsc against the public type declarations
npm test            # the full regression suite (every example, bench, probe, and suite)
```

`npm test` is not just "exit 0" — `test/run.mjs` asserts the headline claims of
each demo (continuation sizes, round-trip counts, cross-process correctness) and
the conformance/differential suites measure language fidelity against Node itself.
If you change runtime or compiler behavior, the relevant suite should still pass;
if you add a language feature, add a case to `test/conformance.mjs` (fidelity +
migration survival) and/or `test/difftest.mjs` (differential vs Node).

## Code style

- **Match the surrounding code.** The interpreter (`src/runtime/core.mjs`) is
  written in a deliberately dense, one-line-per-opcode style; please keep it that
  way rather than reformatting. There is no Prettier step on purpose — automatic
  reformatting would hurt the readability of the dispatch loop.
- Two-space indent, LF line endings, UTF-8, final newline (enforced by
  `.editorconfig`).
- Prefer the public API (`#stackmix`) in examples, benchmarks, and tests; reach
  for deep imports (`#stackmix/runtime/...`) only when you genuinely need an
  internal.

## Where things live

| You want to change... | Edit... |
|---|---|
| the interpreter / IR / wire format | `src/runtime/` |
| TypeScript → IR lowering | `src/compiler/tsc.mjs` |
| the WASM linear-memory path | `src/wasm/` |
| the public API surface | `src/index.mjs` + `types/index.d.ts` |
| the CLI | `bin/stackmix.mjs` |
| a demo or the getting-started story | `examples/` |
| a benchmark | `bench/` |

## Commits & pull requests

- Keep commits focused and write a clear message explaining *why*, not just *what*.
- In the PR description, say what changed and how you tested it.
- For anything architecturally significant, opening an issue to discuss first will
  save everyone time.

## Reporting bugs

For a language-fidelity bug, the most useful report is
the **smallest** TypeScript snippet that behaves differently under Stackmix than
under Node, plus what you expected. Security issues should follow
[`SECURITY.md`](./SECURITY.md) instead of a public issue.

By contributing, you agree that your contributions are licensed under the
project's [Apache License 2.0](./LICENSE).
