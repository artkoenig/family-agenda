#!/bin/sh
# Checks the model of the core calling a stateless plugin (ADR-0001). Run from the repo root
# through `pnpm specs [check]`: without a check, all of them.
set -eu
cd "$(dirname "$0")"
quint() { pnpm exec quint "$@"; }

scenarios() {
  # A refreshed token stored with its cursor; a late answer discarded; a duplicated call taken
  # once; a temporary error writing only the failure; a lost turn keeping the token; an unreachable
  # plugin showing its Source as Failing. With secrets only in the recording, the counterexample.
  for main in checked secretsLast timely; do
    quint test pluginCall_test.qnt --backend=typescript --main="$main" --max-samples=100
  done
}

simulation() {
  # Random traces of four runs over a network that loses, repeats and delays calls and answers.
  quint run pluginCall_test.qnt --backend=typescript --main=checked --invariant=safety \
    --witnesses recordedRun secretsWithoutCursor lateAnswerIgnored duplicateHandled timedOut shownFailing lostWrite \
    --max-samples=2000 --max-steps=40
  # A clock that waits for the run, for the liveness bound: every call ends at its timeout.
  quint run pluginCall_test.qnt --backend=typescript --main=timely --invariants safety callEndsInTime \
    --witnesses shownFailing --max-samples=1000 --max-steps=80
}

exhaustive() {
  # Every trace of two runs to depth 12 (Apalache, needs Java 17+), about a minute.
  quint verify pluginCall_test.qnt --main=exhaustive --invariant=safety --max-steps=12
}

counterexample() {
  # With secrets stored only with the cursor, a failing recording must drop a refreshed token.
  if quint verify pluginCall_test.qnt --main=exhaustiveSecretsLast --invariant=safety --max-steps=6 > /dev/null 2>&1; then
    echo "exhaustiveSecretsLast no longer violates safety: the spec lost its counterexample." >&2
    exit 1
  fi
}

case "${1:-all}" in
  scenarios|simulation|exhaustive|counterexample) "$1" ;;
  all) scenarios; simulation; exhaustive; counterexample ;;
  *) echo "Unknown check: $1 (scenarios, simulation, exhaustive, counterexample)" >&2; exit 2 ;;
esac
