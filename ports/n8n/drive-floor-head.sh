#!/usr/bin/env bash
# The n8n FLOOR-WALL arms, restart-resilient.
#
# NO counting relay and NO budget proxy. Those add two userspace relay hops on the app
# origin plus a third on the session socket, which only the ported arm uses for data —
# an asymmetric instrument cost that reads as a port regression (the wire-truth pair
# shows +23% wall against +8% for uninstrumented floors; the gap is the relay).
# suite.mts already refuses to combine wire truth with RTT injection for the same reason.
# Wall time here is therefore the metric; bytes come from the remeasure pair instead.
#
# The published +8% wall / +294 MB predate three landed fixes (gateway re-serialization,
# upstreamIdentity, raw-body passthrough — ~390 ms/crossing at node-types size) AND the
# nodes.json double-fetch confound, which is now removed in BOTH arms by
# commonPatches/0006. Nothing has re-measured either number since, so this drives the
# arm pair again with wire truth + per-path budget.
#
# One suite run per spec group per arm, checkpointed to results/remeasure/<arm>-<group>.*
# and committed immediately: container restarts roll back uncommitted files and kill
# jobs, so a lost chunk re-runs while finished ones are skipped by file existence.
# Chunk boundaries make SUITE wall time incomparable to a continuous run; per-test
# durationMs and all byte totals stay additive and valid.
#
#   bash ports/n8n/drive-remeasure-chunks.sh    (idempotent; safe to relaunch)
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT=ports/n8n/results/floor-head
mkdir -p "$OUT"
BRANCH=claude/tierless-port-generality-uwm1f9

# grouped to balance run length against per-chunk n8n boot cost (~1-2 min each);
# workflows is by far the biggest dir so it is split by subdirectory.
# NOT named GROUPS: that is a bash built-in holding the caller's gid list, and bash
# ignores/rejects assignment to it — the loop then iterates over "0" and every chunk
# runs an empty spec filter.
CHUNKS=(
  "editor:tests/e2e/workflows/editor"
  "wf-rest:tests/e2e/workflows/list tests/e2e/workflows/executions tests/e2e/workflows/templates tests/e2e/workflows/checklist tests/e2e/workflows/demo-diff.spec.ts tests/e2e/workflows/demo-executable-chat-trigger.spec.ts"
  "ai:tests/e2e/ai tests/e2e/instance-ai tests/e2e/chat-hub"
  "nodes:tests/e2e/nodes tests/e2e/node-creator tests/e2e/building-blocks"
  "settings:tests/e2e/settings tests/e2e/app-config tests/e2e/capabilities"
  "projects:tests/e2e/projects tests/e2e/sharing tests/e2e/source-control"
  "creds:tests/e2e/credentials tests/e2e/dynamic-credentials tests/e2e/redaction-enforcement"
  "misc:tests/e2e/api tests/e2e/auth tests/e2e/regression tests/e2e/mcp tests/e2e/mcp-registry tests/e2e/data-tables tests/e2e/cloud tests/e2e/sentry tests/e2e/journeys"
)

for arm in ported baseline; do
  flag=""; work=n8n
  [ "$arm" = baseline ] && { flag=--baseline; work=n8n-baseline; }
  for entry in "${CHUNKS[@]}"; do
    name=${entry%%:*}; specs=${entry#*:}
    out="$OUT/$arm-$name-measure.jsonl"
    [ -s "$out" ] && { echo "== skip $arm/$name (done)"; continue; }
    echo "== run $arm/$name"
    TIERLESS_SPEC="$specs" \
      node ports/n8n/suite.mts $flag > "$OUT/$arm-$name.log" 2>&1
    rows=$(wc -l < "ports/work/$work/measure.jsonl" 2>/dev/null || echo 0)
    if [ "$rows" -eq 0 ]; then echo "!! $arm/$name produced 0 rows — not checkpointed"; continue; fi
    cp "ports/work/$work/measure.jsonl" "$out"
    grep -oE "[0-9]+ (passed|failed)" "$OUT/$arm-$name.log" | tail -2 | tr '\n' ' '; echo "($rows rows)"
    git add "$OUT/$arm-$name-measure.jsonl" 2>/dev/null
    git commit -q -m "n8n floor-head chunk (post storage-advisory rework): $arm/$name ($rows rows)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011JsGFUBBubsTp15Gf6Fi3j" \
      && git push -q -u origin "$BRANCH" || echo "!! commit/push failed for $arm/$name (kept locally)"
  done
done
echo ALL_REMEASURE_CHUNKS_DONE
