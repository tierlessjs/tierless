# NocoDB port (v2026.06.1, sha aa3fa4a8)

Second corpus app (docs/corpus.md rung 3): the porting recipe hardened on a
structurally different workload than Vikunja. NocoDB is a data-grid app — the
request shapes Vikunja mostly lacked: opening a base is a sequential dependency
chain (table meta → columns → views → rows), grid scrolling is paged fetches,
cell edits are update + refresh. This is the test of whether §6 chain migration
moves a suite-level number, and a data point for the burst-coalescing
review-or-remove item (ROADMAP.md).

## The target

- Frontend: Vue 3 via **Nuxt** (Vite underneath; SPA at runtime, served by the
  Nuxt node server on :3000, `NUXT_PUBLIC_NC_BACKEND_URL` → backend :8080).
- Service layer: `nocodb-sdk` — swagger-generated `Api` class with **axios** at
  the bottom (`--axios --unwrap-response-data`), wrapped by nc-gui's `useApi`
  with app interceptors. Same I/O-bottom seam as Vikunja's 0005 adapter.
- Backend: Node (Express + Knex), **SQLite lane** for tests
  (`DATABASE_URL=sqlite:./test_noco.db`), plus an `nc-sql-executor` sidecar.
- Their own workload: **tests/playwright — 99 spec files, ~351 tests**. CI runs
  the CE suite as 3 shards; the sqlite lane pins `workers=1` (their
  playwright.config), so a full local arm is LONG — iteration happens on spec
  subsets, full runs are reserved for measured arms.
- License: **Sustainable Use License** (fair-code; changed from AGPL upstream).
  Fine for this benchmarking-and-patch-recipe use — we never vendor their code —
  but quote results with the license named.

## Reproduce (stock boot, the CE+sqlite CI lane without docker/S3)

    node ports/run.mts nocodb          # fetch at the pinned sha, verify tree hash
    cd ports/work/nocodb/src
    corepack pnpm@10.12.1 run bootstrap:ce
    # sidecar:   packages/nc-sql-executor    pnpm run dev &
    # backend:   packages/nocodb             pnpm run watch:run:playwright &   (sqlite, :8080)
    # frontend:  packages/nc-gui             pnpm run build && ci:start        (:3000)
    # suite:     tests/playwright            E2E_DB_TYPE=sqlite pnpm exec playwright test

Transport note: this sandbox's proxy blocks codeload zips for out-of-scope
repos; the recipe's `git` transport (shallow clone at the release tag, checkout
verified against the pinned sha) is the one that works here. The tree hash pins
content either way.

## Status

- Recipe pinned and fetched (git transport, tree hash verified).
- Stock boot: IN PROGRESS — bootstrap:ce installing.
- Go/no-go gate: their suite passing stock in this sandbox before any porting.
