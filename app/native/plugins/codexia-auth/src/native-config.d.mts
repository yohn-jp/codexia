export const CALLBACK_URI: string;
export function nativeApiOrigin(env: Record<string, string | undefined>): string | null;
export function nativeReaderOrigin(env: Record<string, string | undefined>): string | null;
export function nativeOAuthConfig(env: Record<string, string | undefined>): {
  apiOrigin: string;
  apiAudience: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
} | null;
