#!/bin/sh
# Checks the model of inviting an Admin (ADR-0010, ADR-0011). Run from the repo root through
# `pnpm specs [check]`: without a check, all of them.
set -eu
cd "$(dirname "$0")"
quint() { pnpm exec quint "$@"; }

SAFETY="acceptedOnlyValid noAcceptanceAfterRevocation tokenGrantsNothing membersAreAdmins invitationFollowable"

scenarios() {
  # Following the link, in two tabs, revoked or expired midway, re-invited, invited twice at once,
  # two Admins removing each other; and the counterexamples of the rejected designs.
  for main in design founder unchecked jit; do
    quint test invitation_test.qnt --backend=typescript --main="$main" --max-samples=100
  done
}

simulation() {
  # Random traces of two invitees, three tabs, four invitations and expiry.
  # As the code is, and with #469, where the Family also always keeps an Admin.
  quint run invitation_test.qnt --backend=typescript --main=design --invariants $SAFETY \
    --witnesses accepted invitedTwice revokedOne refusedByIdp twoTabs strayAccount removedOne expiredUnused \
    --max-samples=2000 --max-steps=30
  quint run invitation_test.qnt --backend=typescript --main=founder --invariants $SAFETY someAdmin \
    --witnesses accepted revokedOne twoTabs strayAccount removedOne \
    --max-samples=2000 --max-steps=30
}

exhaustive() {
  # Every trace of one invitee and two tabs up to 8 steps (Apalache, needs Java 17+): invitations
  # of different emails never meet but in the count of Admins.
  quint verify invitation_test.qnt --main=small --invariants $SAFETY --max-steps=8
}

counterexample() {
  # An Identity Provider that accepts without checking the invitation accepts a revoked one; JIT
  # membership through the token leaves a member without the role `admin`; and two Admins removing
  # each other leave none, as the code does and fixed mode will after #469.
  fails() {
    if quint run invitation_test.qnt --backend=typescript --main="$1" --invariant="$2" --max-samples=5000 --max-steps=20 > /dev/null 2>&1; then
      echo "$1 no longer violates $2: the spec lost its counterexample." >&2
      exit 1
    fi
  }
  fails unchecked noAcceptanceAfterRevocation
  fails jit membersAreAdmins
  fails design someAdmin
}

case "${1:-all}" in
  scenarios|simulation|exhaustive|counterexample) "$1" ;;
  all) scenarios; simulation; exhaustive; counterexample ;;
  *) echo "Unknown check: $1 (scenarios, simulation, exhaustive, counterexample)" >&2; exit 2 ;;
esac
