import type { JWTPayload } from "jose";
import type { Pool } from "pg";

const REVOCATION_TABLE = "codexia_auth.oauth_jwt_access_token_revocation";
const MAX_REVOCATION_FORM_BYTES = 32 * 1024;

export interface VerifiedJwtAccessToken extends JWTPayload {
  readonly iss: string;
  readonly sub: string;
  readonly exp: number;
  readonly iat: number;
  readonly jti: string;
  readonly client_id: string;
  readonly sid?: string;
  readonly typ?: string;
}

export interface JwtAccessTokenRevocationOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly pool: Pool;
  readonly verifyToken: (token: string) => Promise<VerifiedJwtAccessToken>;
}

interface RevocationForm {
  readonly token: string;
  readonly tokenTypeHint?: string;
  readonly clientId: string;
}

function decodeBasicClientId(value: string): string | undefined {
  if (!/^Basic\s+/iu.test(value)) return undefined;
  try {
    const decoded = Buffer.from(value.replace(/^Basic\s+/iu, ""), "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    if (colon <= 0) return undefined;
    return decodeURIComponent(decoded.slice(0, colon));
  } catch {
    return undefined;
  }
}

async function readRevocationForm(request: Request): Promise<RevocationForm | undefined> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/x-www-form-urlencoded")) return undefined;
  const contentLength = request.headers.get("content-length");
  if (contentLength && /^\d+$/u.test(contentLength) && Number(contentLength) > MAX_REVOCATION_FORM_BYTES) return undefined;
  const reader = request.clone().body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_REVOCATION_FORM_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const form = new URLSearchParams(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size).toString("utf8"));
  const tokens = form.getAll("token");
  const clientIds = form.getAll("client_id");
  const hints = form.getAll("token_type_hint");
  if (tokens.length !== 1 || !tokens[0] || clientIds.length > 1 || hints.length > 1) return undefined;

  const basicClientId = decodeBasicClientId(request.headers.get("authorization") ?? "");
  const formClientId = clientIds[0];
  if (basicClientId && formClientId && basicClientId !== formClientId) return undefined;
  const clientId = basicClientId ?? formClientId;
  if (!clientId) return undefined;
  return { token: tokens[0], ...(hints[0] ? { tokenTypeHint: hints[0] } : {}), clientId };
}

function readOAuthError(response: Response): Promise<{ readonly error?: string } | undefined> {
  if (response.status < 400) return Promise.resolve(undefined);
  return response.clone().json().then((body: unknown) => {
    if (typeof body !== "object" || body === null || !("error" in body) || typeof body.error !== "string") return undefined;
    return { error: body.error };
  }).catch(() => undefined);
}

function rfc7009Success(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-type");
  headers.delete("content-length");
  headers.set("cache-control", "no-store");
  headers.set("pragma", "no-cache");
  return new Response(null, { status: 200, headers });
}

function inactiveIntrospectionResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  headers.set("cache-control", "no-store");
  headers.set("pragma", "no-cache");
  return new Response(JSON.stringify({ active: false }), { status: response.status, headers });
}

export async function migrateJwtAccessTokenRevocationSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${REVOCATION_TABLE} (
      issuer text NOT NULL CHECK (issuer <> ''),
      jti text NOT NULL CHECK (jti <> ''),
      client_id text NOT NULL CHECK (client_id <> ''),
      subject text NOT NULL CHECK (subject <> ''),
      session_id text,
      issued_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (issuer, jti),
      CHECK (expires_at > issued_at)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS oauth_jwt_access_token_revocation_expiry_idx ON ${REVOCATION_TABLE} (expires_at)`);
}

export function createJwtAccessTokenRevocationAdapter(options: JwtAccessTokenRevocationOptions) {
  const isRevoked = async (issuer: string, jti: string): Promise<boolean> => {
    const result = await options.pool.query(
      `SELECT 1 FROM ${REVOCATION_TABLE} WHERE issuer = $1 AND jti = $2 AND expires_at > CURRENT_TIMESTAMP LIMIT 1`,
      [issuer, jti],
    );
    return result.rowCount === 1;
  };

  return {
    isRevoked,
    async handle(request: Request, handler: (request: Request) => Promise<Response>): Promise<Response> {
      const url = new URL(request.url);
      const issuerPath = new URL(options.issuer).pathname.replace(/\/$/u, "");
      const revokeRequest = request.method === "POST" && url.pathname === `${issuerPath}/oauth2/revoke`;
      const introspectionRequest = request.method === "POST" && url.pathname === `${issuerPath}/oauth2/introspect`;
      if (!revokeRequest && !introspectionRequest) return handler(request);

      const form = revokeRequest ? await readRevocationForm(request) : undefined;
      const response = await handler(request.clone());
      if (introspectionRequest && response.ok) {
        const payload = await response.clone().json().catch(() => undefined) as {
          active?: unknown;
          iss?: unknown;
          jti?: unknown;
        } | undefined;
        if (payload?.active === true && typeof payload.iss === "string" && typeof payload.jti === "string" &&
            await isRevoked(payload.iss, payload.jti)) {
          return inactiveIntrospectionResponse(response);
        }
        return response;
      }
      if (!form) return response;

      const oauthError = await readOAuthError(response);
      if (oauthError?.error === "unsupported_token_type") {
        try {
          const token = await options.verifyToken(form.token);
          if (token.typ === "at+jwt" && token.iss === options.issuer && token.aud !== undefined &&
              (Array.isArray(token.aud) ? token.aud.includes(options.audience) : token.aud === options.audience) &&
              token.client_id === form.clientId && token.jti && token.sub &&
              Number.isSafeInteger(token.iat) && Number.isSafeInteger(token.exp) && token.exp > token.iat) {
            await options.pool.query(`DELETE FROM ${REVOCATION_TABLE} WHERE expires_at <= CURRENT_TIMESTAMP`);
            await options.pool.query(
              `INSERT INTO ${REVOCATION_TABLE} (issuer, jti, client_id, subject, session_id, issued_at, expires_at)
               VALUES ($1, $2, $3, $4, $5, to_timestamp($6), to_timestamp($7))
               ON CONFLICT (issuer, jti) DO NOTHING`,
              [token.iss, token.jti, token.client_id, token.sub, typeof token.sid === "string" ? token.sid : null, token.iat, token.exp],
            );
          }
          return rfc7009Success(response);
        } catch {
          // Better Auth has already established that the token is a JWT. Keep its
          // explicit failure if verification or durable recording is unavailable.
          return response;
        }
      }

      if (oauthError?.error === "invalid_request" || oauthError?.error === "invalid_token") {
        return rfc7009Success(response);
      }
      return response;
    },
  };
}
