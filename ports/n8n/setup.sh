#!/usr/bin/env bash
# n8n work-tree setup — fetch, install, build, browsers: everything a suite run
# needs, from the recipe alone. Idempotent; sandbox rollbacks wipe ports/work.
#   bash ports/n8n/setup.sh [--baseline]     (baseline: test patches only, no port)
set -euo pipefail
cd "$(dirname "$0")/../.."
PORTS_DIR="$PWD/ports"
VARIANT=n8n
if [ "${1:-}" = "--baseline" ]; then VARIANT=n8n-baseline; fi

node ports/run.mts n8n ${1:-}
cd "ports/work/$VARIANT/src"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0   # their packageManager field pins pnpm 10.32.1

# Sandbox transport accommodation (see codeload-shim.mts): one lockfile dep is a
# codeload tarball; when the proxy 403s codeload but git smart-http is open, serve
# the same sha locally at the same URL for the duration of the install.
SHIM_PID=""
cleanup() {
  if [ -n "$SHIM_PID" ]; then kill "$SHIM_PID" 2>/dev/null || true; sed -i '/tierless-codeload-shim/d' /etc/hosts; fi
}
trap cleanup EXIT
if ! curl -sfI --max-time 15 "https://codeload.github.com/rhashimoto/wa-sqlite/tar.gz/779219540f66cecaa159da32b3b8936697ba10a7" >/dev/null 2>&1; then
  echo "codeload unreachable here — starting the local shim (git transport for the same sha)"
  node "$PORTS_DIR/n8n/codeload-shim.mts" &
  SHIM_PID=$!
  for _ in $(seq 1 30); do curl -skf "https://127.0.0.1/x" -o /dev/null --max-time 2 && break || sleep 1; done || true
  echo "127.0.0.1 codeload.github.com  # tierless-codeload-shim" >> /etc/hosts
  # ADD the shim cert to whatever CA bundle the environment already trusts (a proxied
  # sandbox wires its MITM CA through NODE_EXTRA_CA_CERTS — replacing it would break
  # every other TLS fetch in this install)
  cat ${NODE_EXTRA_CA_CERTS:+"$NODE_EXTRA_CA_CERTS"} "$PORTS_DIR/work/codeload-shim/cert.pem" > "$PORTS_DIR/work/codeload-shim/ca-bundle.pem"
  export NODE_EXTRA_CA_CERTS="$PORTS_DIR/work/codeload-shim/ca-bundle.pem"
  export NO_PROXY="codeload.github.com${NO_PROXY:+,$NO_PROXY}"
  export no_proxy="codeload.github.com${no_proxy:+,$no_proxy}"
fi

# their own memory-capped fresh-checkout path: install --frozen-lockfile, then
# turbo run build (concurrency 4 ≈ this sandbox's cores; logs in .agent-setup/)
corepack pnpm run agent:setup install --concurrency 4
cleanup; SHIM_PID=""; trap - EXIT

# ported tree only (adapter patch imports tierless): the runtime as a linked
# install, not a diff — same posture as Vikunja/NocoDB. Baseline never gets this.
if grep -q "tierless" packages/frontend/@n8n/rest-api-client/src/utils.ts 2>/dev/null; then
  (cd packages/frontend/@n8n/rest-api-client && corepack pnpm add "tierless@link:$PORTS_DIR/../packages/tierless")
fi

corepack pnpm run agent:setup build --concurrency 4

# their pinned @playwright/test wants its own chromium revision; fetch it to a
# writable path (the Playwright CDN is reachable)
cd packages/testing/playwright
PLAYWRIGHT_BROWSERS_PATH="$HOME/pw-browsers" PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD= \
  corepack pnpm exec playwright install chromium

echo "n8n setup complete ($VARIANT)"
