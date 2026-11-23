import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page } from "@playwright/test";
import { startBetterAuthFixture, type BetterAuthFixture } from "../../packages/api/test/fixtures/better-auth-server.js";
import { browserServerProfile } from "./browser-server-profile";
import { authorBrowserBuildEnvironment, materializeAuthorBrowserAssets } from "./oauth-asset-template";

export type Shell = "desktop" | "mobile";
export interface AuthorNavigation { path?: string; expectedView?: Locator; continueCurrentPage?: boolean }

const root = fileURLToPath(new URL("../../", import.meta.url));

export function buildAuthorBrowserAssets(
  server: Pick<BetterAuthFixture, "apiOrigin" | "issuer" | "webClientId" | "audience">,
  profile: string,
  assets: string,
  frontendSource?: string,
): void {
  const template = process.env.CODEXIA_E2E_AUTH_ASSET_TEMPLATE;
  if (template && !frontendSource) {
    materializeAuthorBrowserAssets(template, assets, profile, server);
    return;
  }
  const command = frontendSource ? "pnpm" : process.execPath;
  const args = frontendSource ? ["build:frontend"] : ["app/scripts/build-views.mjs"];
  const build = spawnSync(command, args, {
    cwd: frontendSource ?? root,
    encoding: "utf8",
    env: authorBrowserBuildEnvironment(server, profile, assets),
  });
  if (build.error) throw build.error;
  if (build.status !== 0) throw new Error(`Author browser fixture build failed:\n${build.stdout}\n${build.stderr}`);
}

export async function startAuthorBrowserFixture({ databaseUrl, profile, apiPort, frontendSource }: {
  databaseUrl: string;
  profile: string;
  apiPort?: number;
  frontendSource?: string;
}): Promise<BetterAuthFixture> {
  const stateDirectory = await mkdtemp(join(tmpdir(), "codexia-author-browser-"));
  let server: BetterAuthFixture | undefined;
  const close = async () => {
    try { await server?.close(); }
    finally { await rm(stateDirectory, { recursive: true, force: true }); }
  };
  try {
    const assets = frontendSource ? join(frontendSource, "app/dist") : join(stateDirectory, "assets");
    server = await startBetterAuthFixture({
      databaseUrl,
      staticDirectory: assets,
      ...(apiPort === undefined ? {} : { apiPort }),
      usePostgresPersistence: true,
      appProfile: await browserServerProfile(profile, join(stateDirectory, "module-cache")),
    });
    buildAuthorBrowserAssets(server, profile, assets, frontendSource);
    return { ...server, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function signInAuthorBrowser(page: Page, origin: string, shell: Shell, navigation: AuthorNavigation = {}): Promise<string> {
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
