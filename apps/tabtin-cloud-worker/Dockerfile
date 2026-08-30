ARG NODE_IMAGE=node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
FROM ${NODE_IMAGE}

RUN apk add --no-cache docker-cli
WORKDIR /app
COPY dist ./dist

ENV NODE_ENV=production
EXPOSE 8090
USER node
CMD ["node", "dist/index.js"]
