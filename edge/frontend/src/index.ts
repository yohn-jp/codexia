export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

export type Destination =
  | { kind: "index"; assetPath: string; reader: boolean }
  | { kind: "asset" }
  | { kind: "not-found" };

const PUBLIC_READER_MODULES = new Set([
  "story", "diagnostics", "nlp", "semantic", "speaker", "assistant", "publishing", "mcp",
]);
const CONTENT_ASSET = /\.(?:js|css|svg|png|jpe?g|webp|avif|gif|woff2?|ttf|otf|ico)$/u;

function safePath(pathname: string, rawPath: string): boolean {
  if (pathname !== rawPath || pathname.includes("\\") || pathname.includes("//")) return false;
  for (const segment of pathname.split("/")) {
    let decoded: string;
    try { decoded = decodeURIComponent(segment); }
    catch { return false; }
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\") || /[\u0000-\u001f\u007f]/u.test(decoded)) {
      return false;
    }
  }
  return true;
}

function desktopOrMobileEntry(pathname: string): string | undefined {
  const match = /^\/(desktop|mobile)(?:\/(.*))?$/u.exec(pathname);
  if (!match) return undefined;
  const ui = match[1];
  const uiPath = match[2] ?? "";
  const knownEntry = /^(?:(?:|library|writing|reading|inspection|review|tools|settings)\/?|projects\/[^/\\]+(?:\/scenes\/[^/\\]+)?\/?)$/u.test(uiPath);
  return knownEntry ? `/${ui}/index.html` : undefined;
}

function publicReaderPath(pathname: string): boolean {
  const parts = pathname.split("/");
  return parts.length === 5 && parts[0] === "" && parts[1] === "r" &&
    PUBLIC_READER_MODULES.has(parts[2] ?? "") && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(parts[3] ?? "") &&
    /^[A-Za-z0-9._~-]{1,128}$/u.test(parts[4] ?? "");
}

export function classify(request: Request): Destination {
  const url = new URL(request.url);
  const rawPath = request.url.match(/^https:\/\/[^/?#]+([^?#]*)/u)?.[1] || "/";
  if (url.protocol !== "https:" || (url.port !== "" && url.port !== "443") ||
      !["GET", "HEAD"].includes(request.method) || !safePath(url.pathname, rawPath)) {
    return { kind: "not-found" };
  }

  const pathname = url.pathname;
  if (pathname === "/" || pathname === "/index.html") {
    return { kind: "index", assetPath: "/index.html", reader: false };
  }
  const uiEntry = desktopOrMobileEntry(pathname);
  if (uiEntry) return { kind: "index", assetPath: uiEntry, reader: false };
  if (publicReaderPath(pathname)) return { kind: "index", assetPath: "/index.html", reader: true };

  if (/^\/(?:assets|desktop\/assets|mobile\/assets)\/[A-Za-z0-9._-]{1,180}$/u.test(pathname) && CONTENT_ASSET.test(pathname)) {
    return { kind: "asset" };
  }
  return { kind: "not-found" };
}

function notFound(method: string): Response {
  return new Response(method === "HEAD" ? null : "Not Found\n", {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "X-Frame-Options": "DENY",
    },
  });
}

function styleNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function serveHtml(request: Request, env: Env, assetPath: string, reader: boolean): Promise<Response> {
  const assetUrl = new URL(request.url);
  assetUrl.pathname = assetPath;
  const assetResponse = await env.ASSETS.fetch(new Request(assetUrl, request));
  if (!assetResponse.ok) return notFound(request.method);

  const nonce = styleNonce();
  const headers = new Headers(assetResponse.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", reader ? "no-referrer" : "same-origin");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Content-Security-Policy", `default-src 'self'; style-src 'self' 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
  headers.set("Cache-Control", "no-store");
  headers.delete("Content-Length");
  headers.delete("ETag");
  headers.delete("Content-Encoding");
  headers.delete("CDN-Cache-Control");
  headers.delete("Cloudflare-CDN-Cache-Control");
  if (reader) headers.set("X-Robots-Tag", "noindex, nofollow");
  const html = (await assetResponse.text()).replaceAll("__CODEXIA_STYLE_NONCE__", nonce);
  return new Response(request.method === "HEAD" ? null : html, {
    status: assetResponse.status,
    statusText: assetResponse.statusText,
    headers,
  });
}

export async function dispatch(request: Request, env: Env): Promise<Response> {
  const destination = classify(request);
  if (destination.kind === "not-found") return notFound(request.method);
  if (destination.kind === "asset") return env.ASSETS.fetch(request);
  return serveHtml(request, env, destination.assetPath, destination.reader);
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return dispatch(request, env);
  },
};
