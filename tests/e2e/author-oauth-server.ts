import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page } from "@playwright/test";
import { startBetterAuthFixture, type BetterAuthFixture } from "../../packages/api/test/fixtures/better-auth-server.js";
import { browserServerProfile, hasRestoredBrowserProfile } from "./browser-server-profile";

export type Shell = "desktop";
export interface AuthorNavigation { path?: string; expectedView?: Locator; continueCurrentPage?: boolean }
export interface AuthorBrowserFixture extends BetterAuthFixture {
  readonly preparedAuthorEntries: boolean;
  readonly startupMs: number;
}

const root = fileURLToPath(new URL("../../", import.meta.url));

function observePhase(stage: string, started: number, profile: string): void {
  if (process.env.CI !== "true") return;
  console.log(JSON.stringify({ phase: "e2e-fixture-timing", stage, profile,
    shard: process.env.CODEXIA_E2E_SHARD ?? null, durationMs: Math.round(performance.now() - started) }));
}

// Comparison only: both trees remain unchanged and every fixture still uses
// its actual OAuth-configured build. Never substitute a producer asset based
// on one successful observation; each independently required entry must
// prove configuration and byte equivalence before any reuse is admitted.
function compareAuthorAssets(producer: string, fixture: string, profile: string): void {
  const entries = ["launcher", "desktop", "oauth", "owner-setup"];
  const partition = (file: string) => file.startsWith("console/setup/") ? "owner-setup"
    : ["desktop", "oauth"].find(entry => file.startsWith(entry + "/")) ?? "launcher";
  const inventory = (directory: string) => {
    const files = new Map<string, string>();
    function visit(relative: string): void {
      for (const item of readdirSync(join(directory, relative), { withFileTypes: true })) {
        const file = relative ? relative + "/" + item.name : item.name;
        if (item.isDirectory()) visit(file);
        else if (item.isFile()) files.set(file, createHash("sha256").update(readFileSync(join(directory, file))).digest("hex"));
        else throw new Error("Nonregular fixture asset");
      }
    }
    visit("");
    return files;
  };
  const a = inventory(producer);
  const b = inventory(fixture);
  const comparison = entries.map(entry => {
    const left = [...a.keys()].filter(file => partition(file) === entry);
    const right = [...b.keys()].filter(file => partition(file) === entry);
    const shared = left.filter(file => b.get(file) === a.get(file)).length;
    return { entry, producerFiles: left.length, fixtureFiles: right.length, identicalFiles: shared,
      byteEquivalent: left.length > 0 && left.length === right.length && shared === left.length };
  });
  console.log(JSON.stringify({ phase: "e2e-fixture-asset-equivalence", profile,
    shard: process.env.CODEXIA_E2E_SHARD ?? null, entries: comparison }));
}

export function buildAuthorBrowserAssets(
  server: Pick<BetterAuthFixture, "apiOrigin" | "issuer" | "webClientId" | "audience">,
  profile: string,
  assets: string,
  frontendSource?: string,
  preparedAuthorEntries = false,
): void {
  const command = frontendSource ? "pnpm" : process.execPath;
  const args = frontendSource ? ["build:frontend"] : [preparedAuthorEntries ? "tests/e2e/build-prepared-author-views.mjs" : "app/scripts/build-views.mjs"];
  // The CI browser group has already validated the producer receipt and restored
  // the generated clients. OAuth settings still require a new isolated Vite build.
  if (!frontendSource && hasRestoredBrowserProfile(profile)) {
    args.push("--prepared");
  }
  const started = performance.now();
  const build = spawnSync(command, args, {
    cwd: frontendSource ?? root,
    encoding: "utf8",
    env: {
      ...process.env,
      CODEXIA_PROFILE: profile,
      CODEXIA_VITE_BUILD_OUTPUT_ROOT: assets,
      VITE_CODEXIA_API_ORIGIN: server.apiOrigin,
      VITE_CODEXIA_OAUTH_ISSUER: server.issuer,
      VITE_CODEXIA_OAUTH_CLIENT_ID: server.webClientId,
      VITE_CODEXIA_API_AUDIENCE: server.audience,
      VITE_CODEXIA_OAUTH_DESKTOP_REDIRECT_URI: `${server.apiOrigin}/desktop`,
      VITE_CODEXIA_OAUTH_SCOPES: "openid codexia:api",
    },
  });
  if (build.error) throw build.error;
  if (build.status !== 0) throw new Error(`Author browser fixture build failed:\n${build.stdout}\n${build.stderr}`);
  observePhase("vite-build", started, profile);
  if (!frontendSource && process.env.CI === "true" && process.env.CODEXIA_CI_PROFILE_RESTORE === "success" && process.env.CODEXIA_E2E_COMPARE_ASSETS === "1") {
    const compareStarted = performance.now();
    compareAuthorAssets(join(root, "app/dist"), assets, profile);
    observePhase("asset-comparison", compareStarted, profile);
  }
}

