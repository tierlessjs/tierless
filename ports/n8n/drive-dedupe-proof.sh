#!/usr/bin/env bash
# Does commonPatches/0006 actually remove concurrent nodes.json fetches?
#
# The claim needs BOTH arms of the same tree: with the fix and with it reverted. A spec
# that never races reports 0 overlapping either way, which is how the workflows-list
# spec produced a meaningless "confirmed" (see results/dedupe-check). So this driver
# always runs the ablation too, and the report prints them side by side.
#
# The race needs a page to boot and init a canvas CONCURRENTLY — a hard load onto
# /workflow/<id>, not SPA navigation. Pick specs accordingly.
#
#   bash ports/n8n/drive-dedupe-proof.sh <label> "<spec paths>"
#
# Resumable: finished arms are skipped by file existence. Self-restoring: the fix goes
# back and the editor is rebuilt even if a run fails.
set -uo pipefail
cd "$(dirname "$0")/../.."
LABEL=${1:?usage: drive-dedupe-proof.sh <label> "<spec paths>"}
SPEC=${2:?usage: drive-dedupe-proof.sh <label> "<spec paths>"}
SP=/tmp/claude-0/-home-user-tierless/7647f3ec-cdd4-5925-82f8-2bb4d6d44004/scratchpad
OUT=ports/n8n/results/dedupe-proof
TREE="$PWD/ports/work/n8n/src"
PATCHF="$PWD/ports/n8n/patches/0006-node-types-inflight-dedupe.patch"
STORE=packages/frontend/editor-ui/src/app/stores/nodeTypes.store.ts
mkdir -p "$OUT"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

build() { (cd "$TREE" && corepack pnpm --filter n8n-editor-ui run build) > "$SP/proof-build.log" 2>&1; }
have_fix() { grep -q nodeTypesInFlight "$TREE/$STORE"; }
restore() {
  have_fix || (cd "$TREE" && patch -p1 --no-backup-if-mismatch -i "$PATCHF" >/dev/null)
  build && echo "RESTORED (fix back, editor rebuilt)" || echo "RESTORE_BUILD_FAIL"
}
trap restore EXIT

run_arm() {   # $1 = fixed|ablate
  local arm=$1 out="$OUT/$LABEL-$1-http.jsonl"
  [ -s "$out" ] && { echo "skip $arm (have it)"; return 0; }
  if [ "$arm" = ablate ]; then
    have_fix && (cd "$TREE" && patch -p1 -R --no-backup-if-mismatch -i "$PATCHF" >/dev/null)
  else
    have_fix || (cd "$TREE" && patch -p1 --no-backup-if-mismatch -i "$PATCHF" >/dev/null)
  fi
  build || { echo "BUILD_FAIL $arm"; tail -20 "$SP/proof-build.log"; return 1; }
  echo "=== $LABEL / $arm ==="
  TIERLESS_WIRE_TRUTH=1 TIERLESS_WIRE_BUDGET=1 TIERLESS_SPEC="$SPEC" \
    node ports/n8n/suite.mts > "$OUT/$LABEL-$arm.log" 2>&1
  grep -oE "[0-9]+ (passed|failed)" "$OUT/$LABEL-$arm.log" | tail -2 | tr '\n' ' '; echo
  cp ports/work/n8n/wire-http.jsonl "$out" || { echo "NO HTTP LOG $arm"; return 1; }
  cp ports/work/n8n/measure-truth.jsonl "$OUT/$LABEL-$arm-measure.jsonl" 2>/dev/null || true
}

run_arm ablate
run_arm fixed
echo PROOF_DONE
