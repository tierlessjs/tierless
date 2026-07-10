#!/usr/bin/env bash
# Apples round 2: (a) the SYMMETRIC compressed arm — ported WITH the same env-gated gzip
# (its residual direct-HTTP traffic compresses like stock's; the ws session is already
# deflated), (b) an RTT-80 pair for the network-wait decomposition — at RTT 20 the pool
# is ~5% of this suite's wall time and drowns in run variance; 80 ms (the Vikunja
# instrument) makes it measurable. Checkpointed + committed per stage.
#   nohup bash ports/nocodb/drive-apples2.sh > <log> 2>&1 &
set -uo pipefail
cd "$(dirname "$0")/../.."
R=ports/nocodb/results
say() { echo "[apples2 $(date -u +%H:%M:%S)] $*"; }
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

# ---- 0. the built UI must speak the CURRENT wire (SMW2): the browser runtime is baked
# into nc-gui's build, and a magic bump in the linked package makes every session
# crossing fail against a stale build ------------------------------------------------------
if ! grep -qr '"SMW2"' ports/work/nocodb/src/packages/nc-gui/.output/public/_nuxt 2>/dev/null; then
  say "rebuilding ported UI (stale wire magic in the built bundle)"
  ( cd ports/work/nocodb/src/packages/nc-gui && NODE_OPTIONS=--max_old_space_size=8192 HUSKY=0 corepack pnpm run build ) || fail "gui rebuild failed"
  grep -qr '"SMW2"' ports/work/nocodb/src/packages/nc-gui/.output/public/_nuxt || fail "rebuilt UI still lacks SMW2"
fi

# ---- 1. symmetric compressed arm: ported WITH gzip ---------------------------------------
if [ ! -f "$R/truth-ported-gzip.jsonl" ]; then
  say "truth arm: ported WITH gzip (full suite)"
  sweep_ports
  TIERLESS_WIRE_TRUTH=1 NC_TIERLESS_GZIP=1 node ports/nocodb/suite.mts || true
  n=$(wc -l < ports/work/nocodb/measure-truth-gzip.jsonl || echo 0)
  [ "$n" -ge 270 ] || fail "ported gzip truth arm produced only $n rows"
  cp ports/work/nocodb/measure-truth-gzip.jsonl "$R/truth-ported-gzip.jsonl"
  commit_push "ports/nocodb: symmetric compressed arm — ported with gzip ($n rows)" "$R/truth-ported-gzip.jsonl" || fail "push failed"
fi

# ---- 2. RTT-80 pair ------------------------------------------------------------------------
if [ ! -f "$R/rtt80-ported.jsonl" ]; then
  say "ported arm at RTT 80 (full suite)"
  sweep_ports
  TIERLESS_RTT_MS=80 node ports/nocodb/suite.mts || true
  n=$(wc -l < ports/work/nocodb/measure-rtt80.jsonl || echo 0)
  [ "$n" -ge 270 ] || fail "ported rtt80 arm produced only $n rows"
  cp ports/work/nocodb/measure-rtt80.jsonl "$R/rtt80-ported.jsonl"
  commit_push "ports/nocodb: ported RTT80 arm ($n rows)" "$R/rtt80-ported.jsonl" || fail "push failed"
fi
if [ ! -f "$R/rtt80-baseline.jsonl" ]; then
  say "baseline arm at RTT 80 (full suite)"
  sweep_ports
  TIERLESS_RTT_MS=80 node ports/nocodb/suite.mts --baseline || true
  n=$(wc -l < ports/work/nocodb-baseline/measure-rtt80.jsonl || echo 0)
  [ "$n" -ge 270 ] || fail "baseline rtt80 arm produced only $n rows"
  cp ports/work/nocodb-baseline/measure-rtt80.jsonl "$R/rtt80-baseline.jsonl"
  commit_push "ports/nocodb: baseline RTT80 arm ($n rows)" "$R/rtt80-baseline.jsonl" || fail "push failed"
fi

say "reports"
say "— bytes, ported+gzip vs stock+gzip (both arms compressed):"
node ports/report.mts "$R/truth-baseline-gzip.jsonl" "$R/truth-ported-gzip.jsonl" | grep -E "total bytes|median per-test bytes" || true
say "— network wait at RTT 80 (floors + rtt80):"
node ports/report-time.mts "$R/floor-baseline.jsonl" "$R/floor-ported.jsonl" "$R/rtt80-baseline.jsonl" "$R/rtt80-ported.jsonl" | head -12 || true
say "APPLES2 DRIVE COMPLETE"
