import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

type OAuthBuildIdentity = {
  apiOrigin: string;
  issuer: string;
  webClientId: string;
  audience: string;
};

const root = fileURLToPath(new URL("../../", import.meta.url));
export const TEMPLATE_ORIGIN = "http://127.0.0.1:41999";
export const TEMPLATE_CLIENT_ID = "codexia-e2e-template-client-not-a-secret";
const manifestName = ".codexia-oauth-asset-template.json";
const schema = "codexia-e2e-oauth-assets/v1";

export function authorBrowserBuildEnvironment(identity: OAuthBuildIdentity, profile: string, assets: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CODEXIA_PROFILE: profile,
    CODEXIA_VITE_BUILD_OUTPUT_ROOT: assets,
    VITE_CODEXIA_API_ORIGIN: identity.apiOrigin,
    VITE_CODEXIA_OAUTH_ISSUER: identity.issuer,
    VITE_CODEXIA_OAUTH_CLIENT_ID: identity.webClientId,
    VITE_CODEXIA_API_AUDIENCE: identity.audience,
    VITE_CODEXIA_OAUTH_DESKTOP_REDIRECT_URI: identity.apiOrigin + "/desktop",
    VITE_CODEXIA_OAUTH_MOBILE_REDIRECT_URI: identity.apiOrigin + "/mobile",
    VITE_CODEXIA_OAUTH_SCOPES: "openid codexia:api",
  };
}

/** CI-only: compile the exact profile once per browser job, before parallel shards start. */
export function prepareAuthorBrowserAssetTemplate(profile: string, directory: string): void {
  if (process.env.CI !== "true" || !process.env.CODEXIA_EXPECTED_SHA || !isAbsolute(directory)) {
    throw new Error("OAuth browser template preparation requires CI, an exact source SHA and an absolute destination");
  }
  if (existsSync(directory)) throw new Error("OAuth browser template already exists; never reuse unverified build output");
  const started = performance.now();
  const identity: OAuthBuildIdentity = {
    apiOrigin: TEMPLATE_ORIGIN,
    issuer: TEMPLATE_ORIGIN + "/api/auth",
    webClientId: TEMPLATE_CLIENT_ID,
    audience: TEMPLATE_ORIGIN + "/api",
  };
  const build = spawnSync(process.execPath, [join(root, "app/scripts/build-views.mjs")], {
    cwd: root,
    stdio: "inherit",
    env: authorBrowserBuildEnvironment(identity, profile, directory),
  });
  if (build.error) throw build.error;
  if (build.status !== 0) throw new Error("OAuth browser template build failed with status " + build.status);
  for (const relative of ["index.html", "desktop/index.html", "mobile/index.html", "oauth/oauth-login.html", "oauth/oauth-consent.html"]) {
    if (!existsSync(join(directory, relative))) throw new Error("OAuth browser template is missing " + relative);
  }
  writeFileSync(join(directory, manifestName), JSON.stringify({
    schema, profile, sourceSha: process.env.CODEXIA_EXPECTED_SHA,
  }) + "\n");
  console.log(JSON.stringify({ phase: "oauth-assets-template", profile, seconds: (performance.now() - started) / 1000 }));
}

/** Give each isolated OAuth server a private copy with its own public origin and client ID. */
export function materializeAuthorBrowserAssets(
  directory: string,
  assets: string,
  profile: string,
  identity: OAuthBuildIdentity,
): void {
  if (process.env.CI !== "true" || !process.env.CODEXIA_EXPECTED_SHA || !isAbsolute(directory)) {
    throw new Error("OAuth browser template use requires CI, an exact source SHA and an absolute template path");
  }
  const manifest = JSON.parse(readFileSync(join(directory, manifestName), "utf8")) as {
    schema?: string;
    profile?: string;
    sourceSha?: string;
  };
  if (manifest.schema !== schema || manifest.profile !== profile || manifest.sourceSha !== process.env.CODEXIA_EXPECTED_SHA) {
    throw new Error("OAuth browser template does not match the exact source and profile");
  }
  if (existsSync(assets)) throw new Error("OAuth server asset directory must be private and initially absent");
  const started = performance.now();
  cpSync(directory, assets, { recursive: true, filter: (source) => !source.endsWith(manifestName) });
  let origins = 0;
  let clients = 0;
  const visit = (directoryPath: string): void => {
    for (const name of readdirSync(directoryPath)) {
      const file = join(directoryPath, name);
      if (statSync(file).isDirectory()) {
        visit(file);
        continue;
      }
      if (!/\.(?:js|mjs|html|css|json)$/u.test(name)) continue;
      const before = readFileSync(file, "utf8");
      const originCount = before.split(TEMPLATE_ORIGIN).length - 1;
      const clientCount = before.split(TEMPLATE_CLIENT_ID).length - 1;
      if (!originCount && !clientCount) continue;
      origins += originCount;
      clients += clientCount;
      writeFileSync(file, before.replaceAll(TEMPLATE_ORIGIN, identity.apiOrigin).replaceAll(TEMPLATE_CLIENT_ID, identity.webClientId));
    }
  };
  visit(assets);
  if (!origins || !clients) {
    throw new Error("OAuth browser template does not contain the expected public configuration markers");
  }
  console.log(JSON.stringify({
    phase: "oauth-assets-materialized", profile, seconds: (performance.now() - started) / 1000,
    originReplacements: origins, clientReplacements: clients,
  }));
}
