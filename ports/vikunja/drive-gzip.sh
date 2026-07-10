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
  # refuse a dirty index: git commit takes the WHOLE index, so unrelated staged work
  # would leak into an unattended benchmark commit — fail loudly instead
  git diff --cached --quiet || { echo "commit_push: index has unrelated staged work — refusing"; return 1; }
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
# $! in the subshell captured a wrapper, not the binary (it survived the kill once and the
# suite's stale-port guard refused to boot) — kill by socket owner and WAIT for the port
kill "$(cat /tmp/vgzip.pid)" 2>/dev/null || true
ss -tlnp 2>/dev/null | grep ":3456" | grep -oE "pid=[0-9]+" | cut -d= -f2 | sort -u | xargs -r kill -9
for i in $(seq 1 15); do curl -so /dev/null --max-time 1 http://127.0.0.1:3456/api/v1/info || break; sleep 1; done
curl -so /dev/null --max-time 1 http://127.0.0.1:3456/api/v1/info && fail "gate server still owns :3456 after kill"
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

# hard gzip gate on the ARM itself: compressed must be measurably smaller than the raw
# arm on api-in bytes over tests passed in both runs, or the flag was inert.
node -e '
  const fs = require("fs");
  const load = (p) => new Map(fs.readFileSync(p, "utf8").trim().split("\n").map(JSON.parse)
    .filter((r) => r.status === "passed" && r.wireApiIn !== undefined).map((r) => [r.id, r]));
  const raw = load("ports/vikunja/results/truth-baseline.jsonl");
  const gz = load("ports/vikunja/results/truth-baseline-gzip.jsonl");
  let a = 0, b = 0, n = 0;
  for (const [t, r] of raw) { const g = gz.get(t); if (!g) continue; a += r.wireApiIn; b += g.wireApiIn; n++; }
  console.log(`gzip gate: api-in over ${n} shared passed tests: raw=${a} gz=${b} (${(100 * (1 - b / a)).toFixed(1)}% smaller)`);
  if (!(n >= 50 && b < a * 0.9)) { console.error("compressed arm is not measurably smaller — VIKUNJA_TIERLESS_GZIP inert?"); process.exit(1); }
' || fail "gzip arm shows no compression vs the raw baseline arm"

say "— bytes, ported vs COMPRESSED stock:"
node ports/report.mts "$R/truth-baseline-gzip.jsonl" "$R/truth-ported.jsonl" | grep -E "total bytes|median per-test bytes|pass-parity EXCLUDED" | head -4 || true
say "VIKUNJA GZIP DRIVE COMPLETE"
