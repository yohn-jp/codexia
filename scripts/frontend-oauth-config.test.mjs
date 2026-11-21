import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  assertFrontendOAuthConfigIdentity,
  frontendOAuthConfigHash,
  readFrontendOAuthConfig,
} from './frontend-oauth-config.mjs';

const settings = {
  VITE_CODEXIA_OAUTH_ISSUER: 'https://codexia.example.test/api/auth',
  VITE_CODEXIA_OAUTH_CLIENT_ID: 'codexia-web-public',
  VITE_CODEXIA_API_AUDIENCE: 'https://codexia.example.test/api',
  VITE_CODEXIA_OAUTH_DESKTOP_REDIRECT_URI: 'https://codexia.example.test/desktop',
  VITE_CODEXIA_OAUTH_MOBILE_REDIRECT_URI: 'https://codexia.example.test/mobile',
};

test('no OAuth public settings preserve non-OAuth authentication builds', () => {
  assert.equal(readFrontendOAuthConfig({}), null);
  assert.match(frontendOAuthConfigHash({}), /^[a-f0-9]{64}$/u);
});

test('OAuth public settings require every Web shell callback and a complete client', () => {
  const config = readFrontendOAuthConfig(settings);
  assert.deepEqual(config, {
    issuer: settings.VITE_CODEXIA_OAUTH_ISSUER,
    clientId: settings.VITE_CODEXIA_OAUTH_CLIENT_ID,
    apiAudience: settings.VITE_CODEXIA_API_AUDIENCE,
    desktopRedirectUri: settings.VITE_CODEXIA_OAUTH_DESKTOP_REDIRECT_URI,
    mobileRedirectUri: settings.VITE_CODEXIA_OAUTH_MOBILE_REDIRECT_URI,
    scopes: ['openid', 'codexia:api'],
  });
  for (const key of Object.keys(settings)) {
    const incomplete = { ...settings };
    delete incomplete[key];
    assert.throws(() => readFrontendOAuthConfig(incomplete), /OAuth Web configuration is incomplete/u, key);
  }
});

test('an empty optional scope variable uses the documented default scopes', () => {
  assert.deepEqual(readFrontendOAuthConfig({
    ...settings,
    VITE_CODEXIA_OAUTH_SCOPES: '',
  }).scopes, ['openid', 'codexia:api']);
});

test('the release build stops before Vite when OAuth settings are partial', () => {
  const result = spawnSync(process.execPath, ['scripts/build-frontend.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      VITE_CODEXIA_OAUTH_ISSUER: settings.VITE_CODEXIA_OAUTH_ISSUER,
      VITE_CODEXIA_OAUTH_CLIENT_ID: '',
      VITE_CODEXIA_API_AUDIENCE: '',
      VITE_CODEXIA_OAUTH_DESKTOP_REDIRECT_URI: '',
      VITE_CODEXIA_OAUTH_MOBILE_REDIRECT_URI: '',
      VITE_CODEXIA_OAUTH_SCOPES: '',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /OAuth Web configuration is incomplete/u);
});

test('OAuth public settings reject a callback registered on another origin', () => {
  assert.throws(() => readFrontendOAuthConfig({
    ...settings,
    VITE_CODEXIA_OAUTH_MOBILE_REDIRECT_URI: 'https://mobile.example.test/oauth/callback',
  }), /redirect URI must use the OAuth issuer origin/u);
});

test('OAuth configuration identity changes whenever the public client settings change', () => {
  const baseline = frontendOAuthConfigHash(settings);
  for (const [key, value] of [
    ['VITE_CODEXIA_OAUTH_ISSUER', 'https://codexia.example.test/oauth'],
    ['VITE_CODEXIA_OAUTH_CLIENT_ID', 'another-public-client'],
    ['VITE_CODEXIA_API_AUDIENCE', 'https://codexia.example.test/other-api'],
    ['VITE_CODEXIA_OAUTH_DESKTOP_REDIRECT_URI', 'https://codexia.example.test/desktop/callback'],
    ['VITE_CODEXIA_OAUTH_MOBILE_REDIRECT_URI', 'https://codexia.example.test/mobile/callback'],
    ['VITE_CODEXIA_OAUTH_SCOPES', 'openid codexia:api extra:scope'],
  ]) {
    assert.notEqual(frontendOAuthConfigHash({ ...settings, [key]: value }), baseline, key);
  }
});

test('frontend artifacts are admitted only when their OAuth configuration matches current public settings', () => {
  const identity = {
    format: 'codexia-frontend-identity/v1',
    version: '0.1.21',
    sourceSha: 'a'.repeat(40),
    profile: 'full',
    apiEpoch: 1,
    oauthConfigSha256: frontendOAuthConfigHash(settings),
  };
  assert.doesNotThrow(() => assertFrontendOAuthConfigIdentity(identity, settings));
  assert.throws(() => assertFrontendOAuthConfigIdentity(identity, {
    ...settings,
    VITE_CODEXIA_OAUTH_CLIENT_ID: 'stale-client',
  }), /OAuth configuration does not match the current public settings/u);
  assert.throws(() => assertFrontendOAuthConfigIdentity({ ...identity, oauthConfigSha256: undefined }, settings),
    /OAuth configuration does not match the current public settings/u);
});
