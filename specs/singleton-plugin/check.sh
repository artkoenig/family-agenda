#!/bin/sh
# Checks the model of the singleton plugin's one replica (ADR-0001, ADR-0002). Run from the repo
# root through `pnpm specs [check]`: without a check, all of them.
set -eu
cd "$(dirname "$0")"
quint() { pnpm exec quint "$@"; }

scenarios() {
  # A redeploy, one with a process killed after its grace, a crash restarting the same container;
  # with a start-first update, the counterexample.
  for main in checked startFirst; do
    quint test singletonPlugin_test.qnt --backend=typescript --main="$main"
  done
}

simulation() {
  # Random traces of two redeploys, crashes and restarts.
  quint run singletonPlugin_test.qnt --backend=typescript --main=checked --invariant=safety \
    --witnesses redeployed killed restarted stoppingHolds --max-samples=3000 --max-steps=30
}

exhaustive() {
  # Every trace of one redeploy to depth 10 (Apalache, needs Java 17+), under a minute.
  quint verify singletonPlugin_test.qnt --main=exhaustive --invariant=safety --max-steps=10
}

counterexample() {
  # With a start-first update, the checker must find two holders.
  if quint verify singletonPlugin_test.qnt --main=exhaustiveStartFirst --invariant=safety --max-steps=6 > /dev/null 2>&1; then
    echo "exhaustiveStartFirst no longer violates safety: the spec lost its counterexample." >&2
    exit 1
  fi
}

case "${1:-all}" in
  scenarios|simulation|exhaustive|counterexample) "$1" ;;
  all) scenarios; simulation; exhaustive; counterexample ;;
  *) echo "Unknown check: $1 (scenarios, simulation, exhaustive, counterexample)" >&2; exit 2 ;;
esac
