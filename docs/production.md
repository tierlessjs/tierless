# Production notes — the honesty list

Tierless is research-stage (0.1). This page says exactly what IS and ISN'T solved for
deployment, so nothing here surprises you in an afternoon of testing.

## What works today

- **Prod serving shape (actions mode).** The Vite plugin is dev-first, but production is
  the same contract mounted yourself: build the client with Vite as usual (the plugin
  transforms `"use tierless"` modules at build time), compile the server copy of the actions
  with `npx tierless build src/actions.mjs actions.server.gen.mjs --bare`, and mount
  `attachTierless(yourHttpServer, { bundle, session })` — see
  [`examples/react-vite/server.prod.mjs`](../examples/react-vite/server.prod.mjs).
  The browser and server machines are identical because the same compiler emitted both.
- **The trust boundary.** Run the api service as a sidecar (`startSidecar`) or any
  process implementing the monitor contract; budgets (`maxArgsBytes`, per-principal
  rate window) are on in the examples. The wire decoder is hardened and fuzz-tested.
- **One socket, many sessions.** The host is stateless per message; concurrent actions
  multiplex on one connection.

## What is NOT solved yet (know before you deploy)

- **Reconnection.** A dropped websocket loses in-flight sessions; the client must start
  new ones. The continuation is durable data, so resume-on-reconnect is a natural
  extension (see ROADMAP) — it does not exist today.
- **Horizontal scaling needs sticky sessions.** The protocol itself carries all session
  state, but two things are per-process: §5 heap contents (handles point into the
  process that excised them) and delta-wire baselines (per-socket). Route a client to
  the same instance for the life of its connection; cross-instance handle resolution is
  future work.
- **Secrets.** The demo services mint an HMAC secret per boot (`sidecarMain`): restarts
  invalidate tokens, and multiple instances won't verify each other's. For real
  deployments provision a shared secret (pass it to `def.create(secret)` yourself) or
  subclass `Api.verify` onto your identity provider (OIDC/JWKS is the same shape).
- **TLS.** Terminate `wss://` in front (nginx/ALB/etc.); the endpoint is a plain
  websocket at `WS_PATH` (`/__tierless`).
- **Resource budgets are a floor, not a WAF.** `maxArgsBytes` + rate windows bound one
  class of abuse; put the endpoint behind your normal edge protections.

## Sizing intuition

A migration hop is ~140 bytes and ~2.5 µs of codec CPU for a typical continuation; warm
re-crossings ship deltas (77–91 % fewer bytes); data your code doesn't touch stays home
behind a ~400 B handle. The costs that DO scale are the ones you control: the live
working set your frames actually reference. `npm run bench` reproduces all of this.
