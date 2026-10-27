FROM node:24-bookworm-slim

ENV NODE_ENV=production
# poppler and Tesseract with its German model turn PDF attachments into text.
RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr tesseract-ocr-deu \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile --prod \
  && printf '#!/bin/sh\ncd /app/apps/api && exec node --import tsx src/cli.ts "$@"\n' > /usr/local/bin/family-butler \
  && chmod +x /usr/local/bin/family-butler \
  && mkdir -p /var/lib/family-butler/master-key /var/lib/family-butler/blobs /var/lib/family-butler/plugins \
  && chown node:node /var/lib/family-butler/master-key /var/lib/family-butler/blobs /var/lib/family-butler/plugins \
  && chmod 700 /var/lib/family-butler/master-key /var/lib/family-butler/blobs

USER node
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["node", "--import", "tsx", "src/main.ts"]
