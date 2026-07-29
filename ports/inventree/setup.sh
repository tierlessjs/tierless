#!/usr/bin/env bash
# One-time setup for one InvenTree arm's work tree (ports/inventree/README.md).
#
#   bash ports/inventree/setup.sh [--baseline]
#
# Fetches the recipe tree, installs the frontend deps (plus the tierless link on the
# ported arm), migrates a SQLite database, loads the demo dataset, builds the frontend
# into Django's STATIC_ROOT, and snapshots data/pristine — which boot.mts restores before
# every arm so no run inherits the previous one's records.
#
# The python venv is SHARED by both arms (ports/work/inventree-venv): the packages are
# arm-independent, and the state that is not — database, media, static — lives per tree.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$PWD"
VARIANT=inventree; FLAG=""
[ "${1:-}" = "--baseline" ] && { VARIANT=inventree-baseline; FLAG=--baseline; }
WORK="$ROOT/ports/work/$VARIANT"
VENV="$ROOT/ports/work/inventree-venv"

# 1. the recipe tree (patched, or stock on --baseline)
node ports/run.mts inventree $FLAG

# 2. the shared python environment
if [ ! -x "$VENV/bin/invoke" ]; then
  uv venv "$VENV" --python 3.11
  VIRTUAL_ENV="$VENV" uv pip install -U invoke wheel setuptools
  VIRTUAL_ENV="$VENV" uv pip install -r "$WORK/src/src/backend/requirements.txt"
  VIRTUAL_ENV="$VENV" uv pip install -r "$WORK/src/src/backend/requirements-dev.txt"
fi

cp ports/inventree/env.sh "$WORK/env.sh"
# shellcheck source=/dev/null
source "$WORK/env.sh"
cd "$WORK/src"

# 3. frontend deps, plus the tierless link. BOTH arms need it: the port patch imports it
# on the ported side, and the transport-waits TEST patch imports it on both.
yarn --cwd src/frontend install --network-timeout 600000
yarn --cwd src/frontend add "tierless@link:$ROOT/packages/tierless"

# 4. database + demo dataset. Their CI clones the demo-dataset branch matching the target
# branch; 1.4.x does not exist there yet, and setup_test falls back to main on its own.
invoke migrate
invoke dev.setup-test -i --branch 1.4.x

# 5. build the frontend into STATIC_ROOT (their firefox lane's mode), with the two
# playwright fixture images their custom-branding specs expect
cp src/frontend/tests/fixtures/playwright_custom_logo.png src/backend/InvenTree/InvenTree/static/img/playwright_custom_logo.png
cp src/frontend/tests/fixtures/playwright_custom_splash.png src/backend/InvenTree/InvenTree/static/img/playwright_custom_splash.png
invoke int.frontend-compile
invoke static

# 6. the pristine snapshot boot.mts restores per run
rm -rf "$WORK/data/pristine"
mkdir -p "$WORK/data/pristine"
cp "$WORK/data/inventree.sqlite3" "$WORK/data/pristine/inventree.sqlite3"
cp -a "$WORK/data/media" "$WORK/data/pristine/media"
echo "SETUP_OK $VARIANT"
