import { registerPlugin } from "@capacitor/core";
import { CALLBACK_URI } from "./constants.mjs";

const NativeAuth = registerPlugin("CodexiaAuth");

export function createNativeAuth(config, { apiRequest = (options) => NativeAuth.apiRequest(options) } = {}) {
  if (!config || config.redirectUri !== CALLBACK_URI) throw new TypeError("Native OAuth configuration is invalid.");
  const apiOrigin = new URL(config.apiOrigin);
  const fetchRequest = createNativeApiTransport(config.apiOrigin, { apiRequest });

  return Object.freeze({
    async signIn() {
      return accessTokenValue(await NativeAuth.signIn(config), "Sign-in");
    },
    async accessTokenFor(requestUrl) {
      validateApiRequestUrl(requestUrl, apiOrigin);
      return accessTokenValue(await NativeAuth.accessToken(config), "API access");
    },
    fetchRequest,
    async signOut() {
      const result = await NativeAuth.signOut(config);
      return { revoked: result?.revoked === true };
    },
  });
}

export function createNativeApiTransport(apiOriginValue, { apiRequest = (options) => NativeAuth.apiRequest(options) } = {}) {
  const apiOrigin = new URL(apiOriginValue);
  if (apiOrigin.protocol !== "https:" || apiOrigin.pathname !== "/" || apiOrigin.search || apiOrigin.hash || apiOrigin.username || apiOrigin.password) {
    throw new TypeError("Native API origin must be an explicit HTTPS origin.");
  }
  return async function fetchRequest(requestUrl, init = {}) {
      const target = validateApiRequestUrl(requestUrl, apiOrigin);
      if (init.credentials !== undefined && init.credentials !== "omit") {
        throw new Error("Native API requests must omit ambient credentials.");
      }
      const headers = new Headers(init.headers);
      if (headers.has("cookie")) throw new Error("Native API requests cannot send cookies.");
      if (headers.get("accept")?.includes("text/event-stream")) {
        const error = new Error("Native streaming is unavailable through the buffered HTTPS transport.");
        error.code = "NATIVE_STREAM_UNAVAILABLE";
        throw error;
      }
      const method = (init.method ?? "GET").toUpperCase();
      const body = init.body;
      if (body !== undefined && typeof body !== "string") {
        throw new TypeError("Native API requests support JSON string bodies only.");
      }
      if (init.signal?.aborted) throw new DOMException("The request was aborted.", "AbortError");
      const result = await apiRequest({
        apiOrigin: apiOrigin.toString(),
        url: target.toString(),
        method,
        headers: Object.fromEntries(headers.entries()),
        ...(body !== undefined ? { body } : {}),
      });
      if (init.signal?.aborted) throw new DOMException("The request was aborted.", "AbortError");
      const status = result.status;
      const noBodyStatus = status === 204 || status === 205 || status === 304;
      const responseBody = noBodyStatus || result.body == null
        ? null
        : result.body;
      return new Response(responseBody, { status, headers: new Headers(result.headers) });
  };
}

function validateApiRequestUrl(requestUrl, apiOrigin) {
  const target = new URL(requestUrl);
  if (target.protocol !== "https:" || target.username || target.password || target.origin !== apiOrigin.origin || !target.pathname.startsWith("/api/")) {
    throw new Error("Refusing to send an API access token to an unconfigured origin.");
  }
  return target;
}

function accessTokenValue(result, operation) {
  if (!result || typeof result.accessToken !== "string" || !result.accessToken) {
    throw new Error(`${operation} returned no Codexia API access token.`);
  }
  return result.accessToken;
}
