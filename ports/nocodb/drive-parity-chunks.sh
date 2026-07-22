#!/usr/bin/env bash
# Status-parity arms for the compile:'auto' surface, restart-resilient: one suite run
# per tests/db/<dir> per arm, checkpointed to results/chunks/<arm>-<dir>.jsonl and
# committed immediately (container restarts roll back uncommitted files and kill jobs;
# a lost chunk re-runs, finished chunks are skipped by file existence — the drive-arms
# pattern). Durations across chunk boundaries are not comparable to a continuous run;
# these arms are for STATUS parity only.
#   bash ports/nocodb/drive-parity-chunks.sh    (idempotent; safe to relaunch)
set -uo pipefail
cd "$(dirname "$0")/../.."
CHUNKS=ports/nocodb/results/chunks
mkdir -p "$CHUNKS"
DIRS=$(ls ports/work/nocodb/src/tests/playwright/tests/db/)

for arm in ported baseline; do
  flag=""; work=nocodb
  if [ "$arm" = baseline ]; then flag=--baseline; work=nocodb-baseline; fi
  for name in $DIRS; do
    out="$CHUNKS/$arm-$name.jsonl"
    if [ -s "$out" ]; then echo "== skip $arm/$name (done)"; continue; fi
    echo "== run $arm/$name"
    TIERLESS_SPEC="tests/db/$name" node --experimental-strip-types ports/nocodb/suite.mts $flag
    code=$?
    rows=$(wc -l < "ports/work/$work/measure.jsonl" 2>/dev/null || echo 0)
    if [ "$rows" -eq 0 ]; then echo "!! $arm/$name produced 0 rows (exit $code) — not checkpointed"; exit 1; fi
    cp "ports/work/$work/measure.jsonl" "$out"
    git add "$out" && git commit -q -m "nocodb parity chunk: $arm/$name ($rows rows)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011JsGFUBBubsTp15Gf6Fi3j" && git push -q origin claude/tierless-port-generality-uwm1f9 || echo "!! push failed for $arm/$name (kept locally)"
  done
done
echo "ALL CHUNKS DONE"
