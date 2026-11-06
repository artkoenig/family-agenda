# The WhatsApp bridge, built on the Debian release the image runs on, with Go's own olm, so it needs
# no libolm. The worker runs it while an Admin has WhatsApp enabled (ADR-0011).
FROM golang:1.27-bookworm AS whatsapp-bridge
RUN CGO_ENABLED=1 go install -tags goolm -ldflags "-s -w" go.mau.fi/mautrix-whatsapp/cmd/mautrix-whatsapp@v0.2609.0

FROM node:26-bookworm-slim

ENV NODE_ENV=production
# poppler and Tesseract turn PDF attachments into text. The image ships the German and English
# models and osd; start-up links them into the tessdata volume, where Admins add others (ADR-0012).
# Python runs Synapse, the homeserver of the Messengers' bridges, in a virtual environment of its own.
RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr tesseract-ocr-deu tesseract-ocr-eng tesseract-ocr-osd python3 python3-venv \
  && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/synapse \
  && /opt/synapse/bin/pip install --no-cache-dir matrix-synapse==1.163.2 psycopg2-binary==2.9.13
COPY --from=whatsapp-bridge /go/bin/mautrix-whatsapp /usr/local/bin/mautrix-whatsapp
RUN corepack enable
WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile --prod \
  && printf '#!/bin/sh\ncd /app/apps/api && exec node --import tsx src/cli.ts "$@"\n' > /usr/local/bin/family-agenda \
  && chmod +x /usr/local/bin/family-agenda \
  && mkdir -p /var/lib/family-agenda/master-key /var/lib/family-agenda/blobs /var/lib/family-agenda/plugins /var/lib/family-agenda/tessdata /var/lib/family-agenda/matrix /var/lib/family-agenda/matrix-data \
  && chown node:node /var/lib/family-agenda/master-key /var/lib/family-agenda/blobs /var/lib/family-agenda/plugins /var/lib/family-agenda/tessdata /var/lib/family-agenda/matrix /var/lib/family-agenda/matrix-data \
  && chmod 700 /var/lib/family-agenda/master-key /var/lib/family-agenda/blobs /var/lib/family-agenda/matrix-data

# The release this image is built from, such as 0.3.1 or main-1a2b3c4; `dev` when built from a working tree.
# It comes last, so that a new version does not invalidate the layers above. The app names it in
# /api/health and in the Admin area.
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
LABEL org.opencontainers.image.version=$APP_VERSION

USER node
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["node", "--import", "tsx", "src/main.ts"]
