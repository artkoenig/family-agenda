#!/bin/sh
# Checks the model of a rolling update and the migrations described for it (ADR-0003, "Migrations
# expand, then contract"). Run from the repo root through `pnpm specs [check]`: without a check, all.
set -eu
cd "$(dirname "$0")"
quint() { pnpm exec quint "$@"; }

# The described migrations that must hold, and those that must violate safety.
GOOD="idToken familyId colour"
BROKEN="familyIdBroken colourBroken"

scenarios() {
  # The rename finishing release by release, the deploy and the opening refused, and each broken
  # migration's violation.
  for main in $GOOD $BROKEN; do
    quint test rollingUpdate_test.qnt --backend=typescript --main="$main"
  done
}

simulation() {
  # Random traces of three cores through every release of each migration, long enough to finish.
  for main in $GOOD; do
    witnesses="updateFinished overlapOnNewSchema staleCoreRefuses"
    [ "$main" = idToken ] || witnesses="$witnesses contracted"
    quint run rollingUpdate_test.qnt --backend=typescript --main="$main" --invariants safety canFinish \
      --witnesses $witnesses --max-samples=3000 --max-steps=40
  done
  for main in $BROKEN; do
    if quint run rollingUpdate_test.qnt --backend=typescript --main="$main" --invariant=safety \
      --max-samples=3000 --max-steps=40 > /dev/null 2>&1; then
      echo "$main no longer violates safety: the spec lost its counterexample." >&2
      exit 1
    fi
  done
}

exhaustive() {
  # Every trace of the five-release rename with two cores (one old, one new make every overlap) up
  # to 10 steps (Apalache, needs Java 17+), in about 2.5 min: deep enough for an old core's write after
  # a copy, a contract, and both counterexamples (6 steps).
  quint verify rollingUpdate_test.qnt --main=colourExhaustive --invariants safety canFinish --max-steps=10
}

counterexample() {
  # The checker must find the contract before the old cores are gone, and the write lost to the copy.
  for main in familyIdBrokenExhaustive colourBrokenExhaustive; do
    if quint verify rollingUpdate_test.qnt --main="$main" --invariant=safety --max-steps=6 > /dev/null 2>&1; then
      echo "$main no longer violates safety: the spec lost its counterexample." >&2
      exit 1
    fi
  done
}

case "${1:-all}" in
  scenarios|simulation|exhaustive|counterexample) "$1" ;;
  all) scenarios; simulation; exhaustive; counterexample ;;
  *) echo "Unknown check: $1 (scenarios, simulation, exhaustive, counterexample)" >&2; exit 2 ;;
esac
