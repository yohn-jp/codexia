# syntax=docker/dockerfile:1
ARG POSTGRES_IMAGE
FROM ${POSTGRES_IMAGE}

USER root
ARG PGTAP_VERSION
ARG PGTAP_ARCHIVE_SHA256
ARG MAKE_VERSION
ARG PATCH_VERSION

RUN rm -f /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install --no-install-recommends -y "make=${MAKE_VERSION}" "patch=${PATCH_VERSION}" \
 && rm -rf /var/lib/apt/lists/*

ADD --checksum=sha256:${PGTAP_ARCHIVE_SHA256} \
  https://codeload.github.com/theory/pgtap/tar.gz/refs/tags/v${PGTAP_VERSION} /tmp/pgtap.tar.gz
RUN tar -xzf /tmp/pgtap.tar.gz -C /tmp \
 && make -C /tmp/pgtap-${PGTAP_VERSION} PG_CONFIG=/usr/bin/pg_config install \
 && rm -rf /tmp/pgtap-${PGTAP_VERSION} /tmp/pgtap.tar.gz

USER postgres

# This fixture runs a PostgreSQL service; probe the actual server rather than a tool binary.
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 \
  CMD-SHELL pg_isready -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}" || exit 1