export async function startAuthorBrowserFixture({ databaseUrl, profile, apiPort, apiHostname, frontendSource, preparedAuthorEntries = false }: {
  databaseUrl: string;
  profile: string;
  apiPort?: number;
  apiHostname?: "localhost" | "127.0.0.1";
  frontendSource?: string;
  preparedAuthorEntries?: boolean;
}): Promise<AuthorBrowserFixture> {
  const fixtureStarted = performance.now();
  const stateDirectory = await mkdtemp(join(tmpdir(), "codexia-author-browser-"));
  let server: BetterAuthFixture | undefined;
  const close = async () => {
    try { await server?.close(); }
    finally { await rm(stateDirectory, { recursive: true, force: true }); }
  };
  try {
    const assets = frontendSource ? join(frontendSource, "app/dist") : join(stateDirectory, "assets");
    const started = performance.now();
    server = await startBetterAuthFixture({
      databaseUrl,
      staticDirectory: assets,
      ...(apiPort === undefined ? {} : { apiPort }),
      ...(apiHostname === undefined ? {} : { apiHostname }),
      usePostgresPersistence: true,
      appProfile: await browserServerProfile(profile, join(stateDirectory, "module-cache")),
    });
    observePhase("api-db-auth-bootstrap", started, profile);
    const usePreparedEntries = preparedAuthorEntries && !frontendSource;
    buildAuthorBrowserAssets(server, profile, assets, frontendSource, usePreparedEntries);
    if (usePreparedEntries) {
      const directory = join(assets, "desktop", "assets");
      const hasHandoff = readdirSync(directory).some(name => name.endsWith(".js") &&
        readFileSync(join(directory, name), "utf8").includes("__codexiaClaimPreparedAuthor"));
      if (!hasHandoff) throw new Error("Isolated prepared author entry was not built");
    }
    return { ...server, close, preparedAuthorEntries: usePreparedEntries, startupMs: Math.round(performance.now() - fixtureStarted) };
  } catch (error) {
    await close();
    throw error;
  }
}

// Classify observed requests without retaining query strings, codes, tokens, headers or project IDs.
const observedAuthContexts = new WeakSet<ReturnType<Page["context"]>>();

export async function signInAuthorBrowser(page: Page, origin: string, shell: Shell, navigation: AuthorNavigation = {}): Promise<string> {
  const destination = new URL(navigation.continueCurrentPage ? page.url() : navigation.path ?? `/${shell}/`, origin);
  if (destination.origin !== origin || (destination.pathname !== `/${shell}` && !destination.pathname.startsWith(`/${shell}/`))) {
    throw new Error(`Author sign-in requires a ${shell} route on the fixture origin`);
  }
  const context = page.context();
  const firstContextAuth = !observedAuthContexts.has(context);
  observedAuthContexts.add(context);
  const started = performance.now();
  const phases: Record<string, number> = {};
  const requests: Record<string, { count: number; durationMs: number }> = {};
  const now = () => Math.round(performance.now() - started);
  let outcome = "failed";
  const observe = (request: import("@playwright/test").Request) => {
    const url = new URL(request.url());
    const type = request.resourceType();
    const key = url.origin !== origin ? "external"
      : url.pathname.includes("/.well-known/") ? "discovery"
      : url.pathname === "/api/auth/oauth2/token" ? "token-exchange"
      : url.pathname.startsWith("/api/auth/") ? "auth-api"
      : url.pathname === "/api/version" ? "version"
      : url.pathname === "/api/session" ? "session"
      : url.pathname.startsWith("/api/") ? "data-api"
      : type === "document" ? "document"
      : type === "script" ? "script" : "other";
    const row = requests[key] ??= { count: 0, durationMs: 0 };
    row.count++;
    row.durationMs += Math.max(0, Math.round(request.timing().responseEnd));
  };
  page.on("requestfinished", observe);
  try {
    if (!navigation.continueCurrentPage) await page.goto(destination.href);
    phases.navigation = now();
    const provider = page.getByRole("button", { name: "IDプロバイダーでサインイン" });
    const consent = page.getByRole("button", { name: "許可して続ける" });
    const expectedView = navigation.expectedView ?? page.getByRole("heading", { name: "Database workspace" });
    const signIn = page.getByRole("button", { name: /^(?:OAuthでサインイン|OAuthで再認証)$/u });
    await signIn.waitFor({ state: "visible" });
    phases.loginReady = now();
    const [issued] = await Promise.all([
      page.waitForResponse((response) => response.url() === `${origin}/api/auth/oauth2/token` && response.ok()).then(response => {
        phases.tokenResponse = now();
        return response;
      }),
      (async () => {
        await signIn.click();
        phases.signInClicked = now();
        await provider.or(consent).or(expectedView).first().waitFor();
        phases.firstPrompt = now();
        if (await provider.isVisible()) {
          phases.providerStart = now();
          await provider.click();
          await consent.or(expectedView).first().waitFor();
          phases.providerEnd = now();
        }
        if (await consent.isVisible()) {
          phases.consentStart = now();
          await consent.click();
          phases.consentClicked = now();
        }
        await expect(expectedView).toBeVisible();
        phases.workspaceReady = now();
      })(),
    ]);
    const body = await issued.json() as { access_token?: unknown };
    if (typeof body.access_token !== "string") throw new Error("Better Auth did not issue an API access token for the test author");
    outcome = "passed";
    return body.access_token;
  } finally {
    page.off("requestfinished", observe);
    if (process.env.CI === "true") console.log(JSON.stringify({
      phase: "browser-auth-detail", shell, firstContextAuth, continueCurrentPage: Boolean(navigation.continueCurrentPage),
      outcome, durationMs: now(), phases, requests,
    }));
  }
}
