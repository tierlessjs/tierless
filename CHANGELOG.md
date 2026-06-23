# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it reaches
a stable release.

## [Unreleased]

## [0.1.0] — 2026-06-23

First organized cut: the working prototype, reorganized into a real framework.
The runtime semantics and every headline benchmark are unchanged; this release is
about structure, a stable public API, types, tooling, and documentation.

### Added
- A curated public API at `stackmix` / `#stackmix` (`src/index.mjs`), centered on
  `createRuntime()`.
- Hand-written TypeScript declarations for the public API (`types/index.d.ts`),
  type-checked in CI via a compile-time type-test.
- A CLI (`bin/stackmix.mjs`): `stackmix compile`, `stackmix run`, `stackmix new`.
- A project scaffold (`templates/basic/`) used by `stackmix new`.
- Continuous integration (GitHub Actions): lint, typecheck, and the full test
  suite on Node 20 and 22.
- ESLint (correctness-focused, flat config) and an `.editorconfig`.
- Community health files: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`,
  issue/PR templates, and a `ROADMAP.md`.
- `docs/architecture.md` describing the layout, the public API, and the design
  rationale.

### Changed
- **Replaced the process-wide `PROGRAM` singleton with `createRuntime()`
  instances.** `run()` now takes the program explicitly; two programs can coexist
  in one process. (Breaking vs. the prototype's internal API.)
- Reorganized the flat repository into `src/`, `examples/`, `bench/`, `test/`, and
  `docs/`, with framework code imported via Node subpath imports (`#stackmix/*`).
  Git history is preserved across the moves.
- Renamed the WASM interpreter source to `src/wasm/interpreter.wat`.

### Removed
- The chronological frontend development log (`NOTES-frontend.md`). Its durable
  content — the NJS lineage, the "native async is suspend-but-not-serialize"
  rationale, and the intentional frontend caveats — was folded into
  `docs/prior-art.md`, `docs/architecture.md`, and `ROADMAP.md`.
- Demo-specific fixtures (the people/render IR, `makeDataset`) that had leaked
  into the runtime; they now live in `examples/shared/`.

[Unreleased]: https://github.com/bfulton/stackmix/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/bfulton/stackmix/releases/tag/v0.1.0
