FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN corepack enable \
    && corepack prepare pnpm@9.15.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/collab-live ./apps/collab-live
COPY contracts ./contracts
COPY packages ./packages

RUN pnpm install --frozen-lockfile --ignore-scripts --filter collab-live... \
    && pnpm --filter collab-live... build \
    && npm_config_ignore_scripts=true pnpm --filter collab-live deploy --prod /opt/collab-live

FROM node:22-bookworm-slim

WORKDIR /app

COPY --from=build --chown=node:node /opt/collab-live ./apps/collab-live

USER node

CMD ["node", "apps/collab-live/dist/start.js"]
