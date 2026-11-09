FROM node:26-bookworm-slim

ENV NODE_ENV=production
# poppler and Tesseract turn PDF attachments into text. The image ships the German and English
# models and osd; start-up links them into the tessdata volume, where Admins add others (ADR-0012).
RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr tesseract-ocr-deu tesseract-ocr-eng tesseract-ocr-osd \
  && rm -rf /var/lib/apt/lists/*
# Node.js has not shipped Corepack since version 25, so it comes from npm. It reads the pnpm version
# from the packageManager field of package.json.
RUN npm install --global corepack@0.36.0 && corepack enable
WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile --prod \
  && printf '#!/bin/sh\ncd /app/apps/api && exec node --import tsx src/cli.ts "$@"\n' > /usr/local/bin/family-agenda \
  && chmod +x /usr/local/bin/family-agenda \
  && printf '#!/bin/sh\ncd /app/apps/api && exec node --import tsx src/plugins-cli.ts "$@"\n' > /usr/local/bin/plugins \
  && chmod +x /usr/local/bin/plugins \
  && mkdir -p /var/lib/family-agenda/master-key /var/lib/family-agenda/blobs /var/lib/family-agenda/tessdata \
  && chown node:node /var/lib/family-agenda/master-key /var/lib/family-agenda/blobs /var/lib/family-agenda/tessdata \
  && chmod 700 /var/lib/family-agenda/master-key /var/lib/family-agenda/blobs

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
