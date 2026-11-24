import type { BrowserContext, Request } from "@playwright/test";
import type { BetterAuthFixture } from "../../packages/api/test/fixtures/better-auth-server.js";
import { expect, test as authorTest } from "./author-oauth-fixture";

/** Prepare a fresh, real Better Auth session inside this test's own cookie jar.
 * No token or cookie copying, storageState file, database writes or product hook.
 * The app still performs its normal Authorization Code + PKCE browser flow.
 */
async function prepareOwnerSession(context: BrowserContext, server: BetterAuthFixture): Promise<void> {
  const origin = server.apiOrigin;
  const request = context.request;
  const signedIn = await request.post(`${origin}/api/auth/sign-in/social`, {
    data: { provider: "workspace-oidc", callbackURL: "/oauth/login", requestSignUp: true, disableRedirect: true },
    headers: { origin },
    maxRedirects: 0,
  });
  if (!signedIn.ok()) throw new Error("Prepared owner sign-in was rejected");
  const { url } = await signedIn.json() as { url?: string };
  if (!url) throw new Error("Prepared owner sign-in did not return the IdP URL");
  const authorizeUrl = new URL(url);
  if (authorizeUrl.origin !== server.idpIssuer || authorizeUrl.pathname !== "/authorize" ||
      authorizeUrl.searchParams.get("redirect_uri") !== `${origin}/api/auth/callback/workspace-oidc`) {
    throw new Error("Prepared owner sign-in returned an unexpected IdP route");
  }
  const upstream = await request.get(authorizeUrl.href, { maxRedirects: 0 });
  const location = upstream.headers().location;
  if (upstream.status() !== 302 || !location) throw new Error("Fixture IdP did not return its callback");
  const callback = new URL(location, origin);
  if (callback.origin !== origin || callback.pathname !== "/api/auth/callback/workspace-oidc" ||
      !callback.searchParams.get("code") || callback.searchParams.get("state") !== authorizeUrl.searchParams.get("state")) {
    throw new Error("Prepared owner sign-in returned an invalid callback");
  }
  const completed = await request.get(callback.href, { maxRedirects: 0 });
  if (completed.status() < 300 || completed.status() >= 400) throw new Error("Prepared owner callback failed");
  const session = await request.get(`${origin}/api/auth/get-session`, { maxRedirects: 0 });
  if (!session.ok()) throw new Error("Prepared owner session could not be read");
  const body = await session.json() as { user?: { id?: string }; session?: { id?: string } } | null;
  if (body?.user?.id !== server.ownerSubject || !body.session?.id) throw new Error("Prepared session is not the established owner");
}

/** Explicit opt-in only for scenarios whose obligation is not login/consent/session lifecycle. */
export const preparedAuthorTest = authorTest.extend({
  authorizeAuthor: async ({ authorizeAuthor, page, authorServer }, use) => {
    const prepared = new WeakSet<BrowserContext>();
    await use(async (shell, targetPage = page, navigation = {}) => {
      const context = targetPage.context();
      if (navigation.apiSetupOnly || navigation.continueCurrentPage || prepared.has(context)) {
        return authorizeAuthor(shell, targetPage, navigation);
      }
      await authorTest.step("CI phase: prepare-owner-session", () => prepareOwnerSession(context, authorServer));
      let browserProviderStarts = 0;
      const observe = (request: Request) => {
        const url = new URL(request.url());
        if (url.origin === authorServer.apiOrigin && url.pathname === "/api/auth/sign-in/social") browserProviderStarts++;
      };
      targetPage.on("request", observe);
      try {
        const session = await authorTest.step("CI phase: prepared-browser-auth", () => authorizeAuthor(shell, targetPage, navigation));
        expect(browserProviderStarts, "prepared session must avoid the redundant browser IdP sign-in").toBe(0);
        prepared.add(context);
        return session;
      } finally {
        targetPage.off("request", observe);
      }
    });
  },
});
