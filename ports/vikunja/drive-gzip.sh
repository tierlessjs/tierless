#!/usr/bin/env bash
# Vikunja compressed-stock arm: apply 0008 (env-gated /api/ gzip) to the baseline tree,
# rebuild the Go binary, run the wire-truth arm with VIKUNJA_TIERLESS_GZIP=1. Commits
# the result on completion. Run AFTER any nocodb timing runs — byte counts are
# load-insensitive but floors are not.
#   nohup bash ports/vikunja/drive-gzip.sh > <log> 2>&1 &
set -uo pipefail
cd "$(dirname "$0")/../.."
R=ports/vikunja/results
say() { echo "[vgzip $(date -u +%H:%M:%S)] $*"; }
fail() { say "BLOCKED: $*"; exit 1; }

commit_push() {
  local msg="$1"; shift
  git add "$@" || return 1
  git -c user.email=noreply@anthropic.com -c user.name="Claude" commit -m "$msg

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TV86rbddt84T6DDjTCxwod" || return 0
  for i in 1 2 3; do git push && return 0; sleep $((i * 4)); done
  return 1
}

# baseline tree: test patches only; run.mts applies 0008 incrementally
node ports/run.mts vikunja --baseline || fail "run.mts --baseline failed"
grep -q "VIKUNJA_TIERLESS_GZIP" ports/work/vikunja-baseline/src/pkg/routes/static.go || fail "0008 not in tree"

if [ ! -f ports/work/vikunja-baseline/.gzip-binary-built ]; then
  say "rebuilding baseline backend with 0008"
  ( cd ports/work/vikunja-baseline/src && go build -o vikunja . ) || fail "go build failed"
  touch ports/work/vikunja-baseline/.gzip-binary-built
fi

# sanity: the gate actually flips /api/ to gzip
say "gzip gate"
( cd ports/work/vikunja-baseline/src && VIKUNJA_TIERLESS_GZIP=1 VIKUNJA_SERVICE_TESTINGTOKEN=tok VIKUNJA_DATABASE_PATH=memory VIKUNJA_DATABASE_TYPE=sqlite VIKUNJA_LOG_LEVEL=ERROR VIKUNJA_SERVICE_PUBLICURL=http://127.0.0.1:3456 ./vikunja & echo $! > /tmp/vgzip.pid )
for i in $(seq 1 30); do curl -so /dev/null --max-time 2 http://127.0.0.1:3456/api/v1/info && break; sleep 2; done
ENC=$(curl -s -o /dev/null -D- -H "Accept-Encoding: gzip" http://127.0.0.1:3456/api/v1/info | grep -ci "content-encoding: gzip" || true)
kill "$(cat /tmp/vgzip.pid)" 2>/dev/null || true
sleep 2
[ "$ENC" -ge 1 ] || fail "gate: /api/ still identity-encoded under VIKUNJA_TIERLESS_GZIP=1"
say "gate PASSED (api gzips under the flag)"

if [ ! -f "$R/truth-baseline-gzip.jsonl" ]; then
  say "compressed-stock wire-truth arm (full suite)"
  VIKUNJA_TIERLESS_GZIP=1 TIERLESS_WIRE_TRUTH=1 node ports/vikunja/suite.mts --baseline || true
  n=$(wc -l < ports/work/vikunja-baseline/measure.jsonl || echo 0)
  [ "$n" -ge 190 ] || fail "gzip arm produced only $n rows"
  cp ports/work/vikunja-baseline/measure.jsonl "$R/truth-baseline-gzip.jsonl"
  commit_push "ports/vikunja: compressed-stock wire-truth arm ($n rows)" "$R/truth-baseline-gzip.jsonl" || fail "push failed"
fi

say "— bytes, ported vs COMPRESSED stock:"
node ports/report.mts "$R/truth-baseline-gzip.jsonl" "$R/truth-ported.jsonl" | grep -E "total bytes|median per-test bytes|pass-parity EXCLUDED" | head -4 || true
say "VIKUNJA GZIP DRIVE COMPLETE"
