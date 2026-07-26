# Grafana — corpus app #5 (in progress)

Pinned: `grafana/grafana` v13.1.1 (`593cfcf13df7f1bb`), 2026-07-21 stable. Go backend
(SQLite by default), React frontend, Playwright suite at the repo root — no Docker,
which is what qualified it here (the daemon is absent in this sandbox and eliminated
Ghost, immich, outline, plane and cal.com outright; docs/corpus.md candidate pipeline).

## The prediction this port tests (made before measuring — docs/corpus.md)

`byte win ≈ addressable share × per-slice win`. Grafana should be the INVERSE of n8n:
dashboard/datasource/search traffic is many small JSON responses (high per-slice win)
against large JS bundles no transport touches (modest addressable share). Estimated
15–35% addressable × >30% per-slice ⇒ **5–10% suite byte win**. Parity would falsify
the request-shape predictor; that is the point of picking it.

## The seam

`public/app/core/services/backend_srv.ts`: every data/API call flows through
`BackendSrv`, which invokes the network at ONE point — a dependency-injected
`fromFetch` (rxjs), defaulting to `fromFetch: fromFetch` in its constructor deps and
already swappable (that is how their tests mock it). The port patch supplies a
tierless-backed fetch there (autoSession exec → fetch-shaped adapter → wrapped in
`from()`), so interceptor-equivalent behavior (auth headers, retries, queues) stays
UPSTREAM of the swap, untouched. Expected port diff: comparable to nocodb's (+18).

## Their e2e lane

- `playwright.config.ts` at the repo root: 30+ projects by domain; most depend on an
  `authenticate` setup project (admin/admin → `playwright/.auth/admin.json`
  storageState); `dashboard-cujs` has setup/teardown chains.
- No external instance needed: absent `GRAFANA_URL`, the config boots
  `yarn e2e:plugin:build && ./e2e-playwright/start-server` on :3001.
- Datasource-specific projects (MySQL, MSSQL, CloudWatch, Loki…) need services we
  don't run — they fail/skip identically in both arms and fall out under pass-parity,
  same posture as nocodb's external-DB specs (195 skipped there).

## Build plan (deferred until the floor sweep finishes — the box must stay quiet, and
## disk needs clearing first: the session allowance is ~91% spent; grafana needs
## roughly 8–12 GB for checkout + yarn + go caches)

1. Disk: prune playwright outputs, package-manager caches, and if needed the n8n work
   trees (rebuildable from the recipe; their measured arms are committed).
2. `node ports/run.mts grafana` (TIERLESS_PIN=1 on first fetch to pin the tree hash).
3. `yarn install`, backend `make build-go` or `go run build.go build` (their tooling),
   frontend `yarn build` — then the e2e lane's own `start-server`.
4. Port patch: the `fromFetch` swap in backend_srv + `pnpm/yarn add tierless@link:…`;
   gateway is `tierless gateway --backend http://localhost:3001 --port 3101`
   (page port + 100 convention).
5. Suite driver (`suite.mts`) on the vikunja/nocodb template: boot, run a chosen
   project subset with the measure reporter, floor/truth arms, report.
