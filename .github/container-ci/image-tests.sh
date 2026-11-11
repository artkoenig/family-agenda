#!/usr/bin/env bash
# Runs the tests of the command-line tools the image ships (`pnpm test:image`, the *.image.test.ts
# files) inside the given image, as the user the app runs as. The image holds the repository but
# only its production dependencies, so the tests run in a copy that gets the others installed.
#
#   .github/container-ci/image-tests.sh family-agenda:local
set -euo pipefail

image="${1:?Usage: image-tests.sh <image>}"

# REQUIRE_OCR fails a test whose tool is missing, instead of skipping it.
docker run --rm \
  --env NODE_ENV=development \
  --env REQUIRE_OCR=true \
  --env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  --env CI=true \
  --workdir /tmp \
  --entrypoint sh \
  "$image" -euc 'cp -a /app /tmp/app && cd /tmp/app && pnpm install --frozen-lockfile && pnpm test:image'
