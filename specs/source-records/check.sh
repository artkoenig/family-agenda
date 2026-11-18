#!/bin/sh
# Checks the model of Source Records, withdrawal and retention (ADR-0005). Run from the repo root
# through `pnpm specs [check]`: without a check, all of them.
set -eu
cd "$(dirname "$0")"
quint() { pnpm exec quint "$@"; }

scenarios() {
  # Delivered again, withdrawn and back, withdrawn while read, an entry withdrawn and stated again,
  # purged once unneeded or past the period, an old message ignored; and the purge during a run's
  # call, which the run judging retention by the clock before its call turns into a message read twice.
  for main in checked unfixed; do
    quint test sourceRecords_test.qnt --backend=typescript --main="$main"
  done
}

simulation() {
  # Random traces of two messages and one entry, long enough for messages to pass their retention.
  quint run sourceRecords_test.qnt --backend=typescript --main=checked --invariants safety pastRetentionIsPurgeable \
    --witnesses readWithItem tombstone rowDeleted withdrawnMessage messageBack entryWithdrawn itemDeleted \
    --max-samples=3000 --max-steps=40
}

exhaustive() {
  # Every trace of one message and one entry up to 10 steps (Apalache, needs Java 17+): deep enough
  # for the counterexample (9 steps), in about 1.5 min. Depth 12 takes about 4 min.
  quint verify sourceRecords_test.qnt --main=exhaustive --invariant=safety --max-steps=10
}

counterexample() {
  # Judging retention by the clock before the call, the checker must find the message read twice.
  if quint verify sourceRecords_test.qnt --main=exhaustiveUnfixed --invariant=safety --max-steps=9 > /dev/null 2>&1; then
    echo "The unfixed model no longer violates safety: the spec lost its counterexample." >&2
    exit 1
  fi
}

case "${1:-all}" in
  scenarios|simulation|exhaustive|counterexample) "$1" ;;
  all) scenarios; simulation; exhaustive; counterexample ;;
  *) echo "Unknown check: $1 (scenarios, simulation, exhaustive, counterexample)" >&2; exit 2 ;;
esac
