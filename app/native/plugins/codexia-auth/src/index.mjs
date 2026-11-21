import { CALLBACK_URI } from "./constants.mjs";

let nativePluginPromise;

export function createNativeAuth(config, { apiRequest, nativePlugin } = {}) {
  if (!config || config.redirectUri !== CALLBACK_URI) throw new TypeError("Native OAuth configuration is invalid.");
  const apiOrigin = new URL(config.apiOrigin);
  const getPlugin = () => nativePlugin ? Promise.resolve(nativePlugin) : getNativeAuthPlugin();
  const fetchRequest = createNativeApiTransport(config.apiOrigin, {
    apiRequest: apiRequest ?? ((options) => getPlugin().then((plugin) => plugin.apiRequest(options))),
  });

  return Object.freeze({
    async signIn() {
      return accessTokenValue(await (await getPlugin()).signIn(config), "Sign-in");
    },
    async accessTokenFor(requestUrl) {
      validateApiRequestUrl(requestUrl, apiOrigin);
      try {
        return accessTokenValue(await (await getPlugin()).accessToken(config), "API access");
      } catch (error) {
        if (error && typeof error === "object" && error.code === "reauthenticationRequired") return null;
        throw error;
      }
    },
    fetchRequest,
    async signOut() {
      const result = await (await getPlugin()).signOut(config);
      return { revoked: result?.revoked === true };
    },
  });
}

export function createNativeApiTransport(apiOriginValue, { apiRequest } = {}) {
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
      const result = await (apiRequest ?? defaultApiRequest)({
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

async function defaultApiRequest(options) {
  return (await getNativeAuthPlugin()).apiRequest(options);
}

function getNativeAuthPlugin() {
  if (!nativePluginPromise) {
    nativePluginPromise = import("@capacitor/core").then(({ registerPlugin }) => registerPlugin("CodexiaAuth"));
  }
  return nativePluginPromise;
}

function validateApiRequestUrl(requestUrl, apiOrigin) {
  const target = new URL(requestUrl);
  const rawPath = requestUrl.split(/[?#]/u, 1)[0];
  if (target.protocol !== "https:" || target.username || target.password || target.origin !== apiOrigin.origin ||
      !target.pathname.startsWith("/api/") || target.pathname === "/api/auth" || target.pathname.startsWith("/api/auth/") ||
      /%(?:2e|2f|5c|25)/iu.test(rawPath) || /(?:^|\/)\.{1,2}(?:\/|$)/u.test(rawPath) || rawPath.includes("\\")) {
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
