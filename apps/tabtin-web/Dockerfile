FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN corepack enable \
    && corepack prepare pnpm@9.15.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY contracts ./contracts
COPY scripts ./scripts
COPY apps/tabtin-web ./apps/tabtin-web
COPY packages ./packages

ENV VITE_API_BASE_URL=https://tabtin.dovelora.com/api \
    VITE_PUBLIC_WEB_BASE_URL=https://tabtin.dovelora.com \
    VITE_COLLAB_WS_BASE=wss://tabtin.dovelora.com/collab \
    VITE_CENTRIFUGO_WS_URL=wss://tabtin.dovelora.com/connection/websocket

RUN pnpm install --frozen-lockfile --ignore-scripts --filter tabtin-web... \
    && pnpm --filter 'tabtin-web^...' build \
    && pnpm --dir apps/tabtin-web exec tsc \
    && pnpm --dir apps/tabtin-web exec vite build

FROM nginx:1.27-alpine

COPY --from=build /app/apps/tabtin-web/dist /usr/share/nginx/html

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=5s --retries=12 \
  CMD wget -qO- http://127.0.0.1:8080/health >/dev/null || exit 1
