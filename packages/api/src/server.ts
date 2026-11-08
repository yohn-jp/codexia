import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Fastify from "fastify";
import type { Persistence } from "@codexia/persistence-contracts";
import { createPostgresPersistence, migratePostgresDatabase } from "@codexia/persistence-postgres";
import { handlePersistenceRoute } from "./persistence-routes.js";

const SESSION_COOKIE = "scriptorium_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export interface ApiServerOptions {
  persistence: Persistence;
  authToken: string;
  staticDir?: string;
  trustProxy?: boolean;
}
function equalToken(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function protocol(request: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy && request.headers["x-forwarded-proto"] === "https") return "https:";
  return "encrypted" in request.socket && request.socket.encrypted ? "https:" : "http:";
}
function sameOrigin(request: IncomingMessage, trustProxy: boolean): boolean {
  if (typeof request.headers.origin !== "string" || typeof request.headers.host !== "string") return false;
  try {
    const origin = new URL(request.headers.origin);
    return origin.origin === `${protocol(request, trustProxy)}//${request.headers.host}` && origin.pathname === "/" && !origin.search && !origin.hash;
  } catch { return false; }
}
function sessionCookie(request: IncomingMessage): string | undefined {
  const matches = (request.headers.cookie ?? "").split(";").map(part => part.trim()).filter(part => part.startsWith(`${SESSION_COOKIE}=`));
  return matches.length === 1 ? matches[0]!.slice(SESSION_COOKIE.length + 1) : undefined;
}
export function createServer(options: ApiServerOptions): Server {
  if (options.authToken.length < 32) throw new Error("CODEXIA_AUTH_TOKEN must contain at least 32 characters");
  if (!options.persistence) throw new Error("PostgreSQL persistence is required");
  const sessions = new Map<string, number>();
  const trustProxy = options.trustProxy === true;
  let draining = false;
  const app = Fastify({ logger: false, bodyLimit: 12 * 1024 * 1024, serverFactory: handler => createHttpServer((request, response) => {
    void Promise.resolve(app.ready()).then(() => handler(request, response)).catch(() => { response.statusCode = 503; response.end(); });
  }) });
  app.all("/*", async (request, reply) => {
    const raw = request.raw;
    const path = new URL(request.url, "http://codexia.invalid").pathname;
    const method = request.method;
    const nonce = randomBytes(18).toString("base64");
    reply.headers({
      "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "X-Frame-Options": "DENY",
      "Content-Security-Policy": `default-src 'self'; style-src 'self' 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
      "Cache-Control": "no-store",
    });
    const fail = (status: number, code: string, error: string) => reply.code(status).send({ error, code });
    if (path === "/health/live" || path === "/health/startup" || path === "/api/health") return { ok: true };
    if (path === "/health/ready" || path === "/api/ready") {
      if (draining) return fail(503, "DRAINING", "Server is draining");
      try { await options.persistence.checkHealth?.(); return { ok: true }; }
      catch { return fail(503, "PERSISTENCE_UNAVAILABLE", "PostgreSQL is not ready"); }
    }
    if (draining) return fail(503, "DRAINING", "Server is draining");
    if (path === "/api/login" && method === "POST") {
      if (!sameOrigin(raw, trustProxy)) return fail(403, "FORBIDDEN", "Same-origin login is required");
      const token = (request.body as { token?: unknown } | undefined)?.token;
      if (typeof token !== "string" || !equalToken(token, options.authToken)) return fail(401, "UNAUTHORIZED", "Invalid token");
      for (const [id, expires] of sessions) if (expires <= Date.now()) sessions.delete(id);
      if (sessions.size >= 10_000) return fail(429, "SESSION_LIMIT", "Too many active sessions");
      const id = randomBytes(32).toString("base64url");
      sessions.set(id, Date.now() + SESSION_TTL_MS);
      reply.header("Set-Cookie", `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${protocol(raw, trustProxy) === "https:" ? "; Secure" : ""}`);
      return { authenticated: true };
    }
    if (path.startsWith("/api/")) {
      const id = sessionCookie(raw);
      const cookieAuth = Boolean(id && (sessions.get(id) ?? 0) > Date.now());
      const authorization = request.headers.authorization;
      const bearerAuth = typeof authorization === "string" && authorization.startsWith("Bearer ") && equalToken(authorization.slice(7), options.authToken);
      if (!cookieAuth && !bearerAuth) return fail(401, "UNAUTHORIZED", "Authentication required");
      if (!["GET", "HEAD", "OPTIONS"].includes(method) && (!cookieAuth || !sameOrigin(raw, trustProxy))) return fail(403, "FORBIDDEN", "An authenticated same-origin author session is required");
      if (path === "/api/session" && method === "GET") return { authenticated: true, authorScope: "owner", permissions: cookieAuth ? ["read", "write"] : ["read"] };
      if (path === "/api/logout" && method === "POST") {
        if (id) sessions.delete(id);
        reply.header("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${protocol(raw, trustProxy) === "https:" ? "; Secure" : ""}`);
        return { authenticated: false };
      }
      const result = await handlePersistenceRoute({ persistence: options.persistence, method, url: request.url, body: request.body, requestHeaders: request.headers, requireAuthor: async () => {
        if (!cookieAuth) throw new Error("Author session required");
        return "owner";
      } });
      if (result) return reply.code(result.status).send(result.body);
      return fail(404, "NOT_FOUND", "Route not found");
    }
    if (!["GET", "HEAD"].includes(method)) return fail(404, "NOT_FOUND", "Route not found");
    const shell = path === "/" || path === "/index.html" ? "index.html"
      : /^\/(desktop|mobile)(?:\/.*)?$/u.test(path) && !path.includes("/assets/") ? `${path.split("/")[1]}/index.html` : undefined;
    const asset = /^\/(?:assets|desktop\/assets|mobile\/assets)\/[A-Za-z0-9._-]+\.(?:js|css|svg|png|woff2?|ttf|ico)$/u.test(path) ? path.slice(1) : undefined;
    if (!shell && !asset) return fail(404, "NOT_FOUND", "Route not found");
    if (!options.staticDir) return fail(503, "APP_NOT_BUILT", "Frontend is served separately");
    try {
      const root = await realpath(options.staticDir);
      const file = await realpath(resolve(root, (asset ?? shell)!));
      if (!file.startsWith(root + sep) || !(await stat(file)).isFile()) return fail(404, "NOT_FOUND", "Asset not found");
      const bytes = await readFile(file);
      const mime: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".ico": "image/x-icon" };
      reply.type(mime[extname(file)] ?? "application/octet-stream");
      if (asset) reply.header("Cache-Control", "public, max-age=31536000, immutable");
      return shell ? bytes.toString("utf8").replaceAll("__CODEXIA_STYLE_NONCE__", nonce) : bytes;
    } catch { return fail(shell ? 503 : 404, shell ? "APP_NOT_BUILT" : "NOT_FOUND", "Asset not found"); }
  });
  app.setErrorHandler((error, _request, reply) => {
    const failure = error as { statusCode?: number; message?: string };
    const status = typeof failure.statusCode === "number" && failure.statusCode >= 400 && failure.statusCode < 500 ? failure.statusCode : 500;
    void reply.code(status).send({ error: status === 500 ? "Request failed" : (failure.message ?? "Invalid request"), code: status === 500 ? "INTERNAL_ERROR" : "INVALID_REQUEST" });
  });
  const server = app.server;
  const close = server.close.bind(server);
  server.close = ((callback?: (error?: Error) => void) => { draining = true; return close(callback); }) as Server["close"];
  return server;
}
export async function start(options?: ApiServerOptions): Promise<Server> {
  const url = process.env.CODEXIA_DATABASE_URL;
  if (!options && !url) throw new Error("CODEXIA_DATABASE_URL is required; Git persistence is not supported");
  if (process.env.CODEXIA_HOSTED_MODE === "1") throw new Error("The retired Git Hosted runtime is not supported");
  let owned: Persistence | undefined;
  try {
    if (!options) {
      if (process.env.CODEXIA_DATABASE_MIGRATE_ON_START === "1") await migratePostgresDatabase(url!);
      owned = createPostgresPersistence(url!);
      await owned.checkHealth?.();
      options = { persistence: owned, authToken: process.env.CODEXIA_AUTH_TOKEN ?? "", trustProxy: process.env.CODEXIA_TRUST_PROXY === "1", ...(process.env.CODEXIA_STATIC_DIR ? { staticDir: process.env.CODEXIA_STATIC_DIR } : {}) };
    }
    const server = createServer(options);
    const port = Number(process.env.PORT ?? 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer from 1 to 65535");
    await new Promise<void>((resolveListen, reject) => { server.once("error", reject); server.listen(port, process.env.HOST ?? "127.0.0.1", () => { server.off("error", reject); resolveListen(); }); });
    if (owned) server.once("close", () => { void owned!.close(); });
    const shutdown = () => {
      const timer = setTimeout(() => { server.closeAllConnections(); }, 5000);
      timer.unref();
      server.close(() => { clearTimeout(timer); console.log("Codexia shutdown complete"); });
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    server.once("close", () => { process.off("SIGTERM", shutdown); process.off("SIGINT", shutdown); });
    return server;
  } catch (error) { await owned?.close(); throw error; }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  start().catch(error => { console.error(error instanceof Error ? error.message : "Startup failed"); process.exitCode = 1; });
}
