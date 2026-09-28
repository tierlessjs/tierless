#!/usr/bin/env bash
# Chain migration, timed: the two client-scope specs under injected RTT, three arms.
#
#   bash ports/keycloak/drive-chains.sh            (RTT_MS=80 ROUNDS=3 by default)
#
#   baseline  stock build
#   fetch     ported build, no profile: compiled loaders run, nothing migrates
#   profile   ported build on the locked profile (ports/work/keycloak/profile.json,
#             from a TIERLESS_PROFILE_RUN=1 run + ports/build-profile.mts): chains migrate
#
# fetch vs profile is the same build with one variable — whether chains migrate. Arms are
# interleaved within each round so machine drift lands on all three alike. Rows land in
# ports/keycloak/results/chains/<arm>-r<n>.jsonl; ports/report.mts compares any two.
set -uo pipefail
cd "$(dirname "$0")/../.."
RTT="${RTT_MS:-80}"; ROUNDS="${ROUNDS:-3}"
SPECS="test/client-scope/main.spec.ts test/clients/scope.spec.ts"
OUT=ports/keycloak/results/chains
PROFILE="$PWD/ports/work/keycloak/profile.json"
[ -s "$PROFILE" ] || { echo "!! no locked profile at $PROFILE — run a TIERLESS_PROFILE_RUN=1 pass and ports/build-profile.mts first"; exit 1; }
mkdir -p "$OUT"
for r in $(seq 1 "$ROUNDS"); do
  for arm in baseline fetch profile; do
    flag=""; work=keycloak; extra=()
    [ "$arm" = baseline ] && { flag=--baseline; work=keycloak-baseline; }
    [ "$arm" = profile ] && extra=(TIERLESS_PROFILE="$PROFILE")
    echo "== round $r: $arm (RTT $RTT ms)"
    env "${extra[@]}" TIERLESS_RTT_MS="$RTT" TIERLESS_SPEC="$SPECS" timeout 1800 node ports/keycloak/suite.mts $flag > "$OUT/$arm-r$r.log" 2>&1
    cp "ports/work/$work/measure-rtt$RTT.jsonl" "$OUT/$arm-r$r.jsonl"
    grep -oE "[0-9]+ (passed|failed|flaky)" "$OUT/$arm-r$r.log" | tail -2 | tr '\n' ' '; echo
  done
done
echo "KEYCLOAK_CHAINS_DONE"
