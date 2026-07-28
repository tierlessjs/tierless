#!/usr/bin/env bash
# THE MANY-SMALL-REQUESTS NUMBER for n8n — the one docs/corpus.md records as unmeasured.
#
# Why it was not derivable before: the session's byte counter is a single TCP-true total,
# and /rest/community-node-types (a 12.66 MB catalogue) was 99.1% of the session's
# plaintext. Per-message compressed sizes are unobservable through a shared deflate
# window (server.mts), so splitting that total between the catalogue and the small calls
# would have been a guess.
#
# The BROWSE ADVISORY removes the confound: >1 MB replies return to browser HTTP, so on
# the current runtime the session carries ONLY the small calls and wireWs* IS the
# many-small figure, measured rather than inferred. Baseline is stock, so its small-API
# HTTP bytes come from the per-path log.
#
# Runs the editor chunk on both arms in budget mode (per-path HTTP + per-path SESSION
# logs, both kept). Editor is the largest chunk and the one every other n8n result used.
# Chained: waits for any grafana sweep to finish, frees its trees, rebuilds n8n.
#   bash ports/n8n/drive-smallslice.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
SP=/tmp/claude-0/-home-user-tierless/7647f3ec-cdd4-5925-82f8-2bb4d6d44004/scratchpad
OUT=ports/n8n/results/smallslice
BRANCH=claude/tierless-port-generality-uwm1f9
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
mkdir -p "$OUT"

# 1. don't contend with a running sweep — its byte arms are in flight
while pgrep -f "drive-truth-chunks|drive-floor-chunks" >/dev/null; do echo "waiting for grafana sweep..."; sleep 120; done
echo "SWEEP_CLEAR"

# 2. disk: n8n needs ~8 GB of trees and only ~4 GB is free with grafana's checked out.
# Grafana's measured arms are committed and its trees rebuild from the recipe.
if [ ! -d ports/work/n8n/src ] || [ ! -d ports/work/n8n-baseline/src ]; then
  rm -rf ports/work/grafana ports/work/grafana-baseline
  rm -rf /root/.cache/go-build
  echo "PRUNED  $(df -h / | tail -1)"
fi

# 3. rebuild both n8n trees (setup.sh owns fetch + install + build)
for arm in ported baseline; do
  flag=""; work=n8n
  [ "$arm" = baseline ] && { flag=--baseline; work=n8n-baseline; }
  if [ -d "ports/work/$work/src/packages/frontend/editor-ui/dist" ]; then echo "== $arm tree present"; continue; fi
  echo "== build $arm"
  bash ports/n8n/setup.sh $flag > "$SP/ss-setup-$arm.log" 2>&1 \
    && echo "BUILD_OK $arm" || { echo "BUILD_FAIL $arm"; tail -15 "$SP/ss-setup-$arm.log"; exit 1; }
done

# 4. the measured pair, budget mode so BOTH per-path logs land
SPEC="tests/e2e/workflows/editor"
for arm in ported baseline; do
  flag=""; work=n8n
  [ "$arm" = baseline ] && { flag=--baseline; work=n8n-baseline; }
  [ -s "$OUT/$arm-measure.jsonl" ] && { echo "== skip $arm (done)"; continue; }
  echo "== run $arm"
  TIERLESS_WIRE_TRUTH=1 TIERLESS_WIRE_BUDGET=1 TIERLESS_SPEC="$SPEC" \
    timeout 5400 node ports/n8n/suite.mts $flag > "$OUT/$arm.log" 2>&1
  rows=$(wc -l < "ports/work/$work/measure-truth.jsonl" 2>/dev/null || echo 0)
  echo "   $rows rows"
  [ "$rows" -lt 250 ] && { echo "!! $arm incomplete — NOT checkpointed"; continue; }
  cp "ports/work/$work/measure-truth.jsonl" "$OUT/$arm-measure.jsonl"
  cp "ports/work/$work/wire-http.jsonl" "$OUT/$arm-http.jsonl" && gzip -9f "$OUT/$arm-http.jsonl"
  cp "ports/work/$work/wire-session.jsonl" "$OUT/$arm-session.jsonl" 2>/dev/null && gzip -9f "$OUT/$arm-session.jsonl" || true
  grep -oE "[0-9]+ (passed|failed)" "$OUT/$arm.log" | tail -2 | tr '\n' ' '; echo
  git add "$OUT" && git commit -q -m "n8n small-slice arm: $arm ($rows rows, budget mode)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011JsGFUBBubsTp15Gf6Fi3j" \
    && git push -q -u origin "$BRANCH" || echo "!! commit/push failed"
done

# 5. the number
node ports/n8n/report-smallslice.mts
echo SMALLSLICE_DONE
