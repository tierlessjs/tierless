# Session transports — plain ws, ws-over-H2, WebTransport

The session between browser and gateway is a stream of discrete binary messages
(`encodeMessage`/`decodeMessage`, a self-delimiting `[u32 jsonLen][u32 binLen][json][bin]`
frame). Everything above the byte pipe — `makePeer`, the host, migration, §5 — is transport
agnostic: each transport is just a `Port` (`send` / `onMessage` / `onClose` / `close`).
Three are supported, all yielding the same `Port`.

## Why more than plain ws

A plain websocket is a **separate connection the page never warmed**: its TCP + upgrade
handshake (~2 RTT) lands fresh on the boot critical path, where the app's own HTTP requests
reused connections already opened for the page (see `ports/n8n/README.md` — 86% of that port's
residual network-wait was exactly this handshake). The other two transports **share the page's
existing connection**, so there is no separate handshake to pay.

## The matrix

| transport | shares the page's connection? | client (browser) | server (Node) | status |
|---|---|---|---|---|
| **plain ws** (H1.1 Upgrade) | no — its own TCP + upgrade | `new WebSocket` | `attachTierless` (`ws` lib) | shipped |
| **ws-over-H2** (RFC 8441 Extended CONNECT) | **yes** — a stream on the H2 connection | `new WebSocket` (transparent) | `attachTierlessH2` (`node:http2`) | **native, proven** |
| **WebTransport** (HTTP/3 / QUIC) | **yes** — a stream on the QUIC connection; +0-RTT resume, no HoL blocking | `new WebTransport` → `wtPort` | `wtPort` + a **pluggable** H3 server | **adapter native+proven; H3 server pluggable** |

"Native to the extent possible": plain ws and ws-over-H2 are fully native to Node; WebTransport
needs an HTTP/3 server, which stable Node does not provide — so its **adapter** (`wtPort`) is
framework-owned and proven, while the H3 endpoint is external (a library like
`@fails-components/webtransport`, or an H3-terminating proxy). All three are exercised in the
suite: `test/e2e/{ws-auth-live, h2-connect-live, webtransport-live}.mts`.

## ws-over-H2 is transparent on the client — the key property

`new WebSocket(wss://…)` becomes an Extended CONNECT stream on the page's existing H2
connection **automatically**, with no client code change, when four conditions hold:

1. **Same origin** as the page (so the browser coalesces the ws onto the page's H2 connection).
   This is the real reason to colocate the gateway on the app origin — not to save a cold TCP
   by proximity (a plain ws needs its own TCP to any origin), but to make the socket
   *coalescible*.
2. **TLS + HTTP/2** (browsers do H2 only over ALPN `h2`).
3. The H2 server **advertises `SETTINGS_ENABLE_CONNECT_PROTOCOL`** and accepts
   `:method CONNECT, :protocol websocket` — `attachTierlessH2` on a server created with
   `http2.createSecureServer({ allowHTTP1: true, settings: { enableConnectProtocol: true } })`.
   `allowHTTP1` lets the same server also serve the plain-ws fallback (`attachTierless`) and
   the app's own H2 requests.
4. **No downgrading middlebox** in between (one that terminates as H1.1 or doesn't grok
   Extended CONNECT silently drops you to a plain ws).

**Measured** (`ports/transport-bench.mts`, real Chromium over TLS+H2 at 80 ms RTT, same page,
the only difference the `enableConnectProtocol` toggle): median ws-open **167 ms plain ws →
84 ms ws-over-H2 — 50% faster, one saved RTT (the TCP handshake of a separate connection)**.
Server-side stream counts confirm the transport per arm (h1=6 vs h2=6), so it is the transport
that moved, not noise. The residual 84 ms is the Extended CONNECT round trip on the shared
connection; WebTransport (pooled QUIC stream, ~0-RTT creation) is what removes that last RTT.

Because it **falls back silently**, "support" means *verify it actually rode H2*: check the
client's `performance.getEntriesByType('resource')` `nextHopProtocol === 'h2'` (or DevTools'
Protocol column), and/or log the stream type server-side — and gate it in telemetry so a
config regression surfaces as "the handshake cost came back", not as a latency mystery. The
guarantee is a measurement, not a setting.

## Browser support (tune tests to the majority)

- **plain ws** — universal.
- **ws-over-H2** — Chrome, Edge, Firefox for years; Safari more recently (verify against your
  target matrix). This is the **majority path** on any modern HTTPS/H2 deployment and needs no
  client change, so it is the transport the corpus should measure by default; the plain-ws
  numbers are the fallback floor.
- **WebTransport** — Chrome, Edge, Firefox (recent); Safari not yet. The forward bet, not yet
  majority — offered where available, never depended on.

## Frame codecs

- Plain ws / ws-over-H2 carry the tierless frame **inside an RFC 6455 binary frame**. The plain
  path uses the `ws` library; the H2 path uses a **self-contained RFC 6455 codec**
  (`transport-h2.mts`) — `ws` locks its `lib/*` subpaths, so owning the codec keeps the
  dependency surface clean. It handles 7/16/64-bit lengths, client masking, continuation-frame
  fragmentation, ping→pong, and close. (permessage-deflate is declined on the H2 path for now —
  it wins the handshake, not yet the deflate byte win; wiring zlib/rsv1 into the codec to match
  the plain-ws byte savings is the one open follow-on.)
- WebTransport carries the tierless frame **directly over the QUIC byte stream** — the frame is
  already self-delimiting, so no ws framing is involved at all (`wtPort`, `transport.mts`).

## Open follow-ons

- **permessage-deflate over ws-over-H2** — add zlib (rsv1) to the H2 codec so that path keeps
  the ~49% byte win the plain-ws path gets from the shared deflate window.
- **Browser WebTransport `connect()` wiring** — `wtPort` is proven; folding a `new WebTransport`
  path into `browser.mts` `connect()` (a deferred-Port variant) is thin glue, gated on an H3
  test environment.
- **Corpus over the majority transport** — the n8n harness runs plain ws on localhost; running
  it over TLS + H2 (so the measured numbers reflect the ws-over-H2 common case, where the
  handshake residual largely disappears) is a measurement-environment change, not a capability
  gap — the capability is proven here.
