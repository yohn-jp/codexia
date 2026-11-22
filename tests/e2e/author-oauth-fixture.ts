import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test as base, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { startBetterAuthFixture, type BetterAuthFixture } from "../../packages/api/test/fixtures/better-auth-server.js";
import { browserServerProfile } from "./browser-server-profile";

type Shell = "desktop" | "mobile";
export type AuthorApiFetch = APIRequestContext["fetch"];
export interface AuthorSession { origin: string; fetch: AuthorApiFetch }
interface AuthorNavigation { path?: string; expectedView?: Locator; continueCurrentPage?: boolean }
export type AuthorizeAuthor = (shell: Shell, targetPage?: Page, navigation?: AuthorNavigation) => Promise<AuthorSession>;

async function signIn(page: Page, origin: string, shell: Shell, navigation: AuthorNavigation): Promise<string> {
  const destination = new URL(navigation.continueCurrentPage ? page.url() : navigation.path ?? `/${shell}/`, origin);
  if (destination.origin !== origin || (destination.pathname !== `/${shell}` && !destination.pathname.startsWith(`/${shell}/`))) {
    throw new Error(`Author sign-in requires a ${shell} route on the fixture origin`);
  }
  if (!navigation.continueCurrentPage) await page.goto(destination.href);
  const provider = page.getByRole("button", { name: "IDプロバイダーでサインイン" });
  const consent = page.getByRole("button", { name: "許可して続ける" });
  const expectedView = navigation.expectedView ?? page.getByRole("heading", { name: "Database workspace" });
  const [issued] = await Promise.all([
    page.waitForResponse((response) => response.url() === `${origin}/api/auth/oauth2/token` && response.ok()),
    (async () => {
      await page.getByRole("button", { name: /^(?:OAuthでサインイン|OAuthで再認証)$/u }).click();
      await provider.or(consent).or(expectedView).first().waitFor();
      if (await provider.isVisible()) {
        await provider.click();
        await consent.or(expectedView).first().waitFor();
      }
      if (await consent.isVisible()) await consent.click();
      await expect(expectedView).toBeVisible();
    })(),
  ]);
  const body = await issued.json() as { access_token?: unknown };
  if (typeof body.access_token !== "string") throw new Error("Better Auth did not issue an API access token for the test author");
  return body.access_token;
}

export const test = base.extend<{
  authorizeAuthor: AuthorizeAuthor;
}, { authorServer: BetterAuthFixture }>({
  authorServer: [async ({}, use) => {
    const databaseUrl = process.env.CODEXIA_E2E_DATABASE_URL;
    if (!databaseUrl) throw new Error("The browser acceptance shard needs a disposable PostgreSQL database");
    const stateDirectory = await mkdtemp(join(tmpdir(), "codexia-author-browser-"));
    let server: BetterAuthFixture | undefined;
    try {
      const assets = join(stateDirectory, "assets");
      const profile = process.env.CODEXIA_PROFILE ?? "core";
      server = await startBetterAuthFixture({
        databaseUrl,
        staticDirectory: assets,
        usePostgresPersistence: true,
        appProfile: await browserServerProfile(profile, join(stateDirectory, "module-cache")),
      });
      const build = spawnSync(process.execPath, ["app/scripts/build-views.mjs"], {
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
          VITE_CODEXIA_OAUTH_MOBILE_REDIRECT_URI: `${server.apiOrigin}/mobile`,
          VITE_CODEXIA_OAUTH_SCOPES: "openid codexia:api",
        },
      });
      if (build.error) throw build.error;
      if (build.status !== 0) throw new Error(`Author browser fixture build failed:\n${build.stdout}\n${build.stderr}`);
      await use(server);
    } finally {
      try { await server?.close(); }
      finally { await rm(stateDirectory, { recursive: true, force: true }); }
    }
  }, { scope: "worker", timeout: 90_000 }],
  authorizeAuthor: async ({ page, playwright, authorServer }, use) => {
    const origin = authorServer.apiOrigin;
    const request = await playwright.request.newContext();
    const sessions = new WeakMap<Page, AuthorSession>();
    try {
      await use(async (shell, targetPage = page, navigation = {}) => {
        const previous = navigation.continueCurrentPage && sessions.get(targetPage);
        const view = navigation.expectedView ?? targetPage.getByRole("heading", { name: "Database workspace" });
        if (previous && new URL(targetPage.url()).origin === origin && await view.isVisible()) return previous;
        const accessToken = await signIn(targetPage, origin, shell, navigation);
        const session: AuthorSession = { origin, fetch: (path, options) => {
          if (typeof path !== "string") throw new Error("Author API requests require an explicit URL or path");
          const url = new URL(path, origin);
          if (url.origin !== origin || !url.pathname.startsWith("/api/") || url.pathname.startsWith("/api/auth/")) {
            throw new Error("The test author bearer is scoped to data requests on the fixture origin");
          }
          return request.fetch(url.href, {
            ...options,
            maxRedirects: 0,
            headers: { ...options?.headers, Authorization: `Bearer ${accessToken}` },
          });
        } };
        sessions.set(targetPage, session);
        return session;
      });
    } finally {
      await request.dispose();
    }
  },
});

export { expect };
