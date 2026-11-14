import { createPublicKey, verify, type KeyObject } from "node:crypto";

export interface CloudflareAccessOptions {
  issuer: string;
  audience: string;
  origin: string;
  ownerEmail: string;
  fetch?: typeof fetch;
}

const KEY_TTL_MS = 5 * 60_000;
const MIN_REFRESH_MS = 30_000;
const MAX_TOKEN_LENGTH = 16_384;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function decode(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("Invalid JWT encoding");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw new Error("Invalid JWT encoding");
  return bytes;
}

function httpsOrigin(value: string): boolean {
  try { const url = new URL(value); return url.protocol === "https:" && url.origin === value; }
  catch { return false; }
}

/** The dedicated standalone browser owner is one explicitly configured Access identity.
 * The existing bearer credential is never exchanged for this authority. */
export function createCloudflareAccessVerifier(options: CloudflareAccessOptions) {
  const { issuer, audience, origin, ownerEmail } = options;
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/u.test(issuer) ||
      !/^[a-f0-9]{64}$/u.test(audience) || !httpsOrigin(origin) ||
      !/^[^\s@]+@[^\s@]+$/u.test(ownerEmail) || ownerEmail !== ownerEmail.trim()) {
    throw new Error("Cloudflare Access requires a team issuer, application audience, HTTPS origin and one owner email");
  }
  const fetcher = options.fetch ?? fetch;
  let keys = new Map<string, KeyObject>();
  let expiresAt = 0;
  let lastAttempt = -Infinity;
  let pending: Promise<void> | undefined;

  async function refresh(now: number): Promise<void> {
    if (pending) return pending;
    if (now - lastAttempt < MIN_REFRESH_MS) return;
    lastAttempt = now;
    pending = (async () => {
      const response = await fetcher(issuer + "/cdn-cgi/access/certs", {
        redirect: "error", signal: AbortSignal.timeout(5000), headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error("Access signing keys unavailable");
      const body = record(await response.json());
      if (!Array.isArray(body?.keys) || body.keys.length > 32) throw new Error("Invalid Access signing keys");
      const next = new Map<string, KeyObject>();
      for (const candidate of body.keys as unknown[]) {
        const jwk = record(candidate);
        if (!jwk || jwk.kty !== "RSA" || typeof jwk.kid !== "string" || !jwk.kid ||
            (jwk.alg !== undefined && jwk.alg !== "RS256") || (jwk.use !== undefined && jwk.use !== "sig") ||
            typeof jwk.n !== "string" || typeof jwk.e !== "string") continue;
        if (next.has(jwk.kid)) throw new Error("Ambiguous Access signing key");
        const key = createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" });
        if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) continue;
        next.set(jwk.kid, key);
      }
      if (!next.size) throw new Error("No usable Access signing keys");
      keys = next;
      expiresAt = Date.now() + KEY_TTL_MS;
    })().finally(() => { pending = undefined; });
    return pending;
  }

  return {
    origin,
    async authenticate(token: string): Promise<number> {
      if (token.length > MAX_TOKEN_LENGTH) throw new Error("Invalid Access assertion");
      const parts = token.split(".");
      if (parts.length !== 3 || parts.some(part => !part)) throw new Error("Invalid Access assertion");
      const [head, body, signature] = parts as [string, string, string];
      const header = record(JSON.parse(decode(head).toString("utf8")));
      const claims = record(JSON.parse(decode(body).toString("utf8")));
      const now = Date.now();
      const nowSeconds = Math.floor(now / 1000);
      if (!header || header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid ||
          (header.typ !== undefined && header.typ !== "JWT") || header.crit !== undefined ||
          !claims || claims.iss !== issuer || claims.type !== "app" ||
          !Array.isArray(claims.aud) || !claims.aud.every(v => typeof v === "string") || !claims.aud.includes(audience) ||
          typeof claims.sub !== "string" || !claims.sub ||
          typeof claims.email !== "string" || claims.email.toLowerCase() !== ownerEmail.toLowerCase() ||
          claims.common_name !== undefined ||
          typeof claims.exp !== "number" || !Number.isSafeInteger(claims.exp) || claims.exp <= nowSeconds ||
          typeof claims.iat !== "number" || !Number.isSafeInteger(claims.iat) || claims.iat > nowSeconds ||
          typeof claims.nbf !== "number" || !Number.isSafeInteger(claims.nbf) || claims.nbf > nowSeconds) {
        throw new Error("Invalid Access identity");
      }
      if (expiresAt <= now || !keys.has(header.kid)) await refresh(now);
      const key = expiresAt > Date.now() ? keys.get(header.kid) : undefined;
      if (!key || !verify("RSA-SHA256", Buffer.from(head + "." + body, "ascii"), key, decode(signature)) ||
          claims.exp * 1000 <= Date.now()) throw new Error("Invalid Access signature or expired assertion");
      return claims.exp * 1000;
    },
  };
}
