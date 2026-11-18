#!/bin/sh
# Checks the model of extraction (ADR-0005). Run from the repo root through `pnpm specs [check]`:
# without a check, all of them.
set -eu
cd "$(dirname "$0")"
quint() { pnpm exec quint "$@"; }

scenarios() {
  # A second reading counts; failed messages are skipped and retried; overlapping runs skip or
  # discard what the other read. Without counting failures or checking before a reading, the
  # counterexamples instead.
  for main in fixed unboundedTimeout unboundedInvalid unchecked exhaustive; do
    quint test extraction_test.qnt --backend=typescript --main="$main"
  done
}

simulation() {
  # Random traces of two workers and three messages, one timing out and one answered with invalid
  # output on every reading, with a crash, an outage and a retry: safety, and the liveness bounds,
  # with each action and the states the properties speak of reached.
  quint run extraction_test.qnt --backend=typescript --main=fixed --invariant=safety --max-samples=5000 --max-steps=40 \
    --witnesses firesTake firesCheck firesSkip firesCall firesAnswer firesReadAgain firesRecord firesRecordDiscarded \
    firesRecordFailure firesFail firesEnd firesCrash firesRetry secondReading allSettled readAfterRetry
  quint run extraction_test.qnt --backend=typescript --main=fixed --invariant=messagesSettle --max-samples=2000 --max-steps=120
}

exhaustive() {
  # Every trace of two workers and two messages up to 8 steps (Apalache, needs Java 17+): deep
  # enough for two runs to take the same batch and both read and record a message, about 5 min.
  # Depth 10 takes far longer.
  quint verify extraction_test.qnt --main=exhaustive --invariant=safety --max-steps=8
}

counterexample() {
  # Without counting failures, a message failing every reading holds up the others: simulation
  # must break the liveness bounds (too deep for Apalache). Without checking before a reading, a
  # run reads a message read meanwhile: Apalache must find it.
  for main in unboundedTimeout unboundedInvalid; do
    if quint run extraction_test.qnt --backend=typescript --main="$main" --invariant=messagesSettle \
      --max-samples=2000 --max-steps=120 > /dev/null 2>&1; then
      echo "The $main model no longer violates messagesSettle: the spec lost its counterexample." >&2
      exit 1
    fi
  done
  if quint verify extraction_test.qnt --main=unchecked --invariant=processedNotReadAgain --max-steps=8 > /dev/null 2>&1; then
    echo "The unchecked model no longer violates processedNotReadAgain: the spec lost its counterexample." >&2
    exit 1
  fi
}

case "${1:-all}" in
  scenarios|simulation|exhaustive|counterexample) "$1" ;;
  all) scenarios; simulation; exhaustive; counterexample ;;
  *) echo "Unknown check: $1 (scenarios, simulation, exhaustive, counterexample)" >&2; exit 2 ;;
esac
