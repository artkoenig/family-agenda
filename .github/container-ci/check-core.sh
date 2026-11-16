#!/bin/sh
# Asks the running core, over its HTTP API, whether it describes the demo Source from its plugin
# container: signs in as an Admin, then opens the Source Type's page, which names
# the plugin's display name and says "Not reachable" while the core cannot reach the container.
# Usage: check-core.sh <base url>
set -eu
base=$1
page=$(mktemp)
# Admins sign in only through an Identity Provider (ADR-0009), which CI does not run: the check
# stores a session as one would, keyed by the SHA-256 of its token.
token=$(openssl rand -hex 32)
id=$(printf %s "$token" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U family_agenda family_agenda -c \
  "INSERT INTO admin_session (id, subject, email, expires_at) VALUES ('$id', 'ci', 'ci@example.org', now() + interval '1 hour')"
jar="fb_session=$token"
# The Admin area opens only once the Recovery Kit is confirmed as saved.
curl -fsS -b "$jar" -o /dev/null -H "Origin: $base" --data-urlencode "saved=yes" "$base/admin/recovery-kit/confirm"
for _ in $(seq 30); do
  status=$(curl -sS -b "$jar" -o "$page" -w "%{http_code}" "$base/admin/source-types/demo")
  echo "GET /admin/source-types/demo: $status"
  if [ "$status" = 200 ] && grep -q "Demo data" "$page" && ! grep -q "Not reachable" "$page"; then
    echo "The core describes the demo Source from its container."
    exit 0
  fi
  sleep 2
done
echo "The core does not describe the demo Source from its container:"
cat "$page"
exit 1
