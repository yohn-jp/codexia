export type NativeAuthConfig = {
  apiOrigin: string;
  apiAudience: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
};

export function createNativeApiTransport(apiOrigin: string): (requestUrl: string, init?: RequestInit) => Promise<Response>;

export function createNativeAuth(config: NativeAuthConfig): {
  signIn(): Promise<string>;
  accessTokenFor(requestUrl: string): Promise<string>;
  fetchRequest(requestUrl: string, init?: RequestInit): Promise<Response>;
  signOut(): Promise<{ revoked: boolean }>;
};
