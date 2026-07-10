#!/usr/bin/env bash
# End-to-end driver for the NocoDB truth comparison — every remaining step as ONE
# detached, checkpointed run: smoke-gate the session socket, build the baseline arm,
# run both wire-truth arms, commit+push each completed stage (sandbox rollbacks can
# revert the filesystem at any time; a pushed artifact is the only durable one).
# Idempotent: completed stages are skipped by their artifacts; wiped trees rebuild.
#   nohup bash ports/nocodb/drive-truth.sh > <log> 2>&1 &
set -uo pipefail
cd "$(dirname "$0")/../.."
R=ports/nocodb/results
say() { echo "[drive $(date -u +%H:%M:%S)] $*"; }
fail() { say "BLOCKED: $*"; exit 1; }

commit_push() { # commit_push <message> <paths...>
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

sweep_ports() { # a crashed run leaves detached watchers respawning servers
  # SCOPED teardown: harness processes only (cmdline referencing the trees/gateway, the
  # fixed ports' owners, watchers whose CWD is in the trees) — bare "rspack"/"nodemon"
  # patterns could kill a developer's unrelated jobs
  pkill -9 -f "ports/work/nocodb" 2>/dev/null
  pkill -9 -f "nocodb/gateway.mts" 2>/dev/null
  sleep 2
  ss -tlnp 2>/dev/null | grep -E ":8080|:9000|:3000|:8180|:28080|:14991" \
    | grep -oE "pid=[0-9]+" | cut -d= -f2 | sort -u | xargs -r kill -9
  for pid in $(pgrep -f "rspack|watch:run|nodemon|output/server/index.mjs" 2>/dev/null); do
    case "$(readlink -f /proc/$pid/cwd 2>/dev/null)" in *ports/work/nocodb*) kill -9 "$pid" 2>/dev/null ;; esac
  done
  sleep 2
}

# ---- 1. ported tree built (patches 0002+0003, gui bundle carries the fixed runtime) ----
if [ ! -f ports/work/nocodb/.drive-built ]; then
  say "building ported tree (setup.sh)"
  bash ports/nocodb/setup.sh || fail "ported setup.sh failed"
  touch ports/work/nocodb/.drive-built
fi

# ---- 2. smoke gate: one spec on the session socket, real ws bytes, all passing ---------
if [ ! -f ports/work/nocodb/.drive-smoked ]; then
  say "smoke: viewMenu on the session socket (wire truth)"
  sweep_ports
  TIERLESS_WIRE_TRUTH=1 TIERLESS_SPEC=tests/db/general/viewMenu.spec.ts node ports/nocodb/suite.mts || true
  node -e '
    const fs = require("fs");
    const rows = fs.readFileSync("ports/work/nocodb/measure-truth.jsonl", "utf8").trim().split("\n").map(JSON.parse);
    const passed = rows.filter(r => r.status === "passed").length;
    const ws = rows.reduce((a, r) => a + (r.wireWsOut || 0) + (r.wireWsIn || 0), 0);
    console.log(`smoke: ${passed}/${rows.length} passed, ws bytes ${ws}`);
    if (passed !== rows.length || rows.length < 2) process.exit(1);
    if (ws < 2000) { console.log("ws traffic too small — requests are not riding the gateway"); process.exit(1); }
  ' || fail "smoke gate failed — see ports/work/nocodb/measure-truth.jsonl and *.log"
  touch ports/work/nocodb/.drive-smoked
  say "smoke gate PASSED"
fi

# ---- 3. ported truth arm (full suite, ~1.1h) --------------------------------------------
if [ ! -f "$R/truth-ported.jsonl" ]; then
  say "ported wire-truth arm (full suite)"
  sweep_ports
  TIERLESS_WIRE_TRUTH=1 node ports/nocodb/suite.mts || true
  n=$(wc -l < ports/work/nocodb/measure-truth.jsonl || echo 0)
  [ "$n" -ge 270 ] || fail "ported truth arm produced only $n rows"
  cp ports/work/nocodb/measure-truth.jsonl "$R/truth-ported.jsonl"
fi
commit_push "ports/nocodb: ported wire-truth arm ($n rows)" "$R/truth-ported.jsonl" || fail "push failed for ported arm"
say "ported arm committed"

# ---- 4. baseline tree built -------------------------------------------------------------
if [ ! -f ports/work/nocodb-baseline/.drive-built ]; then
  say "building baseline tree (setup.sh --baseline)"
  bash ports/nocodb/setup.sh --baseline || fail "baseline setup.sh failed"
  touch ports/work/nocodb-baseline/.drive-built
fi

# ---- 5. baseline truth arm --------------------------------------------------------------
if [ ! -f "$R/truth-baseline.jsonl" ]; then
  say "baseline wire-truth arm (full suite)"
  sweep_ports
  TIERLESS_WIRE_TRUTH=1 node ports/nocodb/suite.mts --baseline || true
  n=$(wc -l < ports/work/nocodb-baseline/measure-truth.jsonl || echo 0)
  [ "$n" -ge 270 ] || fail "baseline truth arm produced only $n rows"
  cp ports/work/nocodb-baseline/measure-truth.jsonl "$R/truth-baseline.jsonl"
fi
commit_push "ports/nocodb: baseline wire-truth arm ($n rows)" "$R/truth-baseline.jsonl" || fail "push failed for baseline arm"
say "baseline arm committed"

# ---- 6. the comparison ------------------------------------------------------------------
say "pairing the arms"
node ports/report.mts "$R/truth-baseline.jsonl" "$R/truth-ported.jsonl"
say "DRIVE COMPLETE"
