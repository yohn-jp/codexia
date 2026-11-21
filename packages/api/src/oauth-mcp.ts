import { OAuthAuthenticationError } from "./oauth-owner.js";
import { MCP_OAUTH_SCOPES } from "@codexia/contracts";
import {
  createOAuthAccessTokenVerifier,
  OAuthTokenVerifierError,
  type OAuthAccessTokenVerifierOptions,
} from "./oauth-token.js";

export const OAUTH_MCP_SCOPES = MCP_OAUTH_SCOPES;
export const OAUTH_MCP_SCOPE_BY_EFFECT = {
  read: "mcp:read",
  compute: "mcp:compute",
  propose: "mcp:propose",
} as const;

const MCP_IDENTITY_SCOPES = new Set(["openid", "email", "profile", "offline_access"]);

export interface OAuthMcpOptions extends OAuthAccessTokenVerifierOptions {
  /** Explicit server-side classification of registered MCP public clients. Empty denies all MCP clients. */
  readonly allowedClientIds: readonly string[];
  /** Must remain disjoint from the owner-client allowlist. */
  readonly ownerClientIds?: readonly string[];
  /** Only the configured internal identity may access the singleton owner's resources through MCP. */
  readonly ownerSubject: string;
}

export interface OAuthMcpPrincipal {
  readonly kind: "external-mcp";
  readonly issuer: string;
  readonly userId: string;
  readonly clientId: string;
  /** Only MCP operation scopes; OpenID and refresh scopes are not API capabilities. */
  readonly scopes: readonly (typeof OAUTH_MCP_SCOPES)[number][];
}

function configuredClientIds(values: readonly string[], label: string): Set<string> {
  const result = new Set<string>();
  for (const value of values) {
    if (!value.trim() || value !== value.trim() || result.has(value)) {
      throw new Error(`${label} must contain unique, non-empty client IDs`);
    }
    result.add(value);
  }
  return result;
}

export function createOAuthMcpAuthenticator(options: OAuthMcpOptions): (token: string) => Promise<OAuthMcpPrincipal> {
  const allowedClientIds = configuredClientIds(options.allowedClientIds, "OAuth MCP client IDs");
  const ownerClientIds = configuredClientIds(options.ownerClientIds ?? [], "OAuth owner client IDs");
  if (!options.ownerSubject.trim()) throw new Error("OAuth MCP owner subject must be configured");
  if ([...allowedClientIds].some((clientId) => ownerClientIds.has(clientId))) {
    throw new Error("OAuth owner and MCP client allowlists must be disjoint");
  }
  const verifyToken = createOAuthAccessTokenVerifier(options);
  const validScopes = new Set<string>([...OAUTH_MCP_SCOPES, ...MCP_IDENTITY_SCOPES]);

  return async (token: string): Promise<OAuthMcpPrincipal> => {
    try {
      const claims = await verifyToken(token, (candidate) => {
        if (!allowedClientIds.has(candidate.clientId)) {
          throw new OAuthAuthenticationError(403, "OAUTH_MCP_CLIENT_NOT_ALLOWED", "OAuth client is not registered for MCP access");
        }
        if (candidate.subject !== options.ownerSubject) {
          throw new OAuthAuthenticationError(403, "OAUTH_MCP_SUBJECT_NOT_ALLOWED", "Authenticated identity is not configured for MCP API access");
        }
        if (candidate.scopes.some((scope) => !validScopes.has(scope)) ||
            !OAUTH_MCP_SCOPES.some((scope) => candidate.scopes.includes(scope))) {
          throw new OAuthAuthenticationError(403, "OAUTH_MCP_SCOPE_INVALID", "Access token must grant only explicit MCP operation scopes");
        }
        if (ownerClientIds.has(candidate.clientId)) {
          throw new OAuthAuthenticationError(403, "OAUTH_MCP_CLIENT_NOT_ALLOWED", "Owner OAuth clients cannot be used as MCP clients");
        }
      });
      return {
        kind: "external-mcp",
        issuer: claims.issuer,
        userId: claims.subject,
        clientId: claims.clientId,
        scopes: OAUTH_MCP_SCOPES.filter((scope) => claims.scopes.includes(scope)),
      };
    } catch (error) {
      if (error instanceof OAuthTokenVerifierError) {
        throw new OAuthAuthenticationError(error.status, error.code, error.message);
      }
      throw error;
    }
  };
}
