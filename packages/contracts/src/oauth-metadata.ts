/** OAuth scopes available to the standalone MCP client. These scopes cap MCP
 * operations; object ownership and author approval remain API responsibilities.
 */
export const MCP_OAUTH_SCOPES = ["mcp:read", "mcp:compute", "mcp:propose"] as const;

export interface McpProtectedResourceMetadata {
  resource: string;
  authorization_servers: [string];
  scopes_supported: [...typeof MCP_OAUTH_SCOPES];
  bearer_methods_supported: ["header"];
}

export interface McpProtectedResourceOptions {
  /** Canonical API audience/resource identifier, not a project or session URL. */
  resource: string;
  /** Better Auth OAuth authorization-server issuer. */
  authorizationServer: string;
}

function parseHttpsIdentifier(value: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`${label} must be an absolute HTTPS URL`);
  }
  if (parsed.protocol !== "https:") throw new TypeError(`${label} must use HTTPS`);
  if (parsed.username || parsed.password) throw new TypeError(`${label} must not contain credentials`);
  if (parsed.search) throw new TypeError(`${label} must not contain a query`);
  if (parsed.hash) throw new TypeError(`${label} must not contain a fragment`);
  return parsed;
}

/**
 * Construct the RFC 9728 well-known URL for a path-bearing resource identifier.
 * For example, `https://api.example/api` maps to
 * `https://api.example/.well-known/oauth-protected-resource/api`.
 */
export function protectedResourceMetadataUrl(resource: string): string {
  const parsed = parseHttpsIdentifier(resource, "resource");
  const resourcePath = parsed.pathname.replace(/^\/+|\/+$/gu, "");
  parsed.pathname = `/.well-known/oauth-protected-resource${resourcePath ? `/${resourcePath}` : ""}`;
  return parsed.href;
}

/** Build metadata for the configured API resource and the standalone MCP scope ceiling. */
export function buildMcpProtectedResourceMetadata(options: McpProtectedResourceOptions): McpProtectedResourceMetadata {
  const resource = parseHttpsIdentifier(options.resource, "resource").href;
  const authorizationServer = parseHttpsIdentifier(options.authorizationServer, "authorization server").href;
  return {
    resource,
    authorization_servers: [authorizationServer],
    scopes_supported: [...MCP_OAUTH_SCOPES],
    bearer_methods_supported: ["header"],
  };
}

/** Return a cacheable public metadata document without reflecting request data. */
export function createMcpProtectedResourceMetadataResponse(options: McpProtectedResourceOptions): Response {
  return new Response(JSON.stringify(buildMcpProtectedResourceMetadata(options)), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
