import { createAuthClient } from "better-auth/react";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { passkeyClient } from "@better-auth/passkey/client";

/** Better Auth calls are same-origin session operations, separate from API data requests. */
export const authClient = createAuthClient({
  basePath: "/api/auth",
  fetchOptions: { credentials: "same-origin", cache: "no-store", redirect: "error" },
  plugins: [oauthProviderClient(), passkeyClient()],
});
