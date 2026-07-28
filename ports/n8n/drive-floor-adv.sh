#!/usr/bin/env bash
# The n8n FLOOR-WALL arm pair WITH the gateway browse advisory — the #32 closing
# verification. Same shape as drive-floor-head.sh (no relays: asymmetric instrument
# cost reads as a port regression) with one structural change: CHUNK-MAJOR order,
# ported then baseline back-to-back per chunk. The advisory editor pair was first
# split by a container restart across two box states (~17% suite-wide drift) and read
# +20% until both arms were re-run on one box (-0.8%); tight pairing caps that risk
# at a chunk, not a suite.
#
# Checkpointed per chunk to results/floor-adv and committed immediately; idempotent.
#   bash ports/n8n/drive-floor-adv.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT=ports/n8n/results/floor-adv
mkdir -p "$OUT"
BRANCH=claude/tierless-port-generality-uwm1f9

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

for entry in "${CHUNKS[@]}"; do
  name=${entry%%:*}; specs=${entry#*:}
  for arm in ported baseline; do
    flag=""; work=n8n
    [ "$arm" = baseline ] && { flag=--baseline; work=n8n-baseline; }
    out="$OUT/$arm-$name-measure.jsonl"
    [ -s "$out" ] && { echo "== skip $arm/$name (done)"; continue; }
    echo "== run $arm/$name"
    TIERLESS_SPEC="$specs" \
      timeout 5400 node ports/n8n/suite.mts $flag > "$OUT/$arm-$name.log" 2>&1
    rows=$(wc -l < "ports/work/$work/measure.jsonl" 2>/dev/null || echo 0)
    if [ "$rows" -eq 0 ]; then echo "!! $arm/$name produced 0 rows — not checkpointed"; continue; fi
    cp "ports/work/$work/measure.jsonl" "$out"
    grep -oE "[0-9]+ (passed|failed)" "$OUT/$arm-$name.log" | tail -2 | tr '\n' ' '; echo "($rows rows)"
    git add "$out" 2>/dev/null
    git commit -q -m "n8n floor-adv chunk (browse advisory): $arm/$name ($rows rows)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011JsGFUBBubsTp15Gf6Fi3j" \
      && git push -q -u origin "$BRANCH" || echo "!! commit/push failed for $arm/$name (kept locally)"
  done
done

node -e '
const fs=require("fs");
const dir="ports/n8n/results/floor-adv/";
const load=a=>{const m=new Map();for(const f of fs.readdirSync(dir))if(f.startsWith(a+"-")&&f.endsWith("-measure.jsonl"))fs.readFileSync(dir+f,"utf8").trim().split("\n").map(l=>JSON.parse(l)).filter(r=>r.retry===0).forEach(r=>m.set(r.id,r));return m};
const b=load("baseline"),p=load("ported");
let db=0,dp=0,d=[];
for(const [id,B] of b){const P=p.get(id);if(!P||B.status!=="passed"||P.status!=="passed")continue;db+=B.durationMs;dp+=P.durationMs;d.push(P.durationMs-B.durationMs);}
d.sort((x,y)=>x-y);
console.log("FLOOR-ADV full pair:",d.length,"pairs; wall",(db/60000).toFixed(1),"->",(dp/60000).toFixed(1),"min ("+(((dp-db)/db)*100).toFixed(1)+"%); median",(d[d.length>>1]>0?"+":"")+d[d.length>>1],"ms");
console.log("standing HEAD pair without the advisory: +12.4% (674 pairs), served median +1033 ms");
'
echo FLOOR_ADV_DONE
