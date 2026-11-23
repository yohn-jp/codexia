import { expect, test as base, type APIRequestContext, type Page } from "@playwright/test";
import type { BetterAuthFixture } from "../../packages/api/test/fixtures/better-auth-server.js";
import { signInAuthorBrowser, startAuthorBrowserFixture, type AuthorNavigation, type Shell } from "./author-oauth-server";

export type AuthorApiFetch = APIRequestContext["fetch"];
export interface AuthorSession { origin: string; fetch: AuthorApiFetch }
export type AuthorizeAuthor = (shell: Shell, targetPage?: Page, navigation?: AuthorNavigation & { apiSetupOnly?: true }) => Promise<AuthorSession>;

export const test = base.extend<{
  authorizeAuthor: AuthorizeAuthor;
}, { authorServer: BetterAuthFixture; authorHostname: "127.0.0.1" | "localhost" }>({
  authorHostname: ["127.0.0.1", { scope: "worker", option: true }],
  authorServer: [async ({ authorHostname }, use) => {
    const databaseUrl = process.env.CODEXIA_E2E_DATABASE_URL;
    if (!databaseUrl) throw new Error("The browser acceptance shard needs a disposable PostgreSQL database");
    const frontendSource = process.env.CODEXIA_E2E_COMPAT_FRONTEND_SOURCE;
    const server = await startAuthorBrowserFixture({
      databaseUrl, profile: process.env.CODEXIA_PROFILE ?? "core", frontendSource,
      apiHostname: authorHostname,
    });
    try { await use(server); }
    finally { await server.close(); }
  }, { scope: "worker", timeout: 90_000 }],
  authorizeAuthor: async ({ page, playwright, authorServer }, use) => {
    const origin = authorServer.apiOrigin;
    const request = await playwright.request.newContext();
    const sessions = new WeakMap<Page, AuthorSession>();
    const sessionFor = (accessToken: string): AuthorSession => ({ origin, fetch: (path, options) => {
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
    } });
    try {
      await use(async (shell, targetPage = page, navigation = {}) => {
        if (navigation.apiSetupOnly) {
          if (navigation.path || navigation.expectedView || navigation.continueCurrentPage) {
            throw new Error("API-only fixture setup cannot request browser navigation");
          }
          // Still obtain a real Better Auth OAuth code-flow token, without rendering
          // the login/consent UI twice for every unrelated authoring scenario.
          return sessionFor(await authorServer.issueOwnerAccessToken());
        }
        const previous = navigation.continueCurrentPage && sessions.get(targetPage);
        const view = navigation.expectedView ?? targetPage.getByRole("heading", { name: "Database workspace" });
        if (previous && new URL(targetPage.url()).origin === origin && await view.isVisible()) return previous;
        const session = sessionFor(await signInAuthorBrowser(targetPage, origin, shell, navigation));
        sessions.set(targetPage, session);
        return session;
      });
    } finally {
      await request.dispose();
    }
  },
});

export { expect };
