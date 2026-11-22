# Benchmark-only candidate. Do not publish or use as a certified CI runtime.
# WebKit lanes run both Chromium and WebKit, unlike a single-browser WebKit image.
FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS node
FROM ubuntu:24.04@sha256:9c7f200c07e3d4a03e7249d2c16bf66a51120fb876aa2242cf31451412543289
COPY --from=node /usr/local/ /usr/local/
ENV PATH=/usr/local/bin:$PATH
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates git; \
    mkdir -p /tmp/pw-install; \
    npm install --prefix /tmp/pw-install --no-audit --no-fund --no-save 'playwright@1.65.1'; \
    node /tmp/pw-install/node_modules/playwright/cli.js install --with-deps --only-shell chromium; \
    node /tmp/pw-install/node_modules/playwright/cli.js install --with-deps webkit; \
    git --version; \
    node -e 'const pw=require("/tmp/pw-install/node_modules/playwright"); (async()=>{for(const name of ["chromium","webkit"]){const b=await pw[name].launch({headless:true});try{const p=await b.newPage();await p.setContent("<title>dual-ci</title>");if(await p.title()!=="dual-ci")throw Error(name+" smoke failed")}finally{await b.close()}}})().catch(e=>{console.error(e);process.exitCode=1})'; \
    rm -rf /tmp/pw-install /root/.npm /root/.cache /var/lib/apt/lists/*
LABEL org.opencontainers.image.source="https://github.com/yohn-jp/codexia"
