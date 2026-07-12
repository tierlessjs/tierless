#!/usr/bin/env bash
# Shaped-timing driver (after drive-truth.sh): unshaped FLOOR runs + RTT 20 ms arms,
# each stage committed+pushed on completion (rollback insurance). Idempotent, same
# posture as drive-truth.sh. The settled timing metric is NETWORK WAIT =
# dur@RTT − dur@floor per test (ports/report-time.mts); wire-truth runs are NOT valid
# floors — the counting proxy inflates request-heavy tests, so floors are plain runs.
#   nohup bash ports/strapi/drive-rtt.sh > <log> 2>&1 &
set -uo pipefail
cd "$(dirname "$0")/../.."
R=ports/strapi/results
mkdir -p "$R"
say() { echo "[rtt $(date -u +%H:%M:%S)] $*"; }
fail() { say "BLOCKED: $*"; exit 1; }

commit_push() {
  local msg="$1"; shift
  git diff --cached --quiet || { echo "commit_push: index has unrelated staged work — refusing"; return 1; }
  git add "$@" || return 1
  if git diff --cached --quiet; then
    for i in 1 2 3; do git push && return 0; sleep $((i * 4)); done
    return 1
  fi
  git -c user.email=noreply@anthropic.com -c user.name="Claude" commit -m "$msg

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01H6SQ44JrQLjWRVuE1V1Feg" || return 1
  for i in 1 2 3; do git push && return 0; sleep $((i * 4)); done
  return 1
}

sweep_ports() {
  pkill -9 -f "ports/work/strapi" 2>/dev/null
  pkill -9 -f "strapi/gateway.mts" 2>/dev/null
  sleep 2
  ss -tlnp 2>/dev/null | grep -E ":8000|:8180|:28000|:14991|:18000|:18180" \
    | grep -oE "pid=[0-9]+" | cut -d= -f2 | sort -u | xargs -r kill -9
  sleep 2
}

run_arm() { # run_arm <results-name> <measure-name> <baselineFlag> <env...>
  local out="$1" measure="$2" flag="$3"; shift 3
  if [ ! -f "$R/$out" ]; then
    say "arm $out (full suite)"
    sweep_ports
    env "$@" node ports/strapi/suite.mts $flag || true
    local n; n=$(wc -l < "$measure" 2>/dev/null || echo 0)
    [ "$n" -ge 200 ] || fail "$out produced only $n rows"
    cp "$measure" "$R/$out"
  fi
  commit_push "ports/strapi: $out ($(wc -l < "$R/$out") rows)" "$R/$out" || fail "push failed for $out"
  say "$out committed"
}

# floors first (plain, unshaped — the per-test unimprovable baseline), then RTT 20
run_arm floor-ported.jsonl   ports/work/strapi/measure.jsonl          ""
run_arm floor-baseline.jsonl ports/work/strapi-baseline/measure.jsonl --baseline
run_arm rtt20-ported.jsonl   ports/work/strapi/measure-rtt20.jsonl   ""          TIERLESS_RTT_MS=20
run_arm rtt20-baseline.jsonl ports/work/strapi-baseline/measure-rtt20.jsonl --baseline TIERLESS_RTT_MS=20

say "pairing the arms (wall clock at RTT 20)"
node ports/report.mts "$R/rtt20-baseline.jsonl" "$R/rtt20-ported.jsonl" | tail -12
say "network-wait decomposition"
node ports/report-time.mts "$R/floor-baseline.jsonl" "$R/floor-ported.jsonl" "$R/rtt20-baseline.jsonl" "$R/rtt20-ported.jsonl" | tail -20
say "RTT DRIVE COMPLETE"
