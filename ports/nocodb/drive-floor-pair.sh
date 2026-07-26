#!/usr/bin/env bash
# nocodb floor pair with the two safeguards the sweep driver lacked, added after its
# BASELINE arm wedged at test 17/282 for 2.4 h (stock arm — no tierless in the page;
# no live browser worker; RAM and disk healthy; an app/harness stall):
#   - a hard per-arm timeout, so a wedge costs 95 minutes, not a night;
#   - a completeness gate (>=280 of 282 rows), so a killed run can never be
#     checkpointed as an arm.
# One retry per arm: a wedge this shape was not seen in either truth arm this week,
# so a second occurrence is signal, not noise — the driver stops and says so.
#   bash ports/nocodb/drive-floor-pair.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT=ports/results-recheck
BRANCH=claude/tierless-port-generality-uwm1f9

run_arm() {   # $1 = arm
  local arm=$1 flag="" work=nocodb
  [ "$arm" = baseline ] && { flag=--baseline; work=nocodb-baseline; }
  local out="$OUT/nocodb-$arm-floor.jsonl"
  [ -s "$out" ] && { echo "== skip nocodb/$arm (done)"; return 0; }
  for attempt in 1 2; do
    echo "== run nocodb/$arm floor (attempt $attempt)"
    timeout 5700 node ports/nocodb/suite.mts $flag > "$OUT/nocodb-$arm-floor.log" 2>&1
    local code=$?
    local src="ports/work/$work/measure.jsonl"
    local rows=$(wc -l < "$src" 2>/dev/null || echo 0)
    echo "   exit $code, $rows rows"
    if [ "$rows" -ge 280 ]; then
      cp "$src" "$out"
      node -e 'const fs=require("fs");const rows=fs.readFileSync("'"$out"'","utf8").trim().split("\n").map(l=>JSON.parse(l));const last=new Map();rows.forEach(r=>last.set(r.id,r));const s={};[...last.values()].forEach(r=>s[r.status]=(s[r.status]||0)+1);console.log("  nocodb/'"$arm"' per-test:",JSON.stringify(s));'
      git add "$out" && git commit -q -m "floor recheck: nocodb/$arm on the current runtime

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011JsGFUBBubsTp15Gf6Fi3j" \
        && git push -q -u origin "$BRANCH" || echo "!! commit/push failed"
      return 0
    fi
    echo "!! nocodb/$arm attempt $attempt incomplete ($rows rows) — NOT checkpointed"
  done
  echo "!! nocodb/$arm wedged twice — stopping; this is signal"
  return 1
}

run_arm baseline && run_arm ported
echo NOCODB_FLOORS_DONE
