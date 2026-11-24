import { expect, test as base, type APIRequestContext, type Page } from "@playwright/test";
import { signInAuthorBrowser, startAuthorBrowserFixture, type AuthorBrowserFixture, type AuthorNavigation, type Shell } from "./author-oauth-server";

export type AuthorApiFetch = APIRequestContext["fetch"];
export interface AuthorSession { origin: string; fetch: AuthorApiFetch }
export type AuthorizeAuthor = (shell: Shell, targetPage?: Page, navigation?: AuthorNavigation & { apiSetupOnly?: true }) => Promise<AuthorSession>;

export function createAuthorSession(request: APIRequestContext, origin: string, accessToken: string): AuthorSession {
  return { origin, fetch: (path, options) => {
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
}

export const test = base.extend<{
  authorizeAuthor: AuthorizeAuthor;
}, { authFixtureHost: "127.0.0.1" | "localhost"; preparedAuthorEntries: boolean; authorServer: AuthorBrowserFixture }>({
  authFixtureHost: ["127.0.0.1", { option: true, scope: "worker" }],
  preparedAuthorEntries: [false, { option: true, scope: "worker" }],
  authorServer: [async ({ authFixtureHost, preparedAuthorEntries }, use) => {
    const databaseUrl = process.env.CODEXIA_E2E_DATABASE_URL;
    if (!databaseUrl) throw new Error("The browser acceptance shard needs a disposable PostgreSQL database");
    const frontendSource = process.env.CODEXIA_E2E_COMPAT_FRONTEND_SOURCE;
    const server = await startAuthorBrowserFixture({ databaseUrl, profile: process.env.CODEXIA_PROFILE ?? "core", apiHostname: authFixtureHost, frontendSource, preparedAuthorEntries });
    try { await use(server); }
    finally { await server.close(); }
  }, { scope: "worker", timeout: 90_000 }],
  authorizeAuthor: async ({ page, playwright, authorServer }, use) => {
    const origin = authorServer.apiOrigin;
    const request = await playwright.request.newContext();
    const sessions = new WeakMap<Page, AuthorSession>();
    const sessionFor = (accessToken: string) => createAuthorSession(request, origin, accessToken);
    try {
      await use(async (shell, targetPage = page, navigation = {}) => {
        if (navigation.apiSetupOnly) {
          if (navigation.path || navigation.expectedView || navigation.continueCurrentPage) {
            throw new Error("API-only fixture setup cannot request browser navigation");
          }
          // Still obtain a real Better Auth OAuth code-flow token, without rendering
          // the login/consent UI twice for every unrelated authoring scenario.
          return sessionFor(await base.step("CI phase: api-auth", () => authorServer.issueOwnerAccessToken()));
        }
        const previous = navigation.continueCurrentPage && sessions.get(targetPage);
        const view = navigation.expectedView ?? targetPage.getByRole("heading", { name: "Database workspace" });
        if (previous && new URL(targetPage.url()).origin === origin && await view.isVisible()) return previous;
        const session = sessionFor(await base.step("CI phase: browser-auth", () => signInAuthorBrowser(targetPage, origin, shell, navigation)));
        sessions.set(targetPage, session);
        return session;
      });
    } finally {
      await request.dispose();
    }
  },
});

export { expect };
