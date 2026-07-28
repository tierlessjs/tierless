#!/usr/bin/env bash
# Grafana floor arms, RESTART-RESILIENT: one suite run per PROJECT per arm (5-25 min
# units), ported then baseline back-to-back per project (one box state per pair),
# checkpoint-committed immediately. This container idle-freezes and restarts under
# long background runs — a monolithic 1.5 h arm lost twice is what this replaces.
# Idempotent: relaunch on every wake-up; finished chunks are skipped by file existence.
#   bash ports/grafana/drive-floor-chunks.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT=ports/grafana/results/floor
mkdir -p "$OUT"
BRANCH=claude/tierless-port-generality-uwm1f9

# the fixed workload rule (suite.mts): all non-external-datasource projects.
# dashboard-cujs carries its setup/teardown as Playwright dependencies.
PROJECTS="admin viewer extensions-test-app grafana-e2etest-datasource canvas unauthenticated various panels smoke dashboards alerting dashboard-new-layouts dashboard-cujs grafana-e2etest-panel"

for proj in $PROJECTS; do
  for arm in ported baseline; do
    flag=""; work=grafana
    [ "$arm" = baseline ] && { flag=--baseline; work=grafana-baseline; }
    out="$OUT/$arm-$proj-measure.jsonl"
    [ -s "$out" ] && { echo "== skip $arm/$proj (done)"; continue; }
    echo "== run $arm/$proj"
    TIERLESS_PROJECTS="$proj" timeout 3000 node ports/grafana/suite.mts $flag > "$OUT/$arm-$proj.log" 2>&1
    code=$?
    src="ports/work/$work/measure.jsonl"
    rows=$(wc -l < "$src" 2>/dev/null || echo 0)
    echo "   exit $code, $rows rows"
    # a killed run must never checkpoint; 0-test projects (all deps-only) also skip
    if [ "$code" -ne 0 ] && [ "$code" -ne 1 ]; then echo "!! $arm/$proj killed/wedged — NOT checkpointed"; continue; fi
    [ "$rows" -eq 0 ] && { echo "!! $arm/$proj produced 0 rows — NOT checkpointed"; continue; }
    cp "$src" "$out"
    grep -oE "[0-9]+ (passed|failed|skipped)" "$OUT/$arm-$proj.log" | tail -3 | tr '\n' ' '; echo
    git add "$out" && git commit -q -m "grafana floor chunk: $arm/$proj ($rows rows)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011JsGFUBBubsTp15Gf6Fi3j" \
      && git push -q -u origin "$BRANCH" || echo "!! commit/push failed (kept locally)"
  done
done

node -e '
const fs=require("fs");
const dir="ports/grafana/results/floor/";
const load=a=>{const m=new Map();for(const f of fs.readdirSync(dir))if(f.startsWith(a+"-")&&f.endsWith("-measure.jsonl"))fs.readFileSync(dir+f,"utf8").trim().split("\n").map(l=>JSON.parse(l)).filter(r=>r.retry===0).forEach(r=>m.set(r.id,r));return m};
const b=load("baseline"),p=load("ported");
let db=0,dp=0,d=[],mm=0;
for(const [id,B] of b){const P=p.get(id);if(!P)continue;
  if(B.status!==P.status){mm++;continue}
  if(B.status!=="passed")continue;
  db+=B.durationMs;dp+=P.durationMs;d.push(P.durationMs-B.durationMs);}
d.sort((x,y)=>x-y);
console.log("GRAFANA floor (chunks so far):",d.length,"pairs; wall",(db/60000).toFixed(1),"->",(dp/60000).toFixed(1),"min ("+(((dp-db)/db)*100).toFixed(1)+"%); median",(d[d.length>>1]>0?"+":"")+d[d.length>>1],"ms; status-mismatched:",mm);
'
echo GRAFANA_FLOOR_CHUNKS_DONE
