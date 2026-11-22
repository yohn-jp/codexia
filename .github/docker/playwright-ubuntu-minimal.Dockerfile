# Ubuntu 24.04 runtime matching the official Playwright image's OS family.
# Base digests are the exact versions used by the passing image build. Review
# base updates with the browser smoke test before selecting a new runtime digest.
FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS node
FROM ubuntu:24.04@sha256:9c7f200c07e3d4a03e7249d2c16bf66a51120fb876aa2242cf31451412543289
COPY --from=node /usr/local/ /usr/local/
ENV PATH=/usr/local/bin:$PATH
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ARG PLAYWRIGHT_VERSION
ARG BROWSER
RUN set -eux; \
    case "$BROWSER" in chromium|webkit) ;; *) exit 1;; esac; \
    test "$PLAYWRIGHT_VERSION" = '1.65.1'; \
    apt-get update; apt-get install -y --no-install-recommends ca-certificates git; \
    mkdir -p /tmp/pw-install; \
    npm install --prefix /tmp/pw-install --no-audit --no-fund --no-save "playwright@${PLAYWRIGHT_VERSION}"; \
    if [ "$BROWSER" = chromium ]; then \
      node /tmp/pw-install/node_modules/playwright/cli.js install --with-deps --only-shell chromium; \
    else \
      node /tmp/pw-install/node_modules/playwright/cli.js install --with-deps webkit; \
    fi; \
    git --version; \
    BROWSER="$BROWSER" node -e 'const pw=require("/tmp/pw-install/node_modules/playwright"); (async()=>{const b=await pw[process.env.BROWSER].launch({headless:true});const p=await b.newPage();await p.setContent("<title>smoke</title>");if(await p.title()!=="smoke")throw Error("smoke failed");await b.close()})().catch(e=>{console.error(e);process.exitCode=1})'; \
    rm -rf /tmp/pw-install /root/.npm /root/.cache /var/lib/apt/lists/*
# Runtime tools and installed browsers must execute without root privileges.
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin codexia-browser
ENV HOME=/home/codexia-browser
USER codexia-browser
LABEL org.opencontainers.image.source="https://github.com/yohn-jp/codexia"
