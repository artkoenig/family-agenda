FROM node:24-bookworm-slim

ENV NODE_ENV=production
RUN corepack enable
WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile --prod \
  && printf '#!/bin/sh\ncd /app/apps/api && exec node --import tsx src/cli.ts "$@"\n' > /usr/local/bin/family-butler \
  && chmod +x /usr/local/bin/family-butler \
  && mkdir -p /var/lib/family-butler/master-key \
  && chown node:node /var/lib/family-butler/master-key \
  && chmod 700 /var/lib/family-butler/master-key

USER node
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["node", "--import", "tsx", "src/main.ts"]
