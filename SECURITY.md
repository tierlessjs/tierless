# Security

Stackmix is **research-stage (pre-1.0)** and not yet intended to run untrusted
code across a trust boundary in production.

## Model

A Stackmix program is untrusted client code — all of it, on every tier. A
migrating continuation can be forged or replayed, so authority never lives in
the program: every `api.*` call is mediated by a **reference monitor** in its
own OS process that re-authorizes each call against a principal it verifies
itself (a signed bearer token). Default-deny; `authorize` is mandatory at load
time; per-call args/rate budgets; the wire decoder is bounds-checked,
count-guarded, `__proto__`-stripping, and fuzz-tested. The threat model and its
executable proofs: `docs/architecture.md` ("The trust boundary"),
`test/e2e/api-verify.mjs`, `test/e2e/api-live.mjs`, `test/probes/wire-fuzz.mjs`.

## Known limitations

- The demo JWT regime mints its signing secret per service start: restarting the
  sidecar invalidates sessions, and multi-instance deployments need a shared,
  rotated secret (bring your own regime by subclassing `Api.verify`).
- No TLS termination is built in — put the websocket behind your own `wss://`.
- See `docs/production.md` for the full honesty list.

## Reporting

Please report suspected vulnerabilities privately via GitHub security advisories
(Security tab → "Report a vulnerability") rather than public issues.
