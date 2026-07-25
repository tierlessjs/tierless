#!/usr/bin/env bash
# Preboot over-delivery: the A/B that prices it directly.
#
# The hello pre-fetches all 18 manifest GETs per upgrade regardless of what the page
# consumes. If that is over-delivery, turning it OFF must be CHEAPER in ws bytes by
# roughly the unconsumed envelopes: with preboot on the hello carries all 18; with it
# off the page crosses only for the k it wants, and those k bytes are paid either way.
# So (ws bytes ON - ws bytes OFF) IS the wasted cargo. The same pair prices what
# preboot buys in wall time.
#
# CHUNKED and RESUMABLE: one arm-run per invocation of the suite, each written to its
# own file, existing files skipped. A container restart costs at most one run.
#
#   bash ports/n8n/drive-preboot-ab.sh [runs]      (default 3)
set -u
cd "$(dirname "$0")/../.."
OUT=ports/n8n/results/preboot-ab
mkdir -p "$OUT"
RUNS=${1:-3}
SPEC=${TIERLESS_SPEC:-tests/e2e/workflows/list/workflows.spec.ts}

for i in $(seq 1 "$RUNS"); do
  for arm in on off; do
    f="$OUT/$arm-$i.jsonl"
    [ -s "$f" ] && { echo "skip $f (have it)"; continue; }
    echo "=== run $i arm preboot=$arm ==="
    TIERLESS_WIRE_TRUTH=1 TIERLESS_PREBOOT=$([ "$arm" = on ] && echo 1 || echo 0) \
      TIERLESS_SPEC="$SPEC" node ports/n8n/suite.mts > "$OUT/$arm-$i.log" 2>&1
    tail -3 "$OUT/$arm-$i.log"
    cp ports/work/n8n/measure-truth.jsonl "$f" 2>/dev/null || echo "NO ARTIFACT for $arm-$i"
  done
done
echo ALL_RUNS_DONE
