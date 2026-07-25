#!/usr/bin/env bash
# Re-drive the TCP-true arm pair for vikunja / strapi / nocodb under the FIXED measure
# reporter, and diff against the published numbers.
#
# Why: those headlines were measured when the reporter took two INDEPENDENT counter reads
# per test, so traffic between tests belonged to neither and vanished from per-test sums.
# On n8n that loss was 2.53% of one arm against 1.21% of the other — an asymmetry larger
# than the difference being measured there. The reporter now chains snapshots
# (conservation: sum of deltas == total counter movement), so a re-run measures the bias
# directly instead of us bounding it by assumption. No app rebuild is needed: the reporter
# is a linked package running in the Playwright process, not in the browser bundle.
#
# Checkpointed per arm and committed immediately; finished arms skip on relaunch.
#
#   bash ports/drive-truth-recheck.sh
set -uo pipefail
cd "$(dirname "$0")/.."
OUT=ports/results-recheck
mkdir -p "$OUT"
BRANCH=claude/tierless-port-generality-uwm1f9

run() {   # $1 = port, $2 = arm (baseline|ported)
  local port=$1 arm=$2 flag=""
  [ "$arm" = baseline ] && flag=--baseline
  local out="$OUT/$port-$arm-truth.jsonl"
  [ -s "$out" ] && { echo "== skip $port/$arm (done)"; return 0; }
  echo "== run $port/$arm"
  TIERLESS_WIRE_TRUTH=1 node "ports/$port/suite.mts" $flag > "$OUT/$port-$arm.log" 2>&1
  local work=$port; [ "$arm" = baseline ] && work="$port-baseline"
  local src="ports/work/$work/measure-truth.jsonl"
  [ -s "$src" ] || { echo "!! $port/$arm produced no artifact"; return 1; }
  cp "$src" "$out"
  grep -oE "[0-9]+ (passed|failed)" "$OUT/$port-$arm.log" | tail -2 | tr '\n' ' '
  echo "($(wc -l < "$out") rows)"
  git add "$out" && git commit -q -m "truth recheck: $port/$arm under the fixed reporter

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011JsGFUBBubsTp15Gf6Fi3j" \
    && git push -q -u origin "$BRANCH" || echo "!! commit/push failed for $port/$arm"
}

# vikunja is NOT in this loop: its suite writes measure.jsonl for the wire-truth arm too,
# where strapi and nocodb write measure-truth.jsonl. Assuming the suffix here reported
# "no artifact" for a vikunja run that had completed. It has its own driver.
for port in strapi nocodb; do
  run "$port" baseline
  run "$port" ported
done
echo ALL_RECHECK_DONE
