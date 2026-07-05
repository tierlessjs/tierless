# Vikunja port (v1.0.0, sha 3ba5192b)

Their newest release (tagged 2026-01-27; GitHub's "latest release" page shows v2.3.0
because it sorts by semver and Vikunja renumbered). Verified from source: Vite 7.3.1 +
Vue 3.5.27 frontend with a 31-spec Playwright e2e suite; Go backend, SQLite default —
never modified (the port's server side will be the REST-proxy adapter + gateway).

## Reproduce

    node ports/run.mts vikunja                      # fetch (codeload, goproxy fallback) + verify
    cd ports/work/vikunja/src/frontend && corepack pnpm install --frozen-lockfile && corepack pnpm run build
    cd ../ && go build -o vikunja .                 # embeds frontend/dist
    node ports/vikunja/boot.mts                     # API :3456 + frontend :4173, their CI env
    node ports/vikunja/journeys/project-view.mts    # the measured journey

## Baseline (BEFORE, measured)

Journey: warm SPA, logged in, click a project with 20 tasks — the interaction behind
their tests/e2e/project/project-view-list.spec.ts. API-origin traffic only (the SPA
bundle is identical before/after any port). Measured via bench/harness:

    10 HTTP requests · 5.8 KB out / 22.4 KB in · 28.3 KB total
    modeled network wait @ 80 ms RTT, 10 Mbps: 823 ms

The waterfall is a real-world mosaic: GET /user and the avatar each fetched TWICE in
one interaction, two CORS preflights (cross-origin API), then the dependent chain
projects/1 (1.7 KB) -> views/1/tasks (14.4 KB). Redundant re-fetches, preflights, and
a dependent chain in a single click — nobody wrote this on purpose; it accreted.

## Next (the actual port)

Extract the open-project workflow into a "use tierless" module through their Vite
config (patch series), REST-proxy the api.* resources onto their Go API, mount the
gateway host, re-run the SAME journey for the AFTER number.
