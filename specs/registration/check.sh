#!/bin/sh
# Checks the model of preparing the Family id (ADR-0003) and registration (ADR-0010). Run from the
# repo root through `pnpm specs [check]`: without a check, all of them.
set -eu
cd "$(dirname "$0")"
quint() { pnpm exec quint "$@"; }

scenarios() {
  # Two cores preparing at once, a crash mid-migration, the first registration, a redelivery, two
  # registrations at once, a late one; and the counterexamples of the code as it is.
  for main in fixed drawn unfixedId supplied; do
    quint test registration_test.qnt --backend=typescript --main="$main" --max-samples=100
  done
}

simulation() {
  # Random traces of two cores and two users with two handlers, in both modes. Only preparing holds
  # as the code is: registration's properties fail (see the counterexamples).
  for main in fixed drawn supplied; do
    quint run registration_test.qnt --backend=typescript --main="$main" --invariants oneFamilyId noStrayRandomId coreCanStart \
      --witnesses coreUp allUp crashedWhilePreparing familyWithAdmin registrationClosed lostTheRace redelivered throwsWitness crashed \
      --max-samples=2000 --max-steps=30
  done
}

exhaustive() {
  # Every trace of preparing with two cores up to 12 steps (Apalache, needs Java 17+).
  quint verify registration_test.qnt --main=fixed --invariants oneFamilyId noStrayRandomId coreCanStart --max-steps=12
}

counterexample() {
  # Writing the given id after the migrations committed, the checker must find a random id left behind.
  if quint verify registration_test.qnt --main=unfixedId --invariant=noStrayRandomId --max-steps=6 > /dev/null 2>&1; then
    echo "The unfixed model no longer leaves a random id: the spec lost its counterexample." >&2
    exit 1
  fi
}

case "${1:-all}" in
  scenarios|simulation|exhaustive|counterexample) "$1" ;;
  all) scenarios; simulation; exhaustive; counterexample ;;
  *) echo "Unknown check: $1 (scenarios, simulation, exhaustive, counterexample)" >&2; exit 2 ;;
esac
