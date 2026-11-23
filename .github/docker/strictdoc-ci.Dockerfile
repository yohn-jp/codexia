# Experimental exact-version StrictDoc runtime; not used by production CI until published by digest.
FROM ghcr.io/yohn-jp/playwright-ubuntu-chromium@sha256:d11b4fa1128d937fcda9dd0106d138b65c3e72cbad07d4801547aa66fc1c4725
USER root
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv python3-pip && rm -rf /var/lib/apt/lists/*
COPY scripts/strictdoc/requirements.lock.txt /tmp/strictdoc-requirements.lock.txt
RUN python3 -m venv /opt/strictdoc && /opt/strictdoc/bin/pip install --disable-pip-version-check --requirement /tmp/strictdoc-requirements.lock.txt && /opt/strictdoc/bin/strictdoc --version
ENV STRICTDOC_BIN=/opt/strictdoc/bin/strictdoc
USER codexia-browser
