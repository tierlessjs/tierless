#!/usr/bin/env bash
# One Keycloak arm PAIR, checkpointed per arm so a container restart resumes instead of
# starting over (docs/corpus.md run protocol).
#
#   bash ports/keycloak/drive-pair.sh              floor arms (wall clock, no instrumentation)
#   MODE=truth bash ports/keycloak/drive-pair.sh   truth+budget arms (bytes, per-path logs)
#
# Both arms run back to back on the same quiet box, single worker, from a pristine H2
# database each (boot.mts restores it). Results land in ports/keycloak/results/<mode>/ and
# are committed per arm.
set -uo pipefail
cd "$(dirname "$0")/../.."

# SINGLE-INSTANCE LOCK. Two copies of the grafana driver once ran against the same work
# tree and the same instance, appending to the same measure-truth.jsonl: 200 rows for 105
# tests, and nothing detected it but the row count.
exec 9>/tmp/tierless-keycloak-pair.lock
flock -n 9 || { echo "another drive-pair.sh is already running — refusing to start"; exit 1; }

MODE="${MODE:-floor}"
OUT="ports/keycloak/results/$MODE"
BRANCH=claude/tierless-port-generality-rescue-an26nc
mkdir -p "$OUT"

# PRISTINE PARITY. The arms have separate databases, so "same starting rows" is an
# assumption, not a fact — and on InvenTree it silently broke, because one arm's snapshot
# had been taken after a suite run against it. Keycloak's bootstrap is deterministic
# (empty master realm + one admin user), so a mismatch in the realm/client/user counts
# means one arm's snapshot is dirty.
counts() {
  ( cd "$1" && find . -path ./tmp -prune -o -type f -print | wc -l )
}
a=$(counts ports/work/keycloak/kc-pristine-data)
b=$(counts ports/work/keycloak-baseline/kc-pristine-data)
[ "$a" = "$b" ] || { echo "!! the arms' pristine data dirs DISAGREE ($a vs $b files) — refusing to measure
   re-run bash ports/keycloak/setup.sh for the odd one out"; exit 1; }
echo "pristine parity OK ($a files)"

env_for() {
  case "$MODE" in
    truth) echo "TIERLESS_WIRE_TRUTH=1 TIERLESS_WIRE_BUDGET=1" ;;
    floor) echo "" ;;
    *) echo "unknown MODE=$MODE (floor|truth)" >&2; exit 2 ;;
  esac
}
SUFFIX=""; [ "$MODE" = truth ] && SUFFIX="-truth"

for arm in ported baseline; do
  flag=""; work=keycloak
  [ "$arm" = baseline ] && { flag=--baseline; work=keycloak-baseline; }
  [ -s "$OUT/$arm-measure$SUFFIX.jsonl" ] && { echo "== skip $arm (done)"; continue; }
  [ -d "ports/work/$work/kc-pristine-data" ] || { echo "!! $work not set up — bash ports/keycloak/setup.sh $flag"; exit 1; }
  echo "== run $arm ($MODE)"
  # shellcheck disable=SC2046
  env $(env_for) timeout 14400 node ports/keycloak/suite.mts $flag > "$OUT/$arm$SUFFIX.log" 2>&1
  rows=$(wc -l < "ports/work/$work/measure$SUFFIX.jsonl" 2>/dev/null || echo 0)
  echo "   $rows rows"
  [ "$rows" -lt 150 ] && { echo "!! $arm incomplete — NOT checkpointed"; continue; }
  cp "ports/work/$work/measure$SUFFIX.jsonl" "$OUT/$arm-measure$SUFFIX.jsonl"
  if [ "$MODE" = truth ]; then
    cp "ports/work/$work/wire-http.jsonl" "$OUT/$arm-http.jsonl" && gzip -9f "$OUT/$arm-http.jsonl"
    cp "ports/work/$work/wire-session.jsonl" "$OUT/$arm-session.jsonl" 2>/dev/null && gzip -9f "$OUT/$arm-session.jsonl" || true
  fi
  grep -oE "[0-9]+ (passed|failed|flaky)" "$OUT/$arm$SUFFIX.log" | tail -3 | tr '\n' ' '; echo
  git add "$OUT" && git commit -q -m "keycloak $MODE arm: $arm ($rows rows)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EJ4xGkzqNv622MKvKSGWFC" \
    && git push -q -u origin "$BRANCH" || echo "!! commit/push failed"
done

# report-marginal takes the results DIR; report.mts takes the two measure files.
if [ "$MODE" = truth ]; then node ports/report-marginal.mts "$OUT"
else node ports/report.mts "$OUT/baseline-measure.jsonl" "$OUT/ported-measure.jsonl"; fi
echo "KEYCLOAK_${MODE}_DONE"
