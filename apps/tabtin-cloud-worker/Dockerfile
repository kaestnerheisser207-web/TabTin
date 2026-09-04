ARG NODE_IMAGE=node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
FROM ${NODE_IMAGE} AS build

WORKDIR /src
RUN corepack enable
COPY . .
RUN --mount=type=cache,id=tabtin-cloud-worker-pnpm,target=/root/.local/share/pnpm/store \
    pnpm --filter @muse/cloud-worker install --frozen-lockfile
RUN pnpm --filter @muse/cloud-worker build

FROM ${NODE_IMAGE}

RUN apk add --no-cache docker-cli
WORKDIR /app
COPY --from=build /src/apps/tabtin-cloud-worker/dist ./dist
COPY --from=build /src/scripts/deploy/tabtin-cloud-volume-helper.sh ./deployment/tabtin-cloud-volume-helper.sh

ENV NODE_ENV=production
EXPOSE 8090
USER node
CMD ["node", "dist/index.js"]
