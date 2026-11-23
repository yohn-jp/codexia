# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=docker.io/library/node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
ARG PNPM_VERSION=12.21.0
ARG PROFILE=core

FROM ${NODE_IMAGE} AS pnpm-base
ARG PNPM_VERSION
ENV CI=true
RUN corepack enable \
 && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /opt/codexia

FROM pnpm-base AS source
# Fetch the locked external packages before copying frequently changed source.
# The shared cache mount is usable by both BuildKit and Podman/Buildah.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=codexia-pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm fetch --store-dir=/pnpm/store
COPY . ./
RUN --mount=type=cache,id=codexia-pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --offline --frozen-lockfile --store-dir=/pnpm/store --package-import-method=copy

FROM source AS build
ARG PROFILE
ENV CODEXIA_PROFILE=${PROFILE}
RUN node scripts/build/packaging/profile-package.mjs --profile "${PROFILE}" --out /runtime

FROM ${NODE_IMAGE} AS runtime
ARG PROFILE
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    CODEXIA_BUILD_PROFILE=${PROFILE} \
    CODEXIA_BUILD_MODULE_PROFILE_PATH=/app/generated/server.mjs \
    CODEXIA_BUILD_DATA_DIR=/data \
    CODEXIA_BUILD_USAGE_DIR=/history \
    HOME=/data \
    TMPDIR=/tmp
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git tini \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data /history \
 && chmod 0700 /history \
 && chown node:node /data /history
WORKDIR /app
COPY --chown=node:node --from=build /runtime/ ./
COPY --chown=node:node deploy/backend/start.sh /app/start.sh

USER node
VOLUME ["/data", "/history"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health/ready', {signal: AbortSignal.timeout(3000)}).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/bin/sh", "/app/start.sh"]
