import type { AsyncLocalStorage } from "node:async_hooks";
import { CODEXIA_OWNER_SCOPE, CODEXIA_IOS_REDIRECT_URI, type createBetterAuthRuntime } from "./better-auth.js";

interface RegisteredClient {
  readonly userId: string;
  readonly redirectUris: readonly string[];
  readonly name: string;
  readonly scopes: readonly string[];
  readonly skipConsent: boolean;
  readonly responseTypes: readonly string[];
  readonly disabled: boolean;
  readonly requirePKCE: boolean;
  readonly grantTypes: readonly string[];
  readonly tokenEndpointAuthMethod: string;
  readonly applicationType: string;
}

function sameValues(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && expected.every((value) => actual.includes(value));
}

export async function provisionSetupOAuthClients(
  runtime: ReturnType<typeof createBetterAuthRuntime>,
  registrationId: AsyncLocalStorage<string>,
  headers: Headers,
  ownerSubject: string,
  clientIds: { readonly web: string; readonly ios: string; readonly introspection: string },
  webRedirectUris: readonly string[],
  disposableLoopback: boolean,
  verifyOnly = false,
): Promise<void> {
  const { web: webClientId, ios: iosClientId, introspection: introspectionClientId } = clientIds;
  const context = await runtime.auth.$context;
  const audience = new URL(runtime.audience);
  const ownerScopes = ["openid", CODEXIA_OWNER_SCOPE, "offline_access"];
  async function ensureClient(id: string, name: string, redirectUris: readonly string[], applicationType: "web" | "native", confidential = false) {
    const scopes = confidential ? ["openid"] : ownerScopes;
    const grantTypes = confidential ? ["authorization_code"] as const : ["authorization_code", "refresh_token"] as const;
    const tokenEndpointAuthMethod = confidential ? "client_secret_post" : "none";
    const current = await context.adapter.findOne<RegisteredClient>({
      model: "oauthClient", where: [{ field: "clientId", value: id }],
    });
    if (current) {
      if (current.userId !== ownerSubject || current.name !== name ||
          !sameValues(current.redirectUris, redirectUris) || !sameValues(current.scopes, scopes) ||
          !sameValues(current.grantTypes, grantTypes) || !sameValues(current.responseTypes, ["code"]) ||
          current.disabled !== false || !current.requirePKCE || current.skipConsent !== confidential ||
          current.tokenEndpointAuthMethod !== tokenEndpointAuthMethod || current.applicationType !== applicationType) {
        throw new Error("An existing client differs from the approved registration");
      }
      return;
    }
    if (verifyOnly) throw new Error("A reviewed client has not been registered");
    await registrationId.run(id, () => runtime.auth.api.adminCreateOAuthClient({
      headers,
      body: {
        client_name: name, redirect_uris: [...redirectUris], application_type: applicationType,
        scope: scopes.join(" "), resources: [audience.href], token_endpoint_auth_method: tokenEndpointAuthMethod,
        grant_types: [...grantTypes], response_types: ["code"], require_pkce: true, skip_consent: confidential,
      },
    }));
  }

  // The existing disposable HTTP loopback fixture uses the provider's native loopback allowance.
  const webType = disposableLoopback ? "native" : "web";
  await ensureClient(webClientId, "Codexia Web", webRedirectUris, webType);
  await ensureClient(iosClientId, "Codexia iOS", [CODEXIA_IOS_REDIRECT_URI], "native");
  await ensureClient(introspectionClientId, "Codexia API introspection", [audience.origin + "/oauth/introspection"], webType, true);
  await runtime.assertRegisteredClients(ownerSubject);
  // Verify the stored secret through Better Auth's own authenticated client boundary.
  await runtime.verifyIntrospectionCredentials();
}
