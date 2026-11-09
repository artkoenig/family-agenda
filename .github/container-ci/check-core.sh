#!/bin/sh
# Asks the running core, over its HTTP API, whether it describes the demo Source from its plugin
# container: creates the first Admin through /setup, then opens the Source Type's page, which names
# the plugin's description and says "Not reachable" while the core cannot reach the container.
# Usage: check-core.sh <base url>
set -eu
base=$1
jar=$(mktemp)
page=$(mktemp)
curl -fsS -c "$jar" -b "$jar" -o /dev/null -H "Origin: $base" \
  --data-urlencode "email=ci@example.org" --data-urlencode "password=container-ci-password" --data-urlencode "language=en" \
  "$base/setup"
for _ in $(seq 30); do
  if curl -fsS -b "$jar" -o "$page" "$base/admin/source-types/demo" && grep -q "Demo data" "$page" && ! grep -q "Not reachable" "$page"; then
    echo "The core describes the demo Source from its container."
    exit 0
  fi
  sleep 2
done
echo "The core does not describe the demo Source from its container:"
cat "$page"
exit 1
