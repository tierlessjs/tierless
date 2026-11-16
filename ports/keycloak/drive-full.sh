#!/usr/bin/env bash
# The whole Keycloak suite, three arms, I/O wait (ports/report-io.mts):
#
#   bash ports/keycloak/drive-full.sh        (RTT_MS=80 TIERLESS_BPS=20000000 ROUNDS=3)
#
#   baseline  stock build
#   fetch     ported build, nothing migrates
#   profile   ported build on a locked profile learned from a full-suite profiling run
#
# Each run is split into SHARDS Playwright shards, and a shard's three arms run back to
# back, so the arms of every test are measured minutes apart on one machine.
# Resumable: every step is skipped once its output exists, so after a container restart
# the same command continues; a restart costs one shard-run, or one shard's triple if it
# fell between its arms. Rows land in ports/keycloak/results/full-<label>/
# (OUT=<dir> to put a measurement beside an earlier one: results/full-20mbit-v2 is the
# second pass, after module code by name).
set -uo pipefail
cd "$(dirname "$0")/../.."
RTT="${RTT_MS:-80}"; BPS="${TIERLESS_BPS:-20000000}"; ROUNDS="${ROUNDS:-3}"; SHARDS="${SHARDS:-4}"
LABEL="$([ "$BPS" != 0 ] && echo "$((BPS / 1000000))mbit" || echo "rtt$RTT")"
OUT="${OUT:-ports/keycloak/results/full-$LABEL}"
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
BOOT="$(cat /proc/sys/kernel/random/boot_id)"   # one per container
ARMS=(baseline fetch profile)
for r in $(seq 1 "$ROUNDS"); do
  [ -s "$OUT/profile-r$r.jsonl" ] && continue
  for k in $(seq 1 "$SHARDS"); do
    # A shard's three arms run back to back in one container (machines differ by about 1%
    # of I/O wait, as much as the arms do). A triple a restart split is run again whole.
    n=0; same=1
    for arm in "${ARMS[@]}"; do [ -s "$OUT/$arm-r$r-s$k.jsonl" ] && { n=$((n + 1)); [ "$(cat "$OUT/$arm-r$r-s$k.boot" 2>/dev/null)" = "$BOOT" ] || same=0; }; done
    if [ "$n" -gt 0 ] && [ "$n" -lt 3 ] && [ "$same" = 0 ]; then echo "## round $r shard $k: the container changed mid-triple, running it again"; rm -f "$OUT"/*-r"$r"-s"$k".*; fi
    for i in 0 1 2; do
      arm="${ARMS[$(( (r + k + i) % 3 ))]}"                # the order rotates, so no arm always runs first
      part="$OUT/$arm-r$r-s$k"
      [ -s "$part.jsonl" ] && continue
      # DEADLINE=<epoch s>: start no run after it, so a capped session stops between runs
      if [ -n "${DEADLINE:-}" ] && [ "$(date +%s)" -ge "$DEADLINE" ]; then echo "## deadline reached before round $r shard $k $arm ($(date -u +%H:%M))"; exit 3; fi
      flag=""; work=keycloak; extra=()
      [ "$BPS" != 0 ] && extra+=(TIERLESS_BPS="$BPS")
      [ "$arm" = baseline ] && { flag=--baseline; work=keycloak-baseline; }
      [ "$arm" = profile ] && extra+=(TIERLESS_PROFILE="$PROFILE")
      echo "== round $r shard $k/$SHARDS: $arm ($(date -u +%H:%M))"
      env "${extra[@]}" TIERLESS_RTT_MS="$RTT" TIERLESS_SPEC="--shard=$k/$SHARDS" timeout 5400 node ports/keycloak/suite.mts $flag > "$part.log" 2>&1
      cp "ports/work/$work/io.txt" "$part.io"
      echo "$BOOT" > "$part.boot"
      cp "ports/work/$work/measure-rtt$RTT$([ "$BPS" != 0 ] && echo "-bps$BPS").jsonl" "$part.jsonl"
      grep -oE "[0-9]+ (passed|failed|flaky|did not run|skipped)" "$part.log" | tail -4 | tr '\n' ' '; echo
    done
  done
  for k in $(seq 1 "$SHARDS"); do echo "$r $k $(cat "$OUT/baseline-r$r-s$k.boot")" >> "$OUT/containers.txt"; done   # round, shard, container
  for arm in "${ARMS[@]}"; do
    for x in io log jsonl; do cat "$OUT/$arm-r$r"-s*."$x" > "$OUT/$arm-r$r.$x"; done
    rm -f "$OUT/$arm-r$r"-s*
  done
  echo "== round $r done ($(wc -l < "$OUT/profile-r$r.jsonl") rows per arm)"
done
echo "FULL_DONE ($(date -u +%H:%M))"
