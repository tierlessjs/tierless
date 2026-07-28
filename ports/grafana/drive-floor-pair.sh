#!/usr/bin/env bash
# Grafana floor pair: the fixed project set (suite.mts default), ported then baseline
# back-to-back (one box state per pair — the n8n advisory-pair lesson), checkpointed
# and committed per arm.
#   bash ports/grafana/drive-floor-pair.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT=ports/grafana/results
mkdir -p "$OUT"
BRANCH=claude/tierless-port-generality-uwm1f9

for arm in ported baseline; do
  flag=""; work=grafana
  [ "$arm" = baseline ] && { flag=--baseline; work=grafana-baseline; }
  out="$OUT/$arm-floor-measure.jsonl"
  [ -s "$out" ] && { echo "== skip $arm (done)"; continue; }
  echo "== run grafana/$arm floor"
  timeout 7200 node ports/grafana/suite.mts $flag > "$OUT/$arm-floor.log" 2>&1
  code=$?
  rows=$(wc -l < "ports/work/$work/measure.jsonl" 2>/dev/null || echo 0)
  echo "   exit $code, $rows rows"
  [ "$rows" -lt 100 ] && { echo "!! $arm incomplete — NOT checkpointed"; continue; }
  cp "ports/work/$work/measure.jsonl" "$out"
  grep -oE "[0-9]+ (passed|failed|skipped)" "$OUT/$arm-floor.log" | tail -3 | tr '\n' ' '; echo
  git add "$out" && git commit -q -m "grafana floor arm: $arm ($rows rows)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011JsGFUBBubsTp15Gf6Fi3j" \
    && git push -q -u origin "$BRANCH" || echo "!! commit/push failed (kept locally)"
done

node -e '
const fs=require("fs");
const L=f=>Object.fromEntries(fs.readFileSync(f,"utf8").trim().split("\n").map(l=>JSON.parse(l)).filter(r=>r.retry===0).map(r=>[r.id,r]));
const b=L("ports/grafana/results/baseline-floor-measure.jsonl");
const p=L("ports/grafana/results/ported-floor-measure.jsonl");
let db=0,dp=0,d=[],mb=0,mp=0;
for(const id of Object.keys(b)){const B=b[id],P=p[id];if(!P)continue;
  if(B.status!==P.status){mb++;continue}
  if(B.status!=="passed")continue;
  db+=B.durationMs;dp+=P.durationMs;d.push(P.durationMs-B.durationMs);}
d.sort((x,y)=>x-y);
console.log("GRAFANA floor pair:",d.length,"pairs; wall",(db/60000).toFixed(1),"->",(dp/60000).toFixed(1),"min ("+(((dp-db)/db)*100).toFixed(1)+"%); median",(d[d.length>>1]>0?"+":"")+d[d.length>>1],"ms; status-mismatched:",mb);
'
echo GRAFANA_FLOOR_DONE
