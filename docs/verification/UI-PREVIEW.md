# UI preview and Impeccable Detector (Windows / Linux / macOS)

This is a disposable visual-review environment, **not** a production or alternative persistence implementation. It serves the current built Desktop and Mobile UIs using the **existing E2E test server, real Codexia API and PostgreSQL fixtures**. It never points at an existing database, disables authentication or changes production routes. The UX acceptance authority remains [UX-CONTRACT](../design/UX-CONTRACT.md); its [visual-system proposal](../design/VISUAL-SYSTEM.md) is not automatically promoted to a design-system baseline.

## Prerequisites

- Node.js and pnpm versions from the root `package.json` (currently Node >=24, pnpm 12.21.0).
- A running **Docker Desktop** or Podman engine capable of pulling `postgres:17`. The harness runs a random-named container with **loopback-only ephemeral host port**, a random password, no mounted project or database volume, and removes it on exit.
- Chrome or Playwright Chromium for authenticated visual snapshots. If neither is available: `corepack pnpm exec playwright install chromium`. Impeccable's URL checks independently use an installed Chrome/Chromium/Edge.
- `corepack pnpm install --frozen-lockfile` from the repository root.

Open PowerShell at the root of a clone (do **not** run from `app/`):

```powershell
cd G:\Download\dev\codexia
corepack pnpm install --frozen-lockfile
corepack pnpm ui:preview
```

This builds the same Core profile and all three UI entry points as the existing release build, starts the disposable PostgreSQL database, applies the migrations via the existing E2E server, seeds one sample project/volume/chapter/two scenes, and checks the API and static UI entry points. It then signs in **through the real UI** in an isolated Playwright browser, opens a seeded scene in Desktop and Mobile and saves PNGs and inert HTML visual snapshots in `artifacts/ui-preview/snapshots/`. The preview command remains running.

The terminal prints an **ephemeral local owner token** and the real interactive addresses:

- `http://127.0.0.1:4173/desktop/`
- `http://127.0.0.1:4173/mobile/`

Enter the displayed token at the login screen to explore the real app. **Never** use a production token or database URL. When the browser capture is successful, the terminal additionally prints two snapshot URLs from a second loopback-only server. These contain the authenticated **rendered document with scripts removed**; they cannot perform writes or API requests and are suitable for inspecting visual appearance only.

In a second PowerShell at the repository root, while preview is running:

```powershell
corepack pnpm ui:scan
```

The scanner executes a **pinned Impeccable version** against `app/` and the frozen Desktop/Mobile snapshot URLs at `1440x900` and `390x844`. Reports are written to `artifacts/ui-preview/detector/{source,desktop,mobile,summary}.json` (ignored by git). Exit code **2** from Impeccable is findings, **1** is a failed scan; only a successful scan is included in the summary. There is no inference that an empty JSON from a failed HTTP request means a clean UI. Runs do not alter source or a design-system file.

The snapshots preserve the seeded, authenticated layout but **are not interactive**. They do not prove end-to-end behavior, permissions, animations or native iOS rendering. Those remain covered by existing E2E tests and manual UX review. A separate browser scan of the real interactive URLs would only examine the sign-in state in a new unauthenticated browser; do not count that as an editor audit.

On exit (`Ctrl+C`) the script stops its API, removes its PostgreSQL container and temporary server state, and deletes the active scan session file. Screenshots and reports stay under `artifacts/` until removed. On an abnormal hard shutdown, find orphaned local containers using `docker ps --filter label=dev.codexia.purpose=ui-preview` (or `podman ps ...`), and stop only the identified preview container.

Options: `--port 4173`, `--profile core|full`, `--engine auto|docker|podman`, `--skip-build` (only with already built artifacts), and `--no-capture` (API/DB interactive preview only; no authenticated snapshots). Full-profile modules require their existing build dependencies and are not needed for the Core UI baseline.

### Troubleshooting

- **`EUNSUPPORTEDPROTOCOL workspace:*`**: do not use npm install. Run `corepack pnpm install --frozen-lockfile` at the repository root.
- **Vite's `browser-modules` import missing**: do not start Vite directly. The preview build calls the canonical profile generator before serving UI.
- **`ERR_CONNECTION_REFUSED` or blank scan JSON**: confirm the preview command is still running and `ui:scan` sees its matching snapshot session. The scanner rejects a failed URL scan.
- **`PostgreSQLへ接続できません (404)`**: the Vite-only port is not an API server. Use the preview port (`4173` by default), which serves the API and both built UIs from one origin.
- **Browser capture failed**: install Chromium as above, then retry `ui:preview`, or use `ui:preview --no-capture` temporarily for API diagnosis.
- **Port already in use**: `corepack pnpm ui:preview --port 4181`; the scanner discovers the snapshot port from the running session.

UI design decisions belong in the existing `docs/design` authority. Impeccable slop-style findings (e.g. `overused-font`) are suggestions, not mandatory accessibility failures; never mass-change styles to force zero warnings.
