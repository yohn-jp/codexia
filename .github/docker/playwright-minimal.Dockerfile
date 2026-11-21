# Purpose-built disposable CI image. Do not use for untrusted browsing.
FROM node:24.22.3-bookworm-slim

ARG PLAYWRIGHT_VERSION
ARG BROWSER
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# The Playwright package is used only at build time; tests install their own
# lockfile-pinned package. Keep only the selected browser and OS runtime deps.
RUN set -eux; \
    case "$BROWSER" in chromium|webkit) ;; *) echo 'BROWSER must be chromium or webkit' >&2; exit 1;; esac; \
    test -n "$PLAYWRIGHT_VERSION"; \
    mkdir -p /tmp/pw-install; \
    npm install --prefix /tmp/pw-install --no-audit --no-fund --no-save "playwright@${PLAYWRIGHT_VERSION}"; \
    if [ "$BROWSER" = chromium ]; then \
      node /tmp/pw-install/node_modules/playwright/cli.js install --with-deps --only-shell chromium; \
    else \
      node /tmp/pw-install/node_modules/playwright/cli.js install --with-deps webkit; \
    fi; \
    BROWSER="$BROWSER" node -e 'const pw = require("/tmp/pw-install/node_modules/playwright"); (async () => { const browser = await pw[process.env.BROWSER].launch({headless:true}); const page = await browser.newPage(); await page.setContent("<title>minimal-playwright-smoke</title>"); if (await page.title() !== "minimal-playwright-smoke") throw new Error("Browser smoke assertion failed"); await browser.close(); })().catch(err => { console.error(err); process.exitCode = 1; });'; \
    rm -rf /tmp/pw-install /root/.npm /root/.cache /var/lib/apt/lists/*

LABEL org.opencontainers.image.source="https://github.com/yohn-jp/codexia"
