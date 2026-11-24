import type { Page, Request, Route } from "@playwright/test";
import { createAuthorSession, expect, test as authorTest } from "./author-oauth-fixture";

interface PendingClaim { destination: string; token: string }
interface Handoff { pending?: PendingClaim }

function replaceEntry(html: string, origin: string, shell: string, preparedEntry: string): string {
  const modules = [...html.matchAll(/<script\b[^>]*>/gu)].map(match => match[0])
    .filter(tag => /\btype="module"/u.test(tag) && /\bsrc="[^"]+"/u.test(tag));
  if (modules.length !== 1) throw new Error("Expected a single ordinary author module entry");
  const source = /\bsrc="([^"]+)"/u.exec(modules[0])?.[1];
  if (!source) throw new Error("Ordinary author module has no source");
  const original = new URL(source, origin);
  if (original.origin !== origin || !original.pathname.startsWith(`/${shell}/assets/`)) {
    throw new Error("Unexpected ordinary author module source");
  }
  const prepared = new URL(preparedEntry);
  if (prepared.origin !== origin || !prepared.pathname.startsWith(`/${shell}/assets/prepared-author-`)) {
    throw new Error("Unexpected prepared author module source");
  }
  return html.replace(modules[0], modules[0].replace(/\bsrc="[^"]+"/u, `src="${prepared.pathname}"`));
}

/** Restore a real test-scoped bearer only on an explicitly selected document. */
async function openPreparedAuthor(
  page: Page, origin: string, shell: "desktop" | "mobile", destination: URL,
  entry: string, token: string, handoffs: WeakMap<Page, Handoff>,
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
      if (!claim || caller !== page || frame !== page.mainFrame() || frame.url() !== claim.destination) {
        throw new Error("Prepared author token claim was not bound to this document");
      }
      delete installed.pending;
      return claim.token;
    });
    handoffs.set(page, installed);
    handoff = installed;
  }
  const match = (url: URL) => url.href === destination.href;
  let replaced = false;
  let oauthRequests = 0;
  const routeDocument = async (route: Route) => {
    if (!route.request().isNavigationRequest() || route.request().frame() !== page.mainFrame() || replaced) {
      return route.fallback();
    }
    const response = await route.fetch({ maxRedirects: 0 });
    if (response.status() !== 200) throw new Error("Prepared author document was not served successfully");
    const body = replaceEntry(await response.text(), origin, shell, entry);
    const headers = response.headers();
    delete headers["content-length"];
    delete headers["content-encoding"];
    replaced = true;
    await route.fulfill({ response, headers, body });
  };
  const observe = (request: Request) => {
    const url = new URL(request.url());
    if (url.origin === origin && (/^\/oauth\/(?:login|consent)(?:\/|$)/u.test(url.pathname) ||
      /^\/api\/auth\/(?:oauth2\/(?:authorize|token|consent)|sign-in\/social)(?:\/|$)/u.test(url.pathname))) oauthRequests++;
  };
  handoff.pending = { destination: destination.href, token };
  page.on("request", observe);
  await page.route(match, routeDocument);
  try {
    await Promise.all([
      page.waitForResponse(response => response.url() === `${origin}/api/session` && response.ok()),
      page.goto(destination.href),
    ]);
    await expect(expectedView).toBeVisible();
    expect(replaced, "fixture entry must replace exactly the selected document entry").toBe(true);
    expect(handoff.pending === undefined, "prepared token must be claimed once").toBe(true);
    expect(oauthRequests, "non-authentication setup must not execute browser OAuth").toBe(0);
  } finally {
    delete handoff.pending;
    page.off("request", observe);
    await page.unroute(match, routeDocument);
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
        const entry = authorServer.preparedEntryUrl(shell);
        // Cross-version frontend proof and explicit reauthentication keep the ordinary path.
        if (navigation.continueCurrentPage || process.env.CODEXIA_E2E_COMPAT_FRONTEND_SOURCE) return authorizeAuthor(shell, targetPage, navigation);
        if (!entry) throw new Error("Prepared author entry missing for explicitly opted-in test");
        if (navigation.apiSetupOnly) {
          if (navigation.path || navigation.expectedView) throw new Error("API-only setup cannot request browser navigation");
          return createAuthorSession(request, authorServer.apiOrigin, await realToken());
        }
        const accessToken = await realToken();
        const started = performance.now();
        await authorTest.step("CI phase: prepared-browser-runtime", () => openPreparedAuthor(
          targetPage, authorServer.apiOrigin, shell, new URL(navigation.path ?? `/${shell}/`, authorServer.apiOrigin),
          entry, accessToken, handoffs, navigation.expectedView,
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
