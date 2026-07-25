#!/usr/bin/env bash
# vikunja's half of the truth recheck, separated because its artifact is named
# differently: suite.mts writes measure.jsonl for BOTH the plain and wire-truth arms
# (only RTT/BPS add a suffix), where strapi and nocodb write measure-truth.jsonl. The
# cross-port driver assumed the -truth suffix and reported "no artifact" for a vikunja
# run that had in fact completed.
#
# Run this only when the box is otherwise quiet — it boots vikunja's own stack.
#
#   bash ports/drive-vikunja-recheck.sh
set -uo pipefail
cd "$(dirname "$0")/.."
OUT=ports/results-recheck
mkdir -p "$OUT"
BRANCH=claude/tierless-port-generality-uwm1f9

for arm in baseline ported; do
  flag=""; work=vikunja
  [ "$arm" = baseline ] && { flag=--baseline; work=vikunja-baseline; }
  out="$OUT/vikunja-$arm-truth.jsonl"
  [ -s "$out" ] && { echo "== skip vikunja/$arm (done)"; continue; }
  echo "== run vikunja/$arm"
  TIERLESS_WIRE_TRUTH=1 node ports/vikunja/suite.mts $flag > "$OUT/vikunja-$arm.log" 2>&1
  src="ports/work/$work/measure.jsonl"
  [ -s "$src" ] || { echo "!! vikunja/$arm produced no artifact at $src"; continue; }
  cp "$src" "$out"
  grep -oE "[0-9]+ (passed|failed)" "$OUT/vikunja-$arm.log" | tail -2 | tr '\n' ' '
  echo "($(wc -l < "$out") rows)"
  git add "$out" && git commit -q -m "truth recheck: vikunja/$arm under the fixed reporter

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011JsGFUBBubsTp15Gf6Fi3j" \
    && git push -q -u origin "$BRANCH" || echo "!! commit/push failed for vikunja/$arm"
done
echo VIKUNJA_RECHECK_DONE
