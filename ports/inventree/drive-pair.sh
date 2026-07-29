#!/usr/bin/env bash
# One InvenTree arm PAIR, checkpointed per arm so a container restart resumes instead of
# starting over (docs/corpus.md run protocol).
#
#   bash ports/inventree/drive-pair.sh            floor arms (wall clock, no instrumentation)
#   MODE=truth  bash ports/inventree/drive-pair.sh   truth+budget arms (bytes, per-path logs)
#
# Both arms run back to back on the same quiet box, single worker, from a pristine
# database each (boot.mts restores it). Results land in ports/inventree/results/<mode>/
# and are committed per arm.
set -uo pipefail
cd "$(dirname "$0")/../.."

# SINGLE-INSTANCE LOCK. Two copies of the grafana driver once ran against the same work
# tree and the same instance, appending to the same measure-truth.jsonl: 200 rows for 105
# tests, and nothing detected it but the row count. A measurement driver must be unable to
# race itself.
exec 9>/tmp/tierless-inventree-pair.lock
flock -n 9 || { echo "another drive-pair.sh is already running — refusing to start"; exit 1; }

MODE="${MODE:-floor}"
OUT="ports/inventree/results/$MODE"
BRANCH=claude/tierless-port-generality-uwm1f9
mkdir -p "$OUT"

# PRISTINE PARITY. The arms have separate databases, so "same demo dataset" is an
# assumption, not a fact — and it silently broke once: the ported tree's snapshot was
# taken AFTER a suite run against it and carried that run's mutations (779 supplier parts
# vs 778). Their pui_company spec asserts an exact count, so it failed on the ported arm
# and passed on the baseline, which reads as a port defect and is not one.
counts() {
  python3 - "$1" <<'PY'
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
print(*(c.execute(f'select count(*) from {t}').fetchone()[0] for t in
        ('part_part', 'part_supplierpart', 'build_build', 'stock_stockitem', 'order_purchaseorder', 'order_salesorder')))
PY
}
a=$(counts ports/work/inventree/data/pristine/inventree.sqlite3)
b=$(counts ports/work/inventree-baseline/data/pristine/inventree.sqlite3)
[ "$a" = "$b" ] || { echo "!! the arms' pristine databases DISAGREE — refusing to measure
   ported   $a
   baseline $b
   re-run \`invoke dev.setup-test -i\` in the odd one out and re-snapshot data/pristine"; exit 1; }
echo "pristine parity OK ($a)"

env_for() {
  case "$MODE" in
    truth) echo "TIERLESS_WIRE_TRUTH=1 TIERLESS_WIRE_BUDGET=1" ;;
    floor) echo "" ;;
    *) echo "unknown MODE=$MODE (floor|truth)" >&2; exit 2 ;;
  esac
}
SUFFIX=""; [ "$MODE" = truth ] && SUFFIX="-truth"

for arm in ported baseline; do
  flag=""; work=inventree
  [ "$arm" = baseline ] && { flag=--baseline; work=inventree-baseline; }
  [ -s "$OUT/$arm-measure$SUFFIX.jsonl" ] && { echo "== skip $arm (done)"; continue; }
  [ -d "ports/work/$work/data/pristine" ] || { echo "!! $work not set up — bash ports/inventree/setup.sh $flag"; exit 1; }
  echo "== run $arm ($MODE)"
  # shellcheck disable=SC2046
  env $(env_for) timeout 14400 node ports/inventree/suite.mts $flag > "$OUT/$arm$SUFFIX.log" 2>&1
  rows=$(wc -l < "ports/work/$work/measure$SUFFIX.jsonl" 2>/dev/null || echo 0)
  echo "   $rows rows"
  [ "$rows" -lt 120 ] && { echo "!! $arm incomplete — NOT checkpointed"; continue; }
  cp "ports/work/$work/measure$SUFFIX.jsonl" "$OUT/$arm-measure$SUFFIX.jsonl"
  if [ "$MODE" = truth ]; then
    cp "ports/work/$work/wire-http.jsonl" "$OUT/$arm-http.jsonl" && gzip -9f "$OUT/$arm-http.jsonl"
    cp "ports/work/$work/wire-session.jsonl" "$OUT/$arm-session.jsonl" 2>/dev/null && gzip -9f "$OUT/$arm-session.jsonl" || true
  fi
  grep -oE "[0-9]+ (passed|failed|flaky)" "$OUT/$arm$SUFFIX.log" | tail -3 | tr '\n' ' '; echo
  git add "$OUT" && git commit -q -m "inventree $MODE arm: $arm ($rows rows)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011JsGFUBBubsTp15Gf6Fi3j" \
    && git push -q -u origin "$BRANCH" || echo "!! commit/push failed"
done

if [ "$MODE" = truth ]; then node ports/report-marginal.mts "$OUT"; else node ports/report.mts "$OUT"; fi
echo "INVENTREE_${MODE}_DONE"
