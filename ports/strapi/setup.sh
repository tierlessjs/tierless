#!/usr/bin/env bash
# Strapi work-tree setup — the verified procedure from README.md as one idempotent
# command, because sandbox rollbacks periodically wipe ports/work. Fetch, install,
# build, browsers: everything a suite run needs, from the recipe alone.
#   bash ports/strapi/setup.sh [--baseline]     (baseline: test patches only, no port)
set -euo pipefail
cd "$(dirname "$0")/../.."
VARIANT=strapi
if [ "${1:-}" = "--baseline" ]; then VARIANT=strapi-baseline; fi

node ports/run.mts strapi ${1:-}
cd "ports/work/$VARIANT/src"

# Their vendored yarn (yarnPath .yarn/releases/yarn-4.12.0.cjs) via corepack.
corepack yarn install --immutable

# ported tree only (patch 0002 imports tierless): the runtime as a linked install, not
# a diff — same posture as the vikunja/nocodb ports. The baseline tree never gets port
# patches or this. (7 ups: packages/core/admin -> repo root.)
if grep -q "tierlessFetch" packages/core/admin/admin/src/utils/getFetchClient.ts 2>/dev/null; then
  corepack yarn workspace @strapi/admin add "tierless@link:../../../../../../../packages/tierless"
fi

# Full build (their `yarn setup` equivalent): dists for yalc, types included —
# `strapi develop` loads @strapi/types/dist at runtime, build:code alone omits it.
corepack yarn build

# Their @playwright/test (1.56.1) wants chromium-1194. Use a preinstalled set when it
# has that revision; otherwise fetch it to a writable path (the Playwright CDN is
# reachable where GitHub release assets are not).
if [ ! -d "${PLAYWRIGHT_BROWSERS_PATH:-/nonexistent}/chromium-1194" ]; then
  PLAYWRIGHT_BROWSERS_PATH="$HOME/pw-browsers" PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD= \
    corepack yarn playwright install chromium
  echo "chromium installed to $HOME/pw-browsers — export PLAYWRIGHT_BROWSERS_PATH=$HOME/pw-browsers for suite runs"
fi

echo "strapi setup complete ($VARIANT)"
