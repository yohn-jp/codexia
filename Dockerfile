# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=docker.io/library/node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
ARG GO_IMAGE=docker.io/library/golang:1.25.5-bookworm@sha256:d9132cce84391efab786495288756d60e1da215b1f94e87860aeefc3d4c45b6d
ARG PNPM_VERSION=12.10.1
ARG POSTGRES_IMAGE=docker.io/library/postgres:17-bookworm@sha256:665dc7b37ac52a17e298511414c21d23ffa4e6a6ef6225b3e5d59c7afb35e994
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
RUN node scripts/profile-package.mjs --profile "${PROFILE}" --out /runtime

FROM ${GO_IMAGE} AS frontend-build
WORKDIR /src
COPY buildkit/frontend/go.mod buildkit/frontend/go.sum ./
COPY buildkit/frontend/main.go ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -buildvcs=false -ldflags='-s -w' -o /codexia-buildkit-frontend .

# PostgreSQL is copied only into a disposable startup-smoke overlay, never a runtime image.
FROM ${POSTGRES_IMAGE} AS smoke-postgres
RUN set -eu; \
    mkdir -p /opt/codexia-smoke-postgres/root; \
    cp --parents -a /usr/lib/postgresql/17 /usr/share/postgresql/17 /opt/codexia-smoke-postgres/root; \
    ldd /usr/lib/postgresql/17/bin/postgres > /tmp/codexia-postgres-smoke-deps; \
    ldd /usr/lib/postgresql/17/bin/initdb >> /tmp/codexia-postgres-smoke-deps; \
    ldd /usr/lib/postgresql/17/bin/pg_ctl >> /tmp/codexia-postgres-smoke-deps; \
    if grep -q 'not found' /tmp/codexia-postgres-smoke-deps; then echo 'A PostgreSQL smoke dependency is missing' >&2; exit 1; fi; \
    awk '/=> \// { print $3 } /^[[:space:]]*\// { print $1 }' /tmp/codexia-postgres-smoke-deps | sort -u \
      | xargs -r cp --parents -L -t /opt/codexia-smoke-postgres/root; \
    rm /tmp/codexia-postgres-smoke-deps

FROM source AS buildkit
ARG SCRIPTORIUM_PRODUCER_REVISION
ARG CODEXIA_PRODUCER_REVISION=${SCRIPTORIUM_PRODUCER_REVISION}
ARG SCRIPTORIUM_DOCKERFILE_SHA256
ARG CODEXIA_DOCKERFILE_SHA256=${SCRIPTORIUM_DOCKERFILE_SHA256}
ENV CODEXIA_PRODUCER_REVISION=${CODEXIA_PRODUCER_REVISION} \
    CODEXIA_DOCKERFILE_SHA256=${CODEXIA_DOCKERFILE_SHA256}
LABEL org.opencontainers.image.revision=${CODEXIA_PRODUCER_REVISION}
RUN test "${#CODEXIA_PRODUCER_REVISION}" -eq 40 \
 && printf '%s' "${CODEXIA_PRODUCER_REVISION}" | grep -Eq '^[a-f0-9]{40}$' \
 && printf '%s' "${CODEXIA_DOCKERFILE_SHA256}" | grep -Eq '^[a-f0-9]{64}$'
RUN pnpm build:workspace
RUN node scripts/profile-package.mjs --modules-json '[]' --prebuilt --prime-deploy-cache --out /tmp/codexia-hosted-artifact/app \
 && rm -rf /tmp/codexia-hosted-artifact
COPY --from=frontend-build /codexia-buildkit-frontend /usr/local/bin/codexia-buildkit-frontend
COPY --from=smoke-postgres /opt/codexia-smoke-postgres /opt/codexia-smoke-postgres
ENTRYPOINT ["/usr/local/bin/codexia-buildkit-frontend"]

FROM ${NODE_IMAGE} AS runtime-base
ARG SCRIPTORIUM_PRODUCER_REVISION
ARG CODEXIA_PRODUCER_REVISION=${SCRIPTORIUM_PRODUCER_REVISION}
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    CODEXIA_BUILD_PROFILE=hosted \
    CODEXIA_BUILD_MODULE_PROFILE_PATH=/app/generated/server.mjs \
    CODEXIA_BUILD_DATA_DIR=/data \
    CODEXIA_BUILD_USAGE_DIR=/history \
    HOME=/data \
    CODEXIA_PRODUCER_REVISION=${CODEXIA_PRODUCER_REVISION}
LABEL org.opencontainers.image.revision=${CODEXIA_PRODUCER_REVISION}
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git tini \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /app /data /history \
 && chmod 0700 /history \
 && chown node:node /app /data /history
WORKDIR /app
USER node
VOLUME ["/data", "/history"]
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "launch.mjs"]

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

USER node
VOLUME ["/data", "/history"]
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "launch.mjs"]
