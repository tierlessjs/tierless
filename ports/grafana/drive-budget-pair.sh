#!/usr/bin/env bash
# Grafana's MARGINAL numbers — the decomposition its truth arms cannot give.
#
# The truth sweep measured suite TOTALS (341 pairs, -0.6%, session 0.34% of bytes) with
# the counting relay only. Totals cannot separate the bundles a harness re-downloads per
# test from the API traffic a transport actually carries — the distinction that turned
# n8n's -0.6% headline into a -66% many-small result. That needs per-path logs, i.e.
# budget mode, which grafana's suite.mts now supports.
#
# One project (default `various`: 105 tests, page-heavy, already pass-parity clean) on
# both arms. Chained after the n8n small-slice run because their work trees do not fit
# on disk together.
#   bash ports/grafana/drive-budget-pair.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
SP=/tmp/claude-0/-home-user-tierless/7647f3ec-cdd4-5925-82f8-2bb4d6d44004/scratchpad
OUT=ports/grafana/results/budget
BRANCH=claude/tierless-port-generality-uwm1f9
PROJ="${TIERLESS_PROJECTS:-various}"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
mkdir -p "$OUT"

# 1. wait on a POSITIVE completion marker, not just pgrep — the earlier guard used
# pgrep alone, did not fire, and deleted a running sweep's inputs.
for i in $(seq 1 240); do
  grep -q "SMALLSLICE_DONE" "$SP/smallslice.log" 2>/dev/null && break
  [ -s ports/n8n/results/smallslice/baseline-measure.jsonl ] && break
  echo "waiting for the n8n run ($i)"; sleep 60
done
grep -q "SMALLSLICE_DONE" "$SP/smallslice.log" 2>/dev/null || [ -s ports/n8n/results/smallslice/baseline-measure.jsonl ] \
  || { echo "n8n run did not finish — not starting grafana"; exit 1; }
while pgrep -f "drive-smallslice|n8n/suite.mts" >/dev/null; do echo "n8n still tearing down"; sleep 30; done
echo "N8N_CLEAR"

# 2. disk: only now, with nothing running against them, are the n8n trees expendable
# (measured arms committed; setup.sh rebuilds them).
if [ ! -d ports/work/grafana/src ]; then
  rm -rf ports/work/n8n ports/work/n8n-baseline
  echo "PRUNED  $(df -h / | tail -1)"
fi

# 3. rebuild grafana, both arms
for arm in ported baseline; do
  flag=""; work=grafana
  [ "$arm" = baseline ] && { flag=--baseline; work=grafana-baseline; }
  if [ -d "ports/work/$work/src/public/build" ] && [ -f "ports/work/$work/src/bin/grafana" ]; then echo "== $arm built"; continue; fi
  echo "== build $arm"
  node ports/run.mts grafana $flag > "$SP/gb2-fetch-$arm.log" 2>&1 || { echo "FETCH_FAIL $arm"; exit 1; }
  ( cd "ports/work/$work/src" \
    && corepack yarn install \
    && make build-go \
    && corepack yarn build \
    && rm -rf .nx/cache /root/.cache/go-build \
    && corepack yarn e2e:plugin:build \
    && corepack yarn workspace @grafana/e2e-selectors build \
    && corepack yarn workspace @grafana/i18n build ) > "$SP/gb2-build-$arm.log" 2>&1 \
    && echo "BUILD_OK $arm" || { echo "BUILD_FAIL $arm"; tail -8 "$SP/gb2-build-$arm.log"; exit 1; }
done

# 4. the budget pair
for arm in ported baseline; do
  flag=""; work=grafana
  [ "$arm" = baseline ] && { flag=--baseline; work=grafana-baseline; }
  [ -s "$OUT/$arm-$PROJ-measure-truth.jsonl" ] && { echo "== skip $arm (done)"; continue; }
  echo "== run $arm/$PROJ"
  TIERLESS_WIRE_TRUTH=1 TIERLESS_WIRE_BUDGET=1 TIERLESS_PROJECTS="$PROJ" \
    timeout 5400 node ports/grafana/suite.mts $flag > "$OUT/$arm-$PROJ.log" 2>&1
  rows=$(wc -l < "ports/work/$work/measure-truth.jsonl" 2>/dev/null || echo 0)
  echo "   $rows rows"
  [ "$rows" -lt 80 ] && { echo "!! $arm incomplete — NOT checkpointed"; continue; }
  cp "ports/work/$work/measure-truth.jsonl" "$OUT/$arm-$PROJ-measure-truth.jsonl"
  cp "ports/work/$work/wire-http.jsonl" "$OUT/$arm-$PROJ-http.jsonl" && gzip -9f "$OUT/$arm-$PROJ-http.jsonl"
  cp "ports/work/$work/wire-session.jsonl" "$OUT/$arm-$PROJ-session.jsonl" 2>/dev/null && gzip -9f "$OUT/$arm-$PROJ-session.jsonl" || true
  grep -oE "[0-9]+ (passed|failed)" "$OUT/$arm-$PROJ.log" | tail -2 | tr '\n' ' '; echo
  git add "$OUT" && git commit -q -m "grafana budget arm: $arm/$PROJ ($rows rows)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011JsGFUBBubsTp15Gf6Fi3j" \
    && git push -q -u origin "$BRANCH" || echo "!! commit/push failed"
done

node ports/report-marginal.mts "$OUT"
echo GRAFANA_BUDGET_DONE
