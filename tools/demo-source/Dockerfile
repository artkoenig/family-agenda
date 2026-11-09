# The demo Source as a plugin container (ADR-0001). Built from the repository root:
#   docker build -f tools/demo-source/Dockerfile -t family-agenda-demo-source .
FROM node:26-bookworm-slim

ENV NODE_ENV=production
# Node.js has not shipped Corepack since version 25, so it comes from npm.
RUN npm install --global corepack@0.36.0 && corepack enable
WORKDIR /app

COPY . .
# Not --prod: the kit takes the plugin contract as a peer, which only its dev dependency installs here.
RUN pnpm install --frozen-lockfile --filter "@family-agenda/demo-source..."

USER node
WORKDIR /app/tools/demo-source
ENV PORT=8080
EXPOSE 8080
CMD ["node", "--import", "tsx", "src/main.ts"]
