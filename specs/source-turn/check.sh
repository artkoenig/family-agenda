#!/bin/sh
# Checks the model of the Source turn (ADR-0008). Run from the repo root through `pnpm specs [check]`:
# without a check, all of them; CI runs each as its own job.
set -eu
cd "$(dirname "$0")"
quint() { pnpm exec quint "$@"; }

scenarios() {
  # A dead holder's turn is taken; two runs record in turn; a push gets the turn or gives up; the
  # stale run is skipped; due work on two containers polls a Source once; a second run of a Source
  # in one container queues. Without the guards, the fresh due check or the queue, the
  # counterexamples instead.
  for main in checked unguarded unchecked unqueued; do
    quint test sourceTurn_test.qnt --backend=typescript --main="$main"
  done
}

simulation() {
  # Random traces of three containers of two callers and two Sources; then of live containers that
  # keep time, for the liveness bound, long enough for the clock to pass it.
  quint run sourceTurn_test.qnt --backend=typescript --main=checked --invariant=safety --max-samples=5000 --max-steps=40
  quint run sourceTurn_test.qnt --backend=typescript --main=timely --invariant=dueSourceIsPolled --max-samples=500 \
    --max-steps=200 --witnesses clockPastBound
}

exhaustive() {
  # Every trace of two containers and one Source up to 8 steps (Apalache, needs Java 17+): deep
  # enough for the counterexample (a stalled run, a takeover, the late write), and about 1.5 min,
  # as long as CI's other jobs. Depth 10 takes about 7 min, 12 far longer.
  quint verify sourceTurn_test.qnt --main=exhaustive --invariant=turnSafety --max-steps=8
}

counterexample() {
  # Without the guard, or without the in-memory queue, the checker must find a counterexample, or
  # the model no longer shows it. (The fresh due check's counterexample is too deep for Apalache;
  # its scenario shows it.)
  # Without the queue, turnSafety: that a second run takes the turn is not yet the counterexample.
  for check in unguarded:safety unqueued:turnSafety; do
    main=${check%:*} invariant=${check#*:}
    if quint verify sourceTurn_test.qnt --main="$main" --invariant="$invariant" --max-steps=8 > /dev/null 2>&1; then
      echo "The $main model no longer violates $invariant: the spec lost its counterexample." >&2
      exit 1
    fi
  done
}

case "${1:-all}" in
  scenarios|simulation|exhaustive|counterexample) "$1" ;;
  all) scenarios; simulation; exhaustive; counterexample ;;
  *) echo "Unknown check: $1 (scenarios, simulation, exhaustive, counterexample)" >&2; exit 2 ;;
esac
