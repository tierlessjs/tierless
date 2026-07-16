#!/usr/bin/env bash
# End-to-end driver for the Strapi truth comparison — every remaining step as ONE
# detached, checkpointed run: smoke-gate the session socket, run the ported wire-truth
# arm, build the baseline tree, run its arm, commit+push each completed stage (sandbox
# rollbacks can revert the filesystem at any time; a pushed artifact is the only
# durable one). Idempotent: completed stages are skipped by their artifacts.
#   nohup bash ports/strapi/drive-truth.sh > <log> 2>&1 &
set -uo pipefail
cd "$(dirname "$0")/../.."
R=ports/strapi/results
mkdir -p "$R"
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

sweep_ports() { # a crashed run leaves detached servers owning the fixed ports
  # SCOPED teardown: harness processes only — never bare app-name patterns that could
  # kill a developer's unrelated jobs
  pkill -9 -f "ports/work/strapi" 2>/dev/null
  pkill -9 -f "tierless.mjs gateway" 2>/dev/null   # the CLI gateway (page+100 convention)
  sleep 2
  ss -tlnp 2>/dev/null | grep -E ":8000|:8100|:28000|:28100|:14991|:18000|:18100" \
    | grep -oE "pid=[0-9]+" | cut -d= -f2 | sort -u | xargs -r kill -9
  sleep 2
}

# ---- 1. ported tree built (patches 0002+0003 in the admin dist) -------------------------
if ! grep -q "tierless/browser" ports/work/strapi/src/packages/core/admin/dist/admin/admin/src/utils/tierlessFetch.mjs 2>/dev/null; then
  say "building ported tree (setup.sh)"
  bash ports/strapi/setup.sh || fail "ported setup.sh failed"
fi

# ---- 2. smoke gate: one spec on the session socket, real ws bytes, all passing ----------
if [ ! -f ports/work/strapi/.drive-smoked ]; then
  say "smoke: admin login.spec.ts on the session socket (wire truth — the sealed-auth acid test)"
  sweep_ports
  TIERLESS_WIRE_TRUTH=1 TIERLESS_DOMAINS=admin TIERLESS_SPEC=login.spec.ts node ports/strapi/suite.mts || true
  node -e '
    const fs = require("fs");
    const rows = fs.readFileSync("ports/work/strapi/measure-truth.jsonl", "utf8").trim().split("\n").map(JSON.parse);
    // a test passes if its LAST attempt passed — their own retry posture (the Blocks
    // editor fill flakes on both arms); the gate is about the socket, not UI timing
    const last = new Map(rows.map(r => [r.id, r.status]));
    const passed = [...last.values()].filter(s => s === "passed").length;
    const ws = rows.reduce((a, r) => a + (r.wireWsOut || 0) + (r.wireWsIn || 0), 0);
    console.log(`smoke: ${passed}/${last.size} passed, ws bytes ${ws}`);
    if (passed !== last.size || last.size < 1) process.exit(1);
    if (ws < 2000) { console.log("ws traffic too small — requests are not riding the gateway"); process.exit(1); }
  ' || fail "smoke gate failed — see ports/work/strapi/measure-truth.jsonl and gateway.log"
  touch ports/work/strapi/.drive-smoked
  say "smoke gate PASSED"
fi

# ---- 3. ported truth arm (full CE suite, chromium) --------------------------------------
if [ ! -f "$R/ported-truth.jsonl" ]; then
  say "ported wire-truth arm (full suite)"
  sweep_ports
  TIERLESS_WIRE_TRUTH=1 node ports/strapi/suite.mts || true
  n=$(wc -l < ports/work/strapi/measure-truth.jsonl || echo 0)
  [ "$n" -ge 200 ] || fail "ported truth arm produced only $n rows"
  cp ports/work/strapi/measure-truth.jsonl "$R/ported-truth.jsonl"
fi
commit_push "ports/strapi: ported wire-truth arm ($(wc -l < "$R/ported-truth.jsonl") rows)" "$R/ported-truth.jsonl" || fail "push failed for ported arm"
say "ported arm committed"

# ---- 4. baseline tree built --------------------------------------------------------------
if [ ! -d ports/work/strapi-baseline/src/node_modules ] || [ ! -f ports/work/strapi-baseline/src/packages/core/strapi/dist/src/index.js ]; then
  say "building baseline tree (setup.sh --baseline)"
  bash ports/strapi/setup.sh --baseline || fail "baseline setup.sh failed"
fi

# ---- 5. baseline truth arm ---------------------------------------------------------------
if [ ! -f "$R/baseline-truth.jsonl" ]; then
  say "baseline wire-truth arm (full suite)"
  sweep_ports
  TIERLESS_WIRE_TRUTH=1 node ports/strapi/suite.mts --baseline || true
  n=$(wc -l < ports/work/strapi-baseline/measure-truth.jsonl || echo 0)
  [ "$n" -ge 200 ] || fail "baseline truth arm produced only $n rows"
  cp ports/work/strapi-baseline/measure-truth.jsonl "$R/baseline-truth.jsonl"
fi
commit_push "ports/strapi: baseline wire-truth arm ($(wc -l < "$R/baseline-truth.jsonl") rows)" "$R/baseline-truth.jsonl" || fail "push failed for baseline arm"
say "baseline arm committed"

# ---- 6. the comparison -------------------------------------------------------------------
say "pairing the arms"
node ports/report.mts "$R/baseline-truth.jsonl" "$R/ported-truth.jsonl"
say "DRIVE COMPLETE"
