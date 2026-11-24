# FROZEN: historical experiment pending retirement. Do not build or publish.
# Immutable StrictDoc and Chromium runtime. Publish through the exact-source main workflow and consume only by digest.
FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS node
FROM mcr.microsoft.com/playwright@sha256:1507cbfc550a63a6b7396791ca4f00df17beb56342d2447b3f106c306f525579
COPY --from=node /usr/local/ /usr/local/
ENV PATH=/usr/local/bin:$PATH
USER root
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv python3-pip && rm -rf /var/lib/apt/lists/*
COPY scripts/strictdoc/requirements.lock.txt /tmp/strictdoc-requirements.lock.txt
RUN python3 -m venv /opt/strictdoc && /opt/strictdoc/bin/pip install --disable-pip-version-check --requirement /tmp/strictdoc-requirements.lock.txt && /opt/strictdoc/bin/strictdoc --version
ENV STRICTDOC_BIN=/opt/strictdoc/bin/strictdoc
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin codexia-browser
ENV HOME=/home/codexia-browser
USER codexia-browser
