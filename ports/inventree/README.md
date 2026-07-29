# InvenTree — corpus app #6 (in progress)

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

Three things in this app needed framework work first — each would have made the
port measure nothing:

- `api.defaults.withCredentials = true` pinned 100% of requests to the browser
  fallback. `crossCredentialed` crosses them instead; it is only sound behind a
  `--cookie-authority` gateway, which holds the upgrade's cookie.
- `api.defaults.timeout = 5000` pinned the rest. `crossTimeouts` crosses and
  enforces the deadline in the adapter, rejecting with axios's own
  `ECONNABORTED` shape.
- Django CSRF: axios injects the XSRF header inside its **adapters**, so
  replacing the adapter dropped it and every mutating request would have 403'd.
  The adapter now applies axios's own rule against the readable cookie jar.

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
