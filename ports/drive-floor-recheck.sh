#!/usr/bin/env bash
# Fresh FLOOR (wall-time) arms for vikunja / strapi / nocodb on the current runtime.
# Their byte arms were re-driven this week; wall was not — and the runtime has since
# gained conditional crossings, raw-body passthrough, the storage-advisory cache, and
# the twin bearer. Floor arms carry NO relay and NO budget proxy (those add asymmetric
# instrument cost — the n8n lesson), and the box must be OTHERWISE QUIET: Grafana's
# fetch/build waits until this sweep finishes.
#
# Sequential by design (one suite owns the box at a time), resumable per arm.
#   bash ports/drive-floor-recheck.sh
set -uo pipefail
cd "$(dirname "$0")/.."
OUT=ports/results-recheck
BRANCH=claude/tierless-port-generality-uwm1f9

run() {   # $1 = port, $2 = arm
  local port=$1 arm=$2 flag="" work=$1
  [ "$arm" = baseline ] && { flag=--baseline; work="$1-baseline"; }
  local out="$OUT/$port-$arm-floor.jsonl"
  [ -s "$out" ] && { echo "== skip $port/$arm (done)"; return 0; }
  echo "== run $port/$arm floor"
  node "ports/$port/suite.mts" $flag > "$OUT/$port-$arm-floor.log" 2>&1
  local src="ports/work/$work/measure.jsonl"
  [ -s "$src" ] || { echo "!! $port/$arm produced no artifact"; return 1; }
  cp "$src" "$out"
  node -e '
const fs=require("fs");
const rows=fs.readFileSync("'"$out"'","utf8").trim().split("\n").map(l=>JSON.parse(l));
const last=new Map(); rows.forEach(r=>last.set(r.id,r));
const s={}; [...last.values()].forEach(r=>s[r.status]=(s[r.status]||0)+1);
console.log("  '"$port/$arm"' per-test:",JSON.stringify(s));'
  git add "$out" && git commit -q -m "floor recheck: $port/$arm on the current runtime

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011JsGFUBBubsTp15Gf6Fi3j" \
    && git push -q -u origin "$BRANCH" || echo "!! commit/push failed for $port/$arm"
}

for port in vikunja strapi nocodb; do
  run "$port" baseline
  run "$port" ported
done
echo ALL_FLOORS_DONE
