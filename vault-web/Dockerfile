# The Dark Vault web app. Build from the repository root, because the app
# uses the vault-core library next to it:
#
#   docker build -f vault-web/Dockerfile .
#
# (docker compose does this for you.)

FROM node:22-bookworm-slim AS build
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY vault-core/package.json vault-core/package-lock.json vault-core/
RUN cd vault-core && npm ci
COPY vault-web/package.json vault-web/package-lock.json vault-web/
RUN cd vault-web && npm ci
COPY vault-core vault-core
COPY vault-web vault-web
RUN cd vault-web && npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
# Auction records, the site's receipt key, encrypted lots and evidence photos
# live in /data: mount a volume there and back it up.
ENV VAULT_DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
COPY --from=build --chown=node:node /app /app
USER node
WORKDIR /app/vault-web
VOLUME /data
EXPOSE 3100
# Listens on every interface inside the container; docker-compose.yml decides
# what, if anything, is published outside it.
CMD ["node", "node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", "3100"]
