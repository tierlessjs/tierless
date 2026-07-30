# InvenTree — corpus app #6

## Results

Read `docs/corpus.md` "Reading a byte number" first: the same bytes give three
numbers 20x apart depending on the denominator.

| | baseline | ported | delta |
|---|---|---|---|
| suite total | 822 MB | 679 MB | **−17.4%** |
| marginal (what a warm cache still fetches) | 184 MB | 43 MB | **−76.9%** |
| the many-small slice (traffic the port moved) | 171 MB | 29 MB | **−83.2%** |
| wall clock, 136 pass-parity pairs | 20.7 min | 20.9 min | +1% |

The third row is the one this app was picked for, and it is the cleanest in the
corpus: the moved traffic is **100% small responses, 0% bulk**, across 572 paths.
Grafana's small slice came in at −81%/−84% and n8n's at −51%; InvenTree at −83.2%
is the prediction confirmed on a third app.

Two things a reader has to be told:

- **`/api/icons/` is 106 MB — 57% of the baseline's marginal bytes.** It is one
  path, `public, max-age=86400`, byte-identical at 643 KB, fetched once per test
  by both arms only because every Playwright context starts cold. A real browser
  fetches it once a day. Excluding it, the slice is 79 MB baseline against at most
  29 MB ported — still **≥−63%**, but that is a bound, not a measurement: the
  session's shared deflate window makes per-path compressed bytes unobservable
  (packages/tierless/src/server.mts), so the ported side cannot be split.
- **Pass counts are 3 apart** (baseline 143, ported 146 — the ported arm passes
  *more*), so the totals are not strictly comparable and `report-marginal.mts`
  says so on every run. This suite is flaky at 3–9 failures per run in both arms;
  the failing sets are disjoint between consecutive runs of the same arm.

# InvenTree — the port

Pinned: `inventree/InvenTree` 1.4.3 (`6b237de54e4cbfd7f51daff8403c17869898d965`).
Django 5.2 backend + React 19 / Mantine frontend, Playwright suite in
`src/frontend/tests` (22 spec files). No Docker needed — the CI lane runs the
backend directly through `invoke`, which is what qualified it here.

## Why this app

It is the request-shape opposite of n8n. n8n's suite bytes are 97.7% bulk
payloads (a 12.7 MB node catalogue), where a transport can win ~7%. InvenTree's
traffic is a table app's: many small paginated JSON reads per page. The
predictor in docs/corpus.md says a session wins big on many-small and barely
moves few-huge; grafana's small slice came in at −81%, n8n's at −51%. InvenTree
should look like grafana.

## The seam

`src/frontend/src/App.tsx:9` — `export const api = axios.create({})` is the
app's single API client, and every service, hook and interceptor sits above it.
The port is one call to `tierlessAxios` at the end of `setApiDefaults()`
(patches/0001-tierless-axios.patch), plus a `yarn add tierless@link:…` in the
ported tree only.

Six framework gaps, each found by running the port and each fixed with a probe.
The first three would have made the port measure nothing:

- `api.defaults.withCredentials = true` pinned 100% of requests to the browser
  fallback. `crossCredentialed` crosses them instead; it is only sound behind a
  `--cookie-authority` gateway, which holds the upgrade's cookie.
- `api.defaults.timeout = 5000` pinned the rest. `crossTimeouts` crosses and
  enforces the deadline in the adapter, rejecting with axios's own
  `ECONNABORTED` shape.
- Django CSRF: axios injects the XSRF header inside its **adapters**, so
  replacing the adapter dropped it and every mutating request would have 403'd.
  The adapter now applies axios's own rule against the readable cookie jar.

The other three came out of live runs:

- `awaitClaims: true`. Their login is `clearCsrfCookie(); await ensureCsrf();`
  and posts credentials on the very next line, so the CSRF cookie has to be in
  the jar when that GET resolves. The default fire-and-forget claim landed a beat
  later; Django answered 403 and no test could log in.
- `AxiosError.status` (axios ≥1.8) was missing from every error shape the
  framework builds. Their password-change flow keys its entire success path off
  `err.status === 401`.
- `restResources` attached a body to GET crossings. XHR drops it; fetch REJECTS
  the Request. Their form layer sends `data` on every submit, exports included,
  so four export specs hung 90 s each.

Plus one test accommodation, applied to both arms
(patches/0002-transport-waits-fixture.patch): `pui_printing` waits on an HTTP
response for `/api/label/print/`, which the ported build carries over the socket.
Their playwright (1.60) seals the client classes, so `installTransportWaits`
rides their own `baseFixtures` seam rather than the zero-touch config wrapper.

## Environment (this box)

The CI lane uses a Postgres service and a demo dataset; both arms here run
SQLite (their `qc_checks` lane does too) with the same demo dataset:

```
uv venv ports/work/inventree-venv --python 3.11
VIRTUAL_ENV=… uv pip install -U invoke wheel setuptools
VIRTUAL_ENV=… uv pip install -r src/backend/requirements.txt -r src/backend/requirements-dev.txt
source ports/work/inventree/env.sh          # roots, admin creds, plugin + CORS flags
invoke migrate
invoke dev.setup-test -i --branch 1.4.x     # clones inventree/demo-dataset
yarn --cwd src/frontend install
invoke int.frontend-compile && invoke static
```

Tests run against the **built** frontend served by Django on :8000
(`PLAYWRIGHT_BASE_URL=http://localhost:8000`), which is their firefox lane's
mode. The default lane (vite dev on :5173) serves thousands of unbundled ES
modules and would make byte measurement meaningless.

Playwright browsers live in `/root/pw-browsers` here, not the default cache.
