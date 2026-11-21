# Ubuntu 24.04 runtime matching the official Playwright image's OS family.
FROM node:24.22.3-bookworm-slim AS node
FROM ubuntu:24.04
COPY --from=node /usr/local/ /usr/local/
ENV PATH=/usr/local/bin:$PATH
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ARG PLAYWRIGHT_VERSION
ARG BROWSER
RUN set -eux; \
    case "$BROWSER" in chromium|webkit) ;; *) exit 1;; esac; \
    test "$PLAYWRIGHT_VERSION" = '1.65.1'; \
    apt-get update; apt-get install -y --no-install-recommends ca-certificates; \
    mkdir -p /tmp/pw-install; \
    npm install --prefix /tmp/pw-install --no-audit --no-fund --no-save "playwright@${PLAYWRIGHT_VERSION}"; \
    if [ "$BROWSER" = chromium ]; then \
      node /tmp/pw-install/node_modules/playwright/cli.js install --with-deps --only-shell chromium; \
    else \
      node /tmp/pw-install/node_modules/playwright/cli.js install --with-deps webkit; \
    fi; \
    BROWSER="$BROWSER" node -e 'const pw=require("/tmp/pw-install/node_modules/playwright"); (async()=>{const b=await pw[process.env.BROWSER].launch({headless:true});const p=await b.newPage();await p.setContent("<title>smoke</title>");if(await p.title()!=="smoke")throw Error("smoke failed");await b.close()})().catch(e=>{console.error(e);process.exitCode=1})'; \
    rm -rf /tmp/pw-install /root/.npm /root/.cache /var/lib/apt/lists/*
LABEL org.opencontainers.image.source="https://github.com/yohn-jp/codexia"
