#!/usr/bin/env bash
# The whole Keycloak suite, three arms, I/O wait (ports/report-io.mts):
#
#   bash ports/keycloak/drive-full.sh        (RTT_MS=80 TIERLESS_BPS=20000000 ROUNDS=3)
#
#   baseline  stock build
#   fetch     ported build, nothing migrates
#   profile   ported build on a locked profile learned from a full-suite profiling run
#
# Resumable: every step is skipped once its output exists, so after a container restart
# the same command continues. Each run is split into SHARDS Playwright shards, so a restart
# costs one shard, not a whole run. Rows land in ports/keycloak/results/full-<label>/.
set -uo pipefail
cd "$(dirname "$0")/../.."
RTT="${RTT_MS:-80}"; BPS="${TIERLESS_BPS:-20000000}"; ROUNDS="${ROUNDS:-3}"; SHARDS="${SHARDS:-4}"
LABEL="$([ "$BPS" != 0 ] && echo "$((BPS / 1000000))mbit" || echo "rtt$RTT")"
OUT=ports/keycloak/results/full-$LABEL
PROFILE="$PWD/ports/work/keycloak/profile-full.json"
mkdir -p ports/work
for arm in "" --baseline; do
  dir=ports/work/keycloak$([ -n "$arm" ] && echo -baseline)
  [ -e "$dir.setup-done" ] && continue                 # written only after setup.sh succeeds
  echo "## setup ${arm:-ported} ($(date -u +%H:%M))"
  bash ports/keycloak/setup.sh $arm > "$dir.setup.log" 2>&1 || { echo "!! setup failed: $dir.setup.log"; exit 1; }
  touch "$dir.setup-done"
done
if [ ! -s "$PROFILE" ]; then
  echo "## profiling run ($(date -u +%H:%M))"
  TIERLESS_PROFILE_RUN=1 timeout 7200 node ports/keycloak/suite.mts > ports/work/keycloak/profile-full.log 2>&1
  node ports/build-profile.mts ports/work/keycloak/trace.jsonl ports/work/keycloak/src/js/apps/admin-ui/dist-tierless/ "$PROFILE" | head -2
fi
mkdir -p "$OUT"
for r in $(seq 1 "$ROUNDS"); do for arm in baseline fetch profile; do
  [ -s "$OUT/$arm-r$r.jsonl" ] && continue
  flag=""; work=keycloak; extra=()
  [ "$BPS" != 0 ] && extra+=(TIERLESS_BPS="$BPS")
  [ "$arm" = baseline ] && { flag=--baseline; work=keycloak-baseline; }
  [ "$arm" = profile ] && extra+=(TIERLESS_PROFILE="$PROFILE")
  for k in $(seq 1 "$SHARDS"); do
    part="$OUT/$arm-r$r-s$k"
    [ -s "$part.jsonl" ] && continue
    echo "== round $r: $arm shard $k/$SHARDS ($(date -u +%H:%M))"
    env "${extra[@]}" TIERLESS_RTT_MS="$RTT" TIERLESS_SPEC="--shard=$k/$SHARDS" timeout 5400 node ports/keycloak/suite.mts $flag > "$part.log" 2>&1
    cp "ports/work/$work/io.txt" "$part.io"
    cp "ports/work/$work/measure-rtt$RTT$([ "$BPS" != 0 ] && echo "-bps$BPS").jsonl" "$part.jsonl"
    grep -oE "[0-9]+ (passed|failed|flaky|did not run|skipped)" "$part.log" | tail -4 | tr '\n' ' '; echo
  done
  for x in io log jsonl; do cat "$OUT/$arm-r$r"-s*."$x" > "$OUT/$arm-r$r.$x"; done
  rm -f "$OUT/$arm-r$r"-s*
  echo "== round $r: $arm done ($(wc -l < "$OUT/$arm-r$r.jsonl") rows)"
done; done
echo "FULL_DONE ($(date -u +%H:%M))"
