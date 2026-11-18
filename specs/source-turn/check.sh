#!/bin/sh
# Checks the model of the Source turn (ADR-0008). Run from the repo root through `pnpm specs`.
set -eu
cd "$(dirname "$0")"
quint() { pnpm exec quint "$@"; }

# The scenarios: a dead holder's turn is taken; two runs record in turn; a push gets the turn or gives up; the stale run is skipped, and replaced secrets without the guard.
quint test sourceTurn.qnt --backend=typescript --main=checked
quint test sourceTurn.qnt --backend=typescript --main=unguarded

# Random traces of three containers and two Sources.
quint run sourceTurn.qnt --backend=typescript --main=checked --invariant=safety --max-samples=5000 --max-steps=40

# Every trace of two containers and one Source up to 12 steps (Apalache, needs Java 17+).
quint verify sourceTurn.qnt --main=exhaustive --invariant=turnSafety --max-steps=12

# Without the guard the checker must find the counterexample, or the model no longer shows it.
if quint verify sourceTurn.qnt --main=unguarded --invariant=safety --max-steps=8 > /dev/null 2>&1; then
  echo "The unguarded model no longer violates safety: the spec lost its counterexample." >&2
  exit 1
fi
