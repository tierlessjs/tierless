#!/usr/bin/env bash
# One-time setup for one Keycloak arm's work tree (ports/keycloak/README.md).
#
#   bash ports/keycloak/setup.sh [--baseline]
#
# Fetches the recipe tree, installs the js workspace (plus the tierless link), builds the
# admin console, injects the build into a pinned RELEASE distribution's admin-ui jar, and
# snapshots the H2 database boot.mts restores before every arm.
#
# The distribution zip is SHARED by both arms (ports/work/keycloak-dist): it is
# arm-independent, and 168 MB is worth downloading once. What differs per arm is the one
# jar we rewrite.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$PWD"
VARIANT=keycloak; FLAG=""
[ "${1:-}" = "--baseline" ] && { VARIANT=keycloak-baseline; FLAG=--baseline; }
WORK="$ROOT/ports/work/$VARIANT"
VERSION=26.7.0
DIST="$ROOT/ports/work/keycloak-dist"

# 1. the recipe tree (port patch + test patches, or test patches only on --baseline)
node ports/run.mts keycloak $FLAG

# 2. the shared release distribution
if [ ! -x "$DIST/keycloak-$VERSION/bin/kc.sh" ]; then
  mkdir -p "$DIST"
  curl -sSL --fail -o "$DIST/keycloak-$VERSION.zip" \
    "https://github.com/keycloak/keycloak/releases/download/$VERSION/keycloak-$VERSION.zip"
  unzip -q "$DIST/keycloak-$VERSION.zip" -d "$DIST"
  chmod +x "$DIST/keycloak-$VERSION/bin/kc.sh"
fi

cd "$WORK/src/js"

# 3. workspace deps, plus the tierless link. BOTH arms need it in admin-ui: the
# transport-waits TEST patch imports tierless/playwright on both. Only the ported arm's
# admin-client imports it (port patch 0001), but linking it in both keeps the trees'
# dependency graphs identical, which is one less difference between the arms.
pnpm install
pnpm --filter @keycloak/keycloak-admin-ui add "tierless@link:$ROOT/packages/tierless"
if grep -q "tierlessFetch" libs/keycloak-admin-client/src/utils/fetchWithError.ts 2>/dev/null; then
  pnpm --filter @keycloak/keycloak-admin-client add "tierless@link:$ROOT/packages/tierless"
fi

# 4. build the console. wireit hashes only this package's own files, so a tierless edit is
# INVISIBLE to its cache and `pnpm build` reports a hit while restoring the previous
# bundle — the same class of trap turbo sprang on the n8n port. Dropping .wireit forces
# the vite build to actually run; ports/assert-fresh.mts is the backstop that catches it
# if this ever stops working.
pnpm --filter @keycloak/keycloak-admin-client build
rm -rf apps/admin-ui/.wireit apps/admin-ui/target/classes/theme/keycloak.v2/admin/resources
pnpm --filter @keycloak/keycloak-admin-ui build

# 5. this arm's distribution: the release tree with our console injected into the theme
# jar. Everything else in it — the Java server, every other jar — is byte-identical to the
# baseline arm's, which is a stronger control than building the server twice.
KC="$WORK/kc"
rm -rf "$KC"; cp -r "$DIST/keycloak-$VERSION" "$KC"
JAR="$KC/lib/lib/main/org.keycloak.keycloak-admin-ui-$VERSION.jar"
STAGE="$WORK/jar-stage"
rm -rf "$STAGE"; mkdir -p "$STAGE"
( cd "$STAGE" && unzip -q "$JAR" )
rm -rf "$STAGE/theme/keycloak.v2/admin/resources"
cp -r "$WORK/src/js/apps/admin-ui/target/classes/theme/keycloak.v2/admin/resources" "$STAGE/theme/keycloak.v2/admin/"
rm -f "$JAR"
( cd "$STAGE" && zip -qr "$JAR" . )
rm -rf "$STAGE"

# 6. the pristine database: boot once so Keycloak builds its H2 schema and the bootstrap
# admin user, then snapshot. boot.mts restores this before every arm.
rm -rf "$KC/data" "$WORK/kc-pristine-data"
KC_BOOTSTRAP_ADMIN_USERNAME=admin KC_BOOTSTRAP_ADMIN_PASSWORD=admin \
  timeout 300 "$KC/bin/kc.sh" start-dev --http-port=8080 > "$WORK/bootstrap.log" 2>&1 &
BOOT_PID=$!
for _ in $(seq 1 120); do
  curl -sf -o /dev/null "http://localhost:8080/realms/master/.well-known/openid-configuration" && break
  sleep 2
done
kill "$BOOT_PID" 2>/dev/null || true
wait "$BOOT_PID" 2>/dev/null || true
sleep 3
[ -d "$KC/data" ] || { echo "bootstrap left no data dir — see $WORK/bootstrap.log" >&2; exit 1; }
cp -r "$KC/data" "$WORK/kc-pristine-data"

# 7. their playwright (1.60) wants chromium-1223, which /opt/pw-browsers does not have.
if [ ! -d "${PLAYWRIGHT_BROWSERS_PATH:-/nonexistent}/chromium-1223" ] && [ ! -d "$HOME/pw-browsers/chromium-1223" ]; then
  PLAYWRIGHT_BROWSERS_PATH="$HOME/pw-browsers" PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD= \
    pnpm --filter @keycloak/keycloak-admin-ui exec playwright install chromium
fi

echo "keycloak setup complete ($VARIANT)"
