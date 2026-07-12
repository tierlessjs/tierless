# Journey measurement harness

Rung 1 of the corpus program (`docs/corpus.md`): measure a scripted user journey's real
network behavior in a real Chromium, so the same journey run against an app before and
after a tierless port yields a trustworthy diff.

- `measure.mts` — `measureJourney(url, journey, opts)`: CDP-derived per-request HTTP wire
  bytes (`encodedDataLength` + estimated request side), per-frame websocket bytes both
  directions (RFC 6455 framing), round trips, raw wall. `modelWallMs(report, {rttMs, bps})`
  turns measured (trips, bytes) into a latency figure under a declared model — the honest
  route, since CDP throttling doesn't apply to websockets.
- `verify.mts` — the harness checked against socket ground truth (a local server counting
  its own bytes): run it after touching measure.mts. Chromium required, so it's on-demand,
  not in `npm test`.
- `journeys/` — one file per app/journey. `react-vite.mts` measures the example app's
  Rebalance interaction: 1 trip, ~1.1 KB.

Journeys are plain Playwright functions — port an app's existing e2e test by pasting its
body.
