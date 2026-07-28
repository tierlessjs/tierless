#!/usr/bin/env bash
# Grafana floor arms, RESTART-RESILIENT: one suite run per PROJECT per arm (5-25 min
# units), ported then baseline back-to-back per project (one box state per pair),
# checkpoint-committed immediately. This container idle-freezes and restarts under
# long background runs — a monolithic 1.5 h arm lost twice is what this replaces.
# Idempotent: relaunch on every wake-up; finished chunks are skipped by file existence.
#   bash ports/grafana/drive-floor-chunks.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT=ports/grafana/results/truth
mkdir -p "$OUT"
BRANCH=claude/tierless-port-generality-uwm1f9

# the fixed workload rule (suite.mts): all non-external-datasource projects.
# dashboard-cujs carries its setup/teardown as Playwright dependencies.
PROJECTS="admin viewer extensions-test-app grafana-e2etest-datasource canvas unauthenticated various panels smoke dashboards alerting dashboard-new-layouts dashboard-cujs grafana-e2etest-panel"

for proj in $PROJECTS; do
  for arm in ported baseline; do
    flag=""; work=grafana
    [ "$arm" = baseline ] && { flag=--baseline; work=grafana-baseline; }
    out="$OUT/$arm-$proj-measure-truth.jsonl"
    [ -s "$out" ] && { echo "== skip $arm/$proj (done)"; continue; }
    echo "== run $arm/$proj"
    TIERLESS_PROJECTS="$proj" TIERLESS_WIRE_TRUTH=1 timeout 3000 node ports/grafana/suite.mts $flag > "$OUT/$arm-$proj.log" 2>&1
    code=$?
    src="ports/work/$work/measure-truth.jsonl"
    rows=$(wc -l < "$src" 2>/dev/null || echo 0)
    echo "   exit $code, $rows rows"
    # a killed run must never checkpoint; 0-test projects (all deps-only) also skip
    if [ "$code" -ne 0 ] && [ "$code" -ne 1 ]; then echo "!! $arm/$proj killed/wedged — NOT checkpointed"; continue; fi
    [ "$rows" -eq 0 ] && { echo "!! $arm/$proj produced 0 rows — NOT checkpointed"; continue; }
    cp "$src" "$out"
    grep -oE "[0-9]+ (passed|failed|skipped)" "$OUT/$arm-$proj.log" | tail -3 | tr '\n' ' '; echo
    git add "$out" && git commit -q -m "grafana truth chunk: $arm/$proj ($rows rows)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011JsGFUBBubsTp15Gf6Fi3j" \
      && git push -q -u origin "$BRANCH" || echo "!! commit/push failed (kept locally)"
  done
done

node -e '
const fs=require("fs");
const dir="ports/grafana/results/truth/";
const load=a=>{const m=new Map();for(const f of fs.readdirSync(dir))if(f.startsWith(a+"-")&&f.endsWith("-measure-truth.jsonl"))fs.readFileSync(dir+f,"utf8").trim().split("\n").map(l=>JSON.parse(l)).filter(r=>r.retry===0).forEach(r=>m.set(r.id,r));return m};
const b=load("baseline"),p=load("ported");
// BYTES are the point of the truth arms: TCP-true totals from the counting relay
// (wireApi*) plus the gateway session socket (wireWs*, ported only). Conservation
// holds under the chained reporter; wireError rows and status-mismatched pairs drop.
let bb=0,pb=0,n=0,mm=0,err=0,perTest=[];
for(const [id,B] of b){const P=p.get(id);if(!P)continue;
  if(B.status!==P.status){mm++;continue}
  if(B.status!=="passed")continue;
  if(B.wireError||P.wireError){err++;continue}
  const sum=r=>(r.wireApiIn||0)+(r.wireApiOut||0)+(r.wireWsIn||0)+(r.wireWsOut||0);
  const sb=sum(B),sp=sum(P);
  if(sb===0&&sp>1e6||sp===0&&sb>1e6){err++;continue}   // one-sided zero-byte exclusion (ports/report.mts rule)
  bb+=sb;pb+=sp;n++;if(sb>0)perTest.push(sp/sb);}
perTest.sort((a,b)=>a-b);
console.log("GRAFANA truth bytes:",n,"pairs;",(bb/1e6).toFixed(0),"MB ->",(pb/1e6).toFixed(0),"MB ("+((100*(pb-bb)/bb)).toFixed(1)+"%); median per-test ratio",perTest.length?perTest[perTest.length>>1].toFixed(3):"n/a","; mismatched:",mm,"wireErr/one-sided:",err);
console.log("prediction (docs/corpus.md, made before measuring): 5-10% suite byte WIN");
'
echo GRAFANA_TRUTH_CHUNKS_DONE
