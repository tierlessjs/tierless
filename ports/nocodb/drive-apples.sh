#!/usr/bin/env bash
# Apples-to-apples driver: clean unshaped FLOOR runs for both arms (the network-wait
# decomposition needs dur@RTT0 — wire-truth runs are NOT valid floors, their counting
# relay inflates request-heavy tests), then the COMPRESSED-stock byte arm (patch 0005's
# env-gated gzip). Checkpointed and committed per stage, like drive-truth.sh.
#   nohup bash ports/nocodb/drive-apples.sh > <log> 2>&1 &
set -uo pipefail
cd "$(dirname "$0")/../.."
R=ports/nocodb/results
say() { echo "[apples $(date -u +%H:%M:%S)] $*"; }
fail() { say "BLOCKED: $*"; exit 1; }

commit_push() {
  local msg="$1"; shift
  git add "$@" || return 1
  # only an EMPTY staged diff is benign; a real commit failure (hooks, index, repo)
  # must propagate — otherwise the stage claims durability without ever pushing
  git diff --cached --quiet && return 0
  git -c user.email=noreply@anthropic.com -c user.name="Claude" commit -m "$msg

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TV86rbddt84T6DDjTCxwod" || return 1
  for i in 1 2 3; do git push && return 0; sleep $((i * 4)); done
  return 1
}

sweep_ports() {
  # SCOPED teardown: only processes belonging to this harness — anything whose command
  # line references the work trees or the gateway, owners of the harness's fixed ports,
  # and watcher processes whose CWD is inside the trees (their command lines hide the
  # path). Bare "rspack"/"nodemon" patterns could kill a developer's unrelated jobs.
  pkill -9 -f "ports/work/nocodb" 2>/dev/null
  pkill -9 -f "nocodb/gateway.mts" 2>/dev/null
  sleep 2
  ss -tlnp 2>/dev/null | grep -E ":8080|:9000|:3000|:8180|:13000|:18080|:18180|:28080|:14991" \
    | grep -oE "pid=[0-9]+" | cut -d= -f2 | sort -u | xargs -r kill -9
  for pid in $(pgrep -f "rspack|watch:run|nodemon|output/server/index.mjs" 2>/dev/null); do
    case "$(readlink -f /proc/$pid/cwd 2>/dev/null)" in *ports/work/nocodb*) kill -9 "$pid" 2>/dev/null ;; esac
  done
  sleep 2
}

# ---- 1. both trees present (idempotent; applies any newly-registered patches) -----------
if [ ! -f ports/work/nocodb/.apples-built ]; then
  say "ported tree (setup.sh)"
  bash ports/nocodb/setup.sh || fail "ported setup failed"
  touch ports/work/nocodb/.apples-built
fi
if [ ! -f ports/work/nocodb-baseline/.apples-built ]; then
  say "baseline tree (setup.sh --baseline)"
  bash ports/nocodb/setup.sh --baseline || fail "baseline setup failed"
  touch ports/work/nocodb-baseline/.apples-built
fi

# ---- 2. clean floors, both arms (plain runs — no relays, no shaping) --------------------
if [ ! -f "$R/floor-ported.jsonl" ]; then
  say "floor: ported arm (plain, full suite)"
  sweep_ports
  node ports/nocodb/suite.mts || true
  n=$(wc -l < ports/work/nocodb/measure.jsonl || echo 0)
  [ "$n" -ge 270 ] || fail "ported floor produced only $n rows"
  cp ports/work/nocodb/measure.jsonl "$R/floor-ported.jsonl"
  commit_push "ports/nocodb: ported floor run ($n rows)" "$R/floor-ported.jsonl" || fail "push failed"
fi
if [ ! -f "$R/floor-baseline.jsonl" ]; then
  say "floor: baseline arm (plain, full suite)"
  sweep_ports
  node ports/nocodb/suite.mts --baseline || true
  n=$(wc -l < ports/work/nocodb-baseline/measure.jsonl || echo 0)
  [ "$n" -ge 270 ] || fail "baseline floor produced only $n rows"
  cp ports/work/nocodb-baseline/measure.jsonl "$R/floor-baseline.jsonl"
  commit_push "ports/nocodb: baseline floor run ($n rows)" "$R/floor-baseline.jsonl" || fail "push failed"
fi

