#!/bin/sh
# Checks the model of removing files and secrets nothing refers to (ADR-0005). Run from the repo
# root through `pnpm specs [check]`: without a check, all of them.
set -eu
cd "$(dirname "$0")"
quint() { pnpm exec quint "$@"; }

scenarios() {
  # An orphan swept once old, a running writer's secret spared, the replaced secret removed, a dead
  # or stalled worker's job expiring; and the two counterexamples, a sweep stalling between reading
  # the references and the clock, and a write keeping a field that another write replaced.
  for main in checked steady unfixedClock unfixedWrite outlasting; do
    quint test sweep_test.qnt --backend=typescript --main="$main"
  done
}

simulation() {
  # Random traces of two writers and two workers that may stall, over five hours.
  quint run sweep_test.qnt --backend=typescript --main=checked --invariants safety sweepRemovesOrphans \
    --witnesses secretRemoved replaced sweepListedSomething sweepingWithoutJob twoSweeping \
    --max-samples=2000 --max-steps=40
  # Workers that do not stall never sweep at once.
  quint run sweep_test.qnt --backend=typescript --main=steady --invariants safety sweepRemovesOrphans oneSweep \
    --witnesses secretRemoved sweepListedSomething \
    --max-samples=2000 --max-steps=40
}

exhaustive() {
  # Every trace (Apalache, needs Java 17+, one run at a time): two writers and one worker to depth 9,
  # deep enough for the writes' counterexample; two workers and one writer to depth 8 for oneSweep.
  quint verify sweep_test.qnt --main=exhaustive --invariant=safety --max-steps=9
  quint verify sweep_test.qnt --main=exhaustiveSteady --invariant=oneSweep --max-steps=8
}

counterexample() {
  # Without each fix, and with a writer outlasting the age, the checker must find safety violated.
  for main in exhaustiveUnfixedClock:12 exhaustiveUnfixedWrite:9 exhaustiveOutlasting:9; do
    if quint verify sweep_test.qnt --main="${main%:*}" --invariant=safety --max-steps="${main#*:}" > /dev/null 2>&1; then
      echo "${main%:*} no longer violates safety: the spec lost its counterexample." >&2
      exit 1
    fi
  done
}

case "${1:-all}" in
  scenarios|simulation|exhaustive|counterexample) "$1" ;;
  all) scenarios; simulation; exhaustive; counterexample ;;
  *) echo "Unknown check: $1 (scenarios, simulation, exhaustive, counterexample)" >&2; exit 2 ;;
esac
