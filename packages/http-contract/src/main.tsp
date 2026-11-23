import "@typespec/http";
import "@typespec/openapi";
import "./models.tsp";
import "./routes-core.tsp";
import "./routes-persistence.tsp";
import "./routes-auth.tsp";
import "./routes-backup-console.tsp";

using TypeSpec.Http;
using TypeSpec.OpenAPI;

@service(#{ title: "Codexia API" })
@summary("HTTP wire operations for Codexia. Authorization and product semantics remain owned by the accepted design contracts.")
@info(#{ version: "2.0.0" })
@server("https://api.codexia.example", "Codexia API")
@extension("x-codexia-contract-status", "incomplete")
@extension("x-codexia-api-epoch", 2)
@extension("x-codexia-cors", #{
  originPolicy: "same-origin or exact configured HTTPS origin; wildcard origins are forbidden",
  credentials: false,
  vary: #["Origin", "Access-Control-Request-Method", "Access-Control-Request-Headers"],
  methods: #["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
  requestHeaders: #["Authorization", "Content-Type", "Idempotency-Key", "X-Client-Id", "X-Codexia-Recent-Activity-Order", "Prefer"],
  mcpRequestHeaders: #["Mcp-Session-Id", "MCP-Protocol-Version", "Last-Event-ID"],
  mcpExposeHeaders: #["Mcp-Session-Id", "WWW-Authenticate"],
  preflight: #{
    route: "generic OPTIONS catch-all at / and /*; not a per-resource operation",
    successStatus: 204,
    deniedStatus: 403,
    allowMethods: #["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
  }
})
@extension("x-codexia-external-contracts", #{
  betterAuth: #{
    source: "Better Auth official runtime OpenAPI generation",
    pathPrefix: "/api/auth/",
    libraryOperationsIncludedHere: false,
    applicationAdaptersHere: #[
      "POST /api/auth/oauth2/consent-context",
      "GET /api/auth/oauth2/get-consents",
      "GET /api/auth/codexia/setup/status",
      "POST /api/auth/codexia/setup/authorize",
      "POST /api/auth/codexia/setup/profile",
      "POST /api/auth/codexia/setup/complete"
    ]
  },
  betterAuthMetadataPaths: #["/.well-known/oauth-authorization-server/api/auth", "/.well-known/openid-configuration/api/auth"],
  reason: "Library-managed authentication operations and discovery metadata come from the official Better Auth generator; only Codexia-owned adapters are defined here."
})
@useAuth(BearerAuth)
namespace Codexia.Http;
