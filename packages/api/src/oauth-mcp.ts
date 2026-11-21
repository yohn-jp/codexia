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
  /** Explicit project-level resource assignment for each allowed MCP client. */
  readonly projectIdsByClient: Readonly<Record<string, readonly string[]>>;
  /** Only the configured internal identity may access the singleton owner's resources through MCP. */
  readonly ownerSubject: string;
}

export interface OAuthMcpPrincipal {
  readonly kind: "external-mcp";
  readonly issuer: string;
  readonly userId: string;
  readonly clientId: string;
  /** Project IDs assigned to this registered client; never inferred from subject or token claims. */
  readonly projectIds: readonly string[];
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

/** Parse the startup-only MCP client → project allowlist without accepting
 * duplicate keys, missing clients, empty assignments, or unconfigured clients.
 */
export function parseOAuthMcpProjectAssignments(
  value: string | undefined,
  clientIds: readonly string[],
): Readonly<Record<string, readonly string[]>> {
  const clients = configuredClientIds(clientIds, "OAuth MCP client IDs");
  if (value === undefined || value.trim() === "") {
    if (clients.size) throw new Error("CODEXIA_OAUTH_MCP_PROJECT_ASSIGNMENTS is required when MCP clients are configured");
    return {};
  }
  const keyTokens = [...value.matchAll(/("(?:\\.|[^"\\])*")\s*:/gu)].map((match) => {
    try { return JSON.parse(match[1]!) as string; }
    catch { throw new Error("CODEXIA_OAUTH_MCP_PROJECT_ASSIGNMENTS must be valid JSON"); }
  });
  if (new Set(keyTokens).size !== keyTokens.length) {
    throw new Error("CODEXIA_OAUTH_MCP_PROJECT_ASSIGNMENTS must not contain duplicate client mappings");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error("CODEXIA_OAUTH_MCP_PROJECT_ASSIGNMENTS must be valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("CODEXIA_OAUTH_MCP_PROJECT_ASSIGNMENTS must be a JSON object");
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length !== clients.size || entries.some(([clientId]) => !clients.has(clientId))) {
    throw new Error("CODEXIA_OAUTH_MCP_PROJECT_ASSIGNMENTS must assign every configured MCP client and no other client");
  }
  const assignments: Record<string, readonly string[]> = {};
  for (const [clientId, projectIds] of entries) {
    if (!Array.isArray(projectIds) || projectIds.length === 0 ||
        projectIds.some((projectId) => typeof projectId !== "string" || !projectId.trim() || projectId !== projectId.trim()) ||
        new Set(projectIds).size !== projectIds.length) {
      throw new Error("Each OAuth MCP client assignment must contain unique non-empty project IDs");
    }
    Object.defineProperty(assignments, clientId, { value: [...projectIds] as string[], enumerable: true });
  }
  return assignments;
}

export function createOAuthMcpAuthenticator(options: OAuthMcpOptions): (token: string) => Promise<OAuthMcpPrincipal> {
  const allowedClientIds = configuredClientIds(options.allowedClientIds, "OAuth MCP client IDs");
  const ownerClientIds = configuredClientIds(options.ownerClientIds ?? [], "OAuth owner client IDs");
  if (!options.projectIdsByClient || typeof options.projectIdsByClient !== "object" || Array.isArray(options.projectIdsByClient)) {
    throw new Error("OAuth MCP client project assignments must be an object");
  }
  const assignments = new Map<string, readonly string[]>();
  for (const [clientId, projectIds] of Object.entries(options.projectIdsByClient)) {
    if (!allowedClientIds.has(clientId) || !Array.isArray(projectIds) || projectIds.length === 0 ||
        projectIds.some((projectId) => typeof projectId !== "string" || !projectId.trim() || projectId !== projectId.trim()) ||
        new Set(projectIds).size !== projectIds.length) {
      throw new Error("OAuth MCP project assignments must map each configured MCP client to unique non-empty project IDs");
    }
    assignments.set(clientId, [...projectIds]);
  }
  if ([...allowedClientIds].some((clientId) => !assignments.has(clientId)) || assignments.size !== allowedClientIds.size) {
    throw new Error("Every allowed OAuth MCP client must have an explicit project assignment");
  }
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
        projectIds: assignments.get(claims.clientId)!,
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
