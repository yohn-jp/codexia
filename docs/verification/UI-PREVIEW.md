# UI preview and Impeccable Detector (Windows / Linux / macOS)

The local preview serves the Desktop React authoring UI with Better Auth and disposable PostgreSQL. The supported authoring platforms and browser verification scope are defined in [System design](../architecture/SYSTEM-DESIGN.md) and [E2E execution](E2E-EXECUTION.md). [UX-CONTRACT](../design/UX-CONTRACT.md) defines UX acceptance and [DESIGN.md](../../app/DESIGN.md) records the agreed visual design.

## Design checks on GitHub

The [Impeccable workflow](../../.github/workflows/impeccable.yml) runs on pull requests to `main` and pushes to `main` that touch its inputs. It scans the complete app and module sources on each selected run. To reproduce the scan from the repository root:

```sh
.agents/skills/impeccable/scripts/impeccable detect --sarif --no-advisory app modules/*/src
```

The project includes the skill and a launcher that fetches and verifies the pinned engine on a fresh runner. The workflow uses the [upstream SARIF integration](https://github.com/pbakaus/impeccable/blob/b49177d32788f2dc585c42831d845dacf1ebed2c/README.md#three-ways-to-run-the-detector) to publish primary findings to GitHub Code scanning under `impeccable`. Exit 0 uploads a clean report and exit 2 uploads findings. A scanner error fails the job before upload. Omit `--no-advisory` locally to include suggestions such as font sizes outside the documented scale. The detector reads the app's design system during source scans. Automatic agent hooks are disabled.

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

This builds the selected profile and the UI assets configured for the local OAuth issuer. The shared fixture migrates disposable PostgreSQL and registers a local owner and client. The preview seeds a sample project with a volume, chapter and two scenes through the authenticated API. It signs in through the real browser OAuth flow, opens a seeded scene in Desktop, and saves PNGs and inert HTML in `artifacts/ui-preview/snapshots/`. The preview command remains running.

The terminal prints the interactive addresses.

- `http://127.0.0.1:4173/desktop/`

To explore the preview in your browser, choose **OAuthでサインイン**, then **IDプロバイダーでサインイン**. Choose **許可して続ける** if prompted. The identity provider uses the disposable preview account. After capture, the terminal prints the Desktop snapshot URL from a second loopback-only server. The server serves the rendered documents with scripts removed and prevents API requests.

In a second PowerShell at the repository root, while preview is running:

```powershell
corepack pnpm ui:scan
```

The scanner runs the pinned Impeccable engine against `app/` and the frozen Desktop snapshot at `1440x900`. Reports are written to `artifacts/ui-preview/detector/{source,desktop,summary}.json` (ignored by git). Exit code **2** from Impeccable is findings, **1** is a failed scan; only a successful scan is included in the summary. There is no inference that an empty JSON from a failed HTTP request means a clean UI. Runs do not alter source or a design-system file.

The snapshots preserve the seeded, authenticated layout but **are not interactive**. They do not prove end-to-end behavior, permissions, animations or native iOS rendering. Those remain covered by existing E2E tests and manual UX review. A separate browser scan of the real interactive URLs would only examine the sign-in state in a new unauthenticated browser; do not count that as an editor audit.

On exit (`Ctrl+C`) the script stops its API, removes its PostgreSQL container and temporary server state, and deletes the active scan session file. Screenshots and reports stay under `artifacts/` until removed. On an abnormal hard shutdown, find orphaned local containers using `docker ps --filter label=dev.codexia.purpose=ui-preview` (or `podman ps ...`), and stop only the identified preview container.

Options include `--port 4173`, `--profile core|full`, `--engine auto|docker|podman`, `--skip-build`, and `--no-capture`. With `--skip-build`, the preview reuses previously built packages and profile artifacts and still builds UI assets for the current OAuth client. `--no-capture` serves the interactive preview only. Full-profile modules require their existing build dependencies.

### Troubleshooting

- **`EUNSUPPORTEDPROTOCOL workspace:*`**: do not use npm install. Run `corepack pnpm install --frozen-lockfile` at the repository root.
- **Vite's `browser-modules` import missing**: do not start Vite directly. The preview build calls the canonical profile generator before serving UI.
- **`ERR_CONNECTION_REFUSED` or blank scan JSON**: confirm the preview command is still running and `ui:scan` sees its matching snapshot session. The scanner rejects a failed URL scan.
- **`PostgreSQLへ接続できません (404)`**: the Vite-only port is not an API server. Use the preview port (`4173` by default), which serves the API and both built UIs from one origin.
- **Browser capture failed**: install Chromium as above, then retry `ui:preview`, or use `ui:preview --no-capture` temporarily for API diagnosis.
- **Port already in use**: `corepack pnpm ui:preview --port 4181`; the scanner discovers the snapshot port from the running session.

Review findings against the visual design and UX contract. Use the authenticated snapshots to check rendered layout and contrast, and the interactive preview to verify focus and editing behavior.