# ---- 3. gzip gate: the env-gated layer actually compresses -------------------------------
if [ ! -f ports/work/nocodb-baseline/.apples-gzip-smoked ]; then
  say "gzip gate: one spec + content-encoding assert"
  sweep_ports
  NC_TIERLESS_GZIP=1 TIERLESS_SPEC=tests/db/general/viewMenu.spec.ts node ports/nocodb/suite.mts --baseline > /dev/null 2>&1 &
  SUITE_PID=$!
  until curl -so /dev/null --max-time 2 http://localhost:8080; do sleep 5; done
  T=$(curl -s -X POST http://localhost:8080/api/v1/auth/user/signup -H "content-type: application/json" -d '{"email":"gz2@test.com","password":"Password123."}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).token||""))')
  ENC=$(curl -s -o /dev/null -D- -H "Accept-Encoding: gzip" -H "xc-auth: $T" "http://localhost:8080/api/v2/meta/workspaces/default/bases" | grep -ci "content-encoding: gzip" || true)
  wait $SUITE_PID || true
  node -e '
    const rows = require("fs").readFileSync("ports/work/nocodb-baseline/measure-gzip.jsonl", "utf8").trim().split("\n").map(JSON.parse);
    const passed = rows.filter(r => r.status === "passed").length;
    console.log(`gzip smoke: ${passed}/${rows.length} passed`);
    if (passed !== rows.length || rows.length < 2) process.exit(1);
  ' || fail "gzip smoke spec failed"
  # a small probed body may legitimately skip gzip (under the 1 KB threshold), so this
  # curl alone can't be the gate — the hard assert against the raw arm runs after step 4
  say "gzip gate: content-encoding hits=$ENC on the curl probe"
  touch ports/work/nocodb-baseline/.apples-gzip-smoked
fi

# ---- 4. compressed-stock byte arm ---------------------------------------------------------
if [ ! -f "$R/truth-baseline-gzip.jsonl" ]; then
  say "truth arm: baseline WITH gzip (full suite)"
  sweep_ports
  TIERLESS_WIRE_TRUTH=1 NC_TIERLESS_GZIP=1 node ports/nocodb/suite.mts --baseline || true
  n=$(wc -l < ports/work/nocodb-baseline/measure-truth-gzip.jsonl || echo 0)
  [ "$n" -ge 270 ] || fail "gzip truth arm produced only $n rows"
  cp ports/work/nocodb-baseline/measure-truth-gzip.jsonl "$R/truth-baseline-gzip.jsonl"
  commit_push "ports/nocodb: compressed-stock wire-truth arm ($n rows)" "$R/truth-baseline-gzip.jsonl" || fail "push failed"
fi

# hard gzip gate: the compressed arm must actually be smaller than the raw arm on the
# wire, or the flag was inert and the whole arm is mislabeled. Compares api-in bytes
# summed over tests PASSED IN BOTH runs (the only rows report.mts compares too).
node -e '
  const fs = require("fs");
  const load = (p) => new Map(fs.readFileSync(p, "utf8").trim().split("\n").map(JSON.parse)
    .filter((r) => r.status === "passed" && r.wireApiIn !== undefined).map((r) => [r.id, r]));
  const raw = load("ports/nocodb/results/truth-baseline.jsonl");
  const gz = load("ports/nocodb/results/truth-baseline-gzip.jsonl");
  let a = 0, b = 0, n = 0;
  for (const [t, r] of raw) { const g = gz.get(t); if (!g) continue; a += r.wireApiIn; b += g.wireApiIn; n++; }
  console.log(`gzip gate: api-in over ${n} shared passed tests: raw=${a} gz=${b} (${(100 * (1 - b / a)).toFixed(1)}% smaller)`);
  if (!(n >= 50 && b < a * 0.9)) { console.error("compressed arm is not measurably smaller — NC_TIERLESS_GZIP inert?"); process.exit(1); }
' || fail "gzip arm shows no compression vs the raw baseline arm"

say "reports"
say "— bytes, ported vs COMPRESSED stock:"
node ports/report.mts "$R/truth-baseline-gzip.jsonl" "$R/truth-ported.jsonl" | grep -E "total bytes|median per-test bytes" || true
say "— network-wait decomposition (floors + rtt20):"
node ports/report-time.mts "$R/floor-baseline.jsonl" "$R/floor-ported.jsonl" "$R/rtt20-baseline.jsonl" "$R/rtt20-ported.jsonl" | tail -20 || true
say "APPLES DRIVE COMPLETE"
