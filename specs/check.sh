#!/bin/sh
# Model-checks every spec below specs/ (ADR-0012): each directory's check.sh.
# With a check (scenarios, simulation, exhaustive, counterexample), runs only that one of each spec;
# CI runs them as parallel jobs.
set -eu
for check in "$(dirname "$0")"/*/check.sh; do
  echo "== ${check} ${1:-}"
  sh "$check" "$@"
done
