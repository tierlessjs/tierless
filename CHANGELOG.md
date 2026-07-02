# Changelog

Notable changes to Tierless, by release. Tierless is pre-1.0 — a `0.x` minor may
break the API. Every claim below is backed by an executable proof: `npm test`
runs them, and `docs/architecture.md` explains how each piece works.

## 0.1.0 — 2026-07-02

First public release.

```
npm install tierless
npm create tierless@latest my-app
```

Tierless compiles a plain JavaScript function into a state machine that can pause
mid-function, cross the network, and resume on the other side — so a workflow
that touches both a database and the DOM is one function, not a client and a
server glued together with hand-written endpoints. An 8-call workflow that would
normally cost 8 round trips runs in 1.

What's in this release:

- **Compiler.** Lowers ordinary JavaScript — loops, `try`/`catch`/`finally`,
  destructuring, default and rest parameters — into a migratable state machine,
  not a restricted subset. Code that genuinely can't migrate (a tier call inside
  an array callback, for instance) is a build-time error, not a runtime surprise.
- **Wire protocol.** A migrating continuation is typically on the order of
  100–200 bytes and takes low single-digit microseconds to encode; a large
  in-memory value the code never touches crosses as a small handle instead of its
  full contents (thousands of times smaller on a realistic dataset). On a
  long-running session, repeat crossings ship only what changed since the last
  one — commonly 75–90% fewer bytes than resending the full state each time.
- **Trust boundary.** Server-only operations run through a small, separate
  process that authorizes every call against a verified caller — not the
  application code, so it can't be bypassed by tampering with the client. Every
  endpoint must declare who's allowed to call it; there is no default-open path.
- **Tooling.** A CLI (`tierless build` / `explain` / `api` / `types`), a Vite
  plugin with React bindings, and `create-tierless` for a running two-tier app
  in under a minute.

See [`README.md`](./README.md) for the full pitch and measured numbers,
[`docs/design.md`](./docs/design.md) for the reasoning, and
[`docs/architecture.md`](./docs/architecture.md) for how it's built.
