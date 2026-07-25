#!/usr/bin/env bash
# Join the chunked re-measurement into one arm pair and report it.
#
# The chunks are DISJOINT test sets, not repeated runs, so they concatenate: every
# per-test metric (durationMs, wire counters) is measured within its own chunk and is
# unaffected by the split. Passing them to report.mts as separate RUNS would be wrong —
# it takes medians across runs and gates on every run passing, and a test appears in
# exactly one chunk.
#
# Suite-level wall time is NOT comparable to a continuous run (each chunk re-boots n8n);
# per-test durations and byte totals are.
#
#   bash ports/n8n/report-remeasure.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=ports/n8n/results/remeasure

for arm in baseline ported; do
  files=$(ls "$OUT/$arm"-*-measure.jsonl 2>/dev/null || true)
  [ -z "$files" ] && { echo "no $arm chunks yet"; exit 1; }
  cat $files > "$OUT/$arm-all.jsonl"
  echo "$arm: $(echo "$files" | wc -l) chunk(s), $(wc -l < "$OUT/$arm-all.jsonl") test rows"
done

echo
node ports/report.mts "$OUT/baseline-all.jsonl" "$OUT/ported-all.jsonl"

echo
echo "=== nodes.json double-fetch, both arms (the confound commonPatches/0006 removes) ==="
node ports/n8n/report-dedupe.mts
