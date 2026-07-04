# Changelog

Notable changes by release. Tierless is pre-1.0 — a `0.x` minor may break the API.

## 0.2.1 — 2026-07-04

First public release.

```
npm create tierless@latest my-app
```

Tierless compiles a plain JavaScript function into a state machine that can
pause mid-function, cross the network, and resume on the other tier — a
workflow that touches both the database and the DOM is one function, not a
client and a server glued together with hand-written endpoints. An 8-call
workflow that would cost 8 round trips runs in 1.

In the box: the compiler (mix modules can also be TypeScript), the wire
protocol (a migrating continuation is ~100–200 bytes; repeat crossings send
only what changed), a trusted api service that authorizes every call with no
default-open path, types generated from the source by `tsc` on every build,
the `tierless` CLI, a Vite plugin with React bindings, and the
`create-tierless` scaffolder. Both packages are published from CI with npm
provenance.

(Version numbers below 0.2.1 were consumed by partial pre-release publishes —
npm reserves a used version number forever.)
