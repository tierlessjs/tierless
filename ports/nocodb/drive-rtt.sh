#!/usr/bin/env bash
# Shaped-timing driver: rebuild the ported UI (runtime-config ws url), smoke one spec
# at RTT 20, then both full arms at RTT 20 ms — each stage committed+pushed on
# completion (rollback insurance). Idempotent, same posture as drive-truth.sh.
#   nohup bash ports/nocodb/drive-rtt.sh > <log> 2>&1 &
set -uo pipefail
cd "$(dirname "$0")/../.."
R=ports/nocodb/results
say() { echo "[rtt $(date -u +%H:%M:%S)] $*"; }
fail() { say "BLOCKED: $*"; exit 1; }

commit_push() {
  local msg="$1"; shift
  # refuse a dirty index: git commit takes the WHOLE index, so unrelated staged work
  # would leak into an unattended benchmark commit — fail loudly instead
  git diff --cached --quiet || { echo "commit_push: index has unrelated staged work — refusing"; return 1; }
  git add "$@" || return 1
  # an EMPTY staged diff means the artifact is already committed — but maybe not
  # PUSHED (a failed push on the previous run): push before declaring the stage done.
  # A real commit failure (hooks, index, repo) still propagates below.
  if git diff --cached --quiet; then
    for i in 1 2 3; do git push && return 0; sleep $((i * 4)); done
    return 1
  fi
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

# ---- 1. ported UI carries the runtime-config gateway URL --------------------------------
if [ ! -f ports/work/nocodb/.rtt-gui-built ]; then
  say "rebuilding ported UI (runtime-config ws url)"
  ( cd ports/work/nocodb/src/packages/nc-gui && NODE_OPTIONS=--max_old_space_size=8192 HUSKY=0 corepack pnpm run build ) || fail "gui rebuild failed"
  touch ports/work/nocodb/.rtt-gui-built
fi

# ---- 2. shaped smoke: one spec at RTT 20 on the ported arm ------------------------------
if [ ! -f ports/work/nocodb/.rtt-smoked ]; then
  say "smoke: viewMenu at RTT 20"
  sweep_ports
  TIERLESS_RTT_MS=20 TIERLESS_SPEC=tests/db/general/viewMenu.spec.ts node ports/nocodb/suite.mts || true
  node -e '
    const rows = require("fs").readFileSync("ports/work/nocodb/measure-rtt20.jsonl", "utf8").trim().split("\n").map(JSON.parse);
    const passed = rows.filter(r => r.status === "passed").length;
    console.log(`smoke: ${passed}/${rows.length} passed`);
    if (passed !== rows.length || rows.length < 2) process.exit(1);
  ' || fail "shaped smoke failed — see ports/work/nocodb/measure-rtt20.jsonl and *.log"
  touch ports/work/nocodb/.rtt-smoked
  say "shaped smoke PASSED"
fi

# ---- 3. ported arm at RTT 20 -------------------------------------------------------------
if [ ! -f "$R/rtt20-ported.jsonl" ]; then
  say "ported arm at RTT 20 (full suite)"
  sweep_ports
  TIERLESS_RTT_MS=20 node ports/nocodb/suite.mts || true
  n=$(wc -l < ports/work/nocodb/measure-rtt20.jsonl || echo 0)
  [ "$n" -ge 270 ] || fail "ported rtt arm produced only $n rows"
  cp ports/work/nocodb/measure-rtt20.jsonl "$R/rtt20-ported.jsonl"
fi
commit_push "ports/nocodb: ported RTT20 arm ($n rows)" "$R/rtt20-ported.jsonl" || fail "push failed"
say "ported rtt arm committed"

# ---- 4. baseline arm at RTT 20 -----------------------------------------------------------
if [ ! -f "$R/rtt20-baseline.jsonl" ]; then
  say "baseline arm at RTT 20 (full suite)"
  sweep_ports
  TIERLESS_RTT_MS=20 node ports/nocodb/suite.mts --baseline || true
  n=$(wc -l < ports/work/nocodb-baseline/measure-rtt20.jsonl || echo 0)
  [ "$n" -ge 270 ] || fail "baseline rtt arm produced only $n rows"
  cp ports/work/nocodb-baseline/measure-rtt20.jsonl "$R/rtt20-baseline.jsonl"
fi
commit_push "ports/nocodb: baseline RTT20 arm ($n rows)" "$R/rtt20-baseline.jsonl" || fail "push failed"
say "baseline rtt arm committed"

say "pairing the arms"
node ports/report.mts "$R/rtt20-baseline.jsonl" "$R/rtt20-ported.jsonl" | tail -12
say "RTT DRIVE COMPLETE"
