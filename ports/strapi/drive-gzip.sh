#!/usr/bin/env bash
# Apples-to-apples arms (after drive-truth.sh): both wire-truth arms with Strapi's own
# stock compression middleware enabled (test patch 0005, STRAPI_TIERLESS_GZIP=1) — the
# "what if they deployed compression" comparison. Idempotent, committed per stage.
#   nohup bash ports/strapi/drive-gzip.sh > <log> 2>&1 &
set -uo pipefail
cd "$(dirname "$0")/../.."
R=ports/strapi/results
say() { echo "[gzip $(date -u +%H:%M:%S)] $*"; }
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
  pkill -9 -f "tierless.mjs gateway" 2>/dev/null   # the CLI gateway (page+100 convention)
  sleep 2
  ss -tlnp 2>/dev/null | grep -E ":8000|:8100|:28000|:28100|:14991|:18000|:18100" \
    | grep -oE "pid=[0-9]+" | cut -d= -f2 | sort -u | xargs -r kill -9
  sleep 2
}

run_arm() { # run_arm <results-name> <measure-name> <baselineFlag>
  local out="$1" measure="$2" flag="$3"
  if [ ! -f "$R/$out" ]; then
    say "arm $out (full suite)"
    sweep_ports
    STRAPI_TIERLESS_GZIP=1 TIERLESS_WIRE_TRUTH=1 node ports/strapi/suite.mts $flag || true
    local n; n=$(wc -l < "$measure" 2>/dev/null || echo 0)
    [ "$n" -ge 200 ] || fail "$out produced only $n rows"
    cp "$measure" "$R/$out"
  fi
  commit_push "ports/strapi: $out ($(wc -l < "$R/$out") rows)" "$R/$out" || fail "push failed for $out"
  say "$out committed"
}

run_arm baseline-truth-gzip.jsonl ports/work/strapi-baseline/measure-truth-gzip.jsonl --baseline
run_arm ported-truth-gzip.jsonl   ports/work/strapi/measure-truth-gzip.jsonl          ""

say "gzip-stock vs ported (the SYMMETRIC pair)"
node ports/report.mts "$R/baseline-truth-gzip.jsonl" "$R/ported-truth-gzip.jsonl" | head -20
say "GZIP DRIVE COMPLETE"
