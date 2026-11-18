#!/bin/sh
# Model-checks every spec below specs/ (ADR-0012): each directory's check.sh.
set -eu
for check in "$(dirname "$0")"/*/check.sh; do
  echo "== ${check}"
  sh "$check"
done
