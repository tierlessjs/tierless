#!/usr/bin/env bash
# NocoDB work-tree setup — the verified procedure from README.md as one idempotent
# command, because sandbox rollbacks periodically wipe ports/work. Fetch, install,
# build, browsers: everything a suite run needs, from the recipe alone.
#   bash ports/nocodb/setup.sh [--baseline]     (baseline: test patches only, no port)
set -euo pipefail
cd "$(dirname "$0")/../.."
VARIANT=nocodb
if [ "${1:-}" = "--baseline" ]; then VARIANT=nocodb-baseline; fi

node ports/run.mts nocodb ${1:-}
corepack prepare pnpm@10.12.1 --activate    # their CI's pnpm major; bare `pnpm` in their
                                            # scripts must not resolve to 11 (ignores pnpm.overrides)
cd "ports/work/$VARIANT/src"
export HUSKY=0                              # recipe tree has no .git; their prepare would fail

# bootstrap:ce, unrolled — with the sdk built EE: their integrations import EE sdk
# exports at this sha (src/ee IS in the public tree; their CI lane defaults ee=true)
corepack pnpm --filter=nocodb-sdk install
corepack pnpm --filter=nocodb-sdk run build:ee
corepack pnpm --filter=nocodb --filter=nc-gui --filter=nc-sql-executor --filter=playwright install
corepack pnpm run integrations:build
corepack pnpm run registerIntegrations

# UI: their CI downloads a prebuilt artifact from private S3; build locally instead.
# The root tsconfig extends ee/.nuxt/tsconfig.json — prepare the ee app once first.
cd packages/nc-gui
# ported tree only (patch 0002 imports tierless): the runtime as a linked install, not
# a diff — same posture as Vikunja. The baseline tree never gets port patches or this;
# the suite harness (waits, reporter) reaches tierless by absolute path (pw-wrapper.mts)
# and needs NO link at all.
if grep -q "tierless/adapt-auto" composables/useApi/interceptors.ts 2>/dev/null; then
  corepack pnpm add "tierless@link:../../../../../packages/tierless"
fi
EE=true corepack pnpm exec nuxt prepare ./ee
NODE_OPTIONS=--max_old_space_size=8192 corepack pnpm run build

# their pinned @playwright/test (1.55.1) wants chromium-1193; the sandbox preinstall
# has 1194 — fetch the right revision to a writable path (CDN is reachable)
cd ../../tests/playwright
PLAYWRIGHT_BROWSERS_PATH="$HOME/pw-browsers" PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD= \
  corepack pnpm exec playwright install chromium

echo "nocodb setup complete"
