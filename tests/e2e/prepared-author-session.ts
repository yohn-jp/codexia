import type { Page, Request } from "@playwright/test";
import { createAuthorSession, expect, test as authorTest } from "./author-oauth-fixture";

interface PendingClaim { destination: string; token: string }
interface Handoff { pending?: PendingClaim }

/** Restore a real test-scoped bearer only on an explicitly selected document. */
async function openPreparedAuthor(
  page: Page, origin: string, shell: "desktop", destination: URL,
  token: string, handoffs: WeakMap<Page, Handoff>,
  expectedView = page.getByRole("heading", { name: "Database workspace" }),
): Promise<void> {
  if (destination.origin !== origin || (destination.pathname !== `/${shell}` && !destination.pathname.startsWith(`/${shell}/`))) {
    throw new Error("Prepared author navigation escaped the fixture shell");
  }
  let handoff = handoffs.get(page);
  if (!handoff) {
    const installed: Handoff = {};
    await page.exposeBinding("__codexiaClaimPreparedAuthor", ({ page: caller, frame }) => {
      const claim = installed.pending;
      if (!claim) return null;
      if (caller !== page || frame !== page.mainFrame() || frame.url() !== claim.destination) {
        throw new Error("Prepared author token claim was not bound to this document");
      }
      delete installed.pending;
      return claim.token;
    });
    handoffs.set(page, installed);
    handoff = installed;
  }
  let oauthRequests = 0;
  const observe = (request: Request) => {
    const url = new URL(request.url());
    if (url.origin === origin && (/^\/oauth\/(?:login|consent)(?:\/|$)/u.test(url.pathname) ||
      /^\/api\/auth\/(?:oauth2\/(?:authorize|token|consent)|sign-in\/social)(?:\/|$)/u.test(url.pathname))) oauthRequests++;
  };
  handoff.pending = { destination: destination.href, token };
  page.on("request", observe);
  try {
    await Promise.all([
      page.waitForResponse(response => response.url() === `${origin}/api/session` && response.ok()),
      page.goto(destination.href, { waitUntil: "domcontentloaded" }),
    ]);
    await expect(expectedView).toBeVisible();
    expect(handoff.pending === undefined, "prepared token must be claimed once").toBe(true);
    expect(oauthRequests, "non-authentication setup must not execute browser OAuth").toBe(0);
  } finally {
    delete handoff.pending;
    page.off("request", observe);
  }
}

/** Explicit opt-in only: normal OAuth and reload/reauthentication proofs remain canonical. */
export const preparedAuthorTest = authorTest.extend({
  authorizeAuthor: async ({ authorizeAuthor, page, playwright, authorServer }, use) => {
    const request = await playwright.request.newContext();
    const handoffs = new WeakMap<Page, Handoff>();
    let token: Promise<string> | undefined;
    const realToken = () => token ??= authorTest.step("CI phase: prepare-test-author-token", async () => {
      const started = performance.now();
      const value = await authorServer.issueOwnerAccessToken();
      console.log(JSON.stringify({ phase: "prepared-author-token", durationMs: Math.round(performance.now() - started) }));
      return value;
    });
    try {
      await use(async (shell, targetPage = page, navigation = {}) => {
        // Cross-version frontend proof and explicit reauthentication keep the ordinary path.
        if (navigation.continueCurrentPage || process.env.CODEXIA_E2E_COMPAT_FRONTEND_SOURCE) return authorizeAuthor(shell, targetPage, navigation);
        if (!authorServer.preparedAuthorEntries) throw new Error("Prepared author entry missing for explicitly opted-in test");
        if (navigation.apiSetupOnly) {
          if (navigation.path || navigation.expectedView) throw new Error("API-only setup cannot request browser navigation");
          return createAuthorSession(request, authorServer.apiOrigin, await realToken());
        }
        const accessToken = await realToken();
        const started = performance.now();
        await authorTest.step("CI phase: prepared-browser-runtime", () => openPreparedAuthor(
          targetPage, authorServer.apiOrigin, shell, new URL(navigation.path ?? `/${shell}/`, authorServer.apiOrigin),
          accessToken, handoffs, navigation.expectedView,
        ));
        console.log(JSON.stringify({ phase: "prepared-author-runtime", shell, durationMs: Math.round(performance.now() - started), browserOAuthRequests: 0 }));
        return createAuthorSession(request, authorServer.apiOrigin, accessToken);
      });
    } finally {
      token = undefined;
      await request.dispose();
    }
  },
});
