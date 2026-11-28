import { appendFileSync, readFileSync } from 'node:fs';

const profile = JSON.parse(readFileSync(new URL('../../../deploy/production.json', import.meta.url)));
const origin = profile.publicOrigin;
const settings = {
  CODEXIA_PUBLIC_ORIGIN: origin,
  CODEXIA_MANAGEMENT_HOSTNAME: profile.managementHostname,
  VITE_CODEXIA_OAUTH_ISSUER: origin + '/api/auth',
  VITE_CODEXIA_OAUTH_CLIENT_ID: profile.webClientId,
  VITE_CODEXIA_API_AUDIENCE: origin + '/api',
  VITE_CODEXIA_OAUTH_DESKTOP_REDIRECT_URI: origin + profile.desktopCallbackPath,
  VITE_CODEXIA_OAUTH_SCOPES: profile.scopes,
};
for (const [key, value] of Object.entries(settings)) {
  if (typeof value !== 'string' || !value || /[\r\n]/u.test(value)) throw new Error('Invalid production setting ' + key);
  appendFileSync(process.env.GITHUB_ENV, key + '=' + value + '\n');
}
