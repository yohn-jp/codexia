import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  assertFrontendOAuthConfigIdentity,
  frontendOAuthConfigIdentity,
  parsePublicFrontendConfigIdentity,
  readFrontendOAuthConfig,
} from './oauth-config.mjs';

const settings = {
  VITE_CODEXIA_OAUTH_ISSUER: 'https://codexia.example.test/api/auth',
  VITE_CODEXIA_OAUTH_CLIENT_ID: 'codexia-web-public',
  VITE_CODEXIA_API_AUDIENCE: 'https://codexia.example.test/api',
  VITE_CODEXIA_OAUTH_DESKTOP_REDIRECT_URI: 'https://codexia.example.test/desktop',
};
const expectedConfig = {
  issuer: 'https://codexia.example.test/api/auth',
  clientId: 'codexia-web-public',
  apiAudience: 'https://codexia.example.test/api',
  desktopRedirectUri: 'https://codexia.example.test/desktop',
  scopes: ['openid', 'codexia:api'],
};

test('no OAuth public settings preserve non-OAuth authentication builds', () => {
  assert.equal(readFrontendOAuthConfig({}), null);
  assert.deepEqual(JSON.parse(frontendOAuthConfigIdentity({})), { format: 'codexia-web-oauth-config/v2', settings: null });
});

test('OAuth public settings require only the Desktop callback and a complete client', () => {
  const config = readFrontendOAuthConfig(settings);
  assert.deepEqual(config, expectedConfig);
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
  const result = spawnSync(process.execPath, ['scripts/build/frontend/build.mjs'], {
    cwd: new URL('../../../', import.meta.url),
    env: {
      ...process.env,
      VITE_CODEXIA_OAUTH_ISSUER: settings.VITE_CODEXIA_OAUTH_ISSUER,
      VITE_CODEXIA_OAUTH_CLIENT_ID: '',
      VITE_CODEXIA_API_AUDIENCE: '',
      VITE_CODEXIA_OAUTH_DESKTOP_REDIRECT_URI: '',
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
    VITE_CODEXIA_OAUTH_DESKTOP_REDIRECT_URI: 'https://other.example.test/oauth/callback',
  }), /redirect URI must use the OAuth issuer origin/u);
});

test('OAuth configuration identity changes whenever the public client settings change', () => {
  const baseline = frontendOAuthConfigIdentity(settings);
  for (const [key, value] of [
    ['VITE_CODEXIA_OAUTH_ISSUER', 'https://codexia.example.test/oauth'],
    ['VITE_CODEXIA_OAUTH_CLIENT_ID', 'another-public-client'],
    ['VITE_CODEXIA_API_AUDIENCE', 'https://codexia.example.test/other-api'],
    ['VITE_CODEXIA_OAUTH_DESKTOP_REDIRECT_URI', 'https://codexia.example.test/desktop/callback'],
    ['VITE_CODEXIA_OAUTH_SCOPES', 'openid codexia:api extra:scope'],
  ]) {
    assert.notEqual(frontendOAuthConfigIdentity({ ...settings, [key]: value }), baseline, key);
  }
});

test('frontend artifacts are admitted only when their OAuth configuration matches current public settings', () => {
  const identity = {
    format: 'codexia-frontend-identity/v1',
    version: '0.1.21',
    sourceSha: 'a'.repeat(40),
    profile: 'full',
    apiEpoch: 1,
    oauthConfigIdentity: JSON.stringify({ format: 'codexia-web-oauth-config/v2', settings: expectedConfig }),
  };
  assert.doesNotThrow(() => assertFrontendOAuthConfigIdentity(identity, settings));
  assert.throws(() => assertFrontendOAuthConfigIdentity(identity, {
    ...settings,
    VITE_CODEXIA_OAUTH_CLIENT_ID: 'stale-client',
  }), /OAuth configuration does not match the current public settings/u);
  assert.throws(() => assertFrontendOAuthConfigIdentity({ ...identity, oauthConfigIdentity: undefined }, settings),
    /OAuth configuration does not match the current public settings/u);
});

test('a retired Mobile setting has no effect on new frontend builds', () => {
  assert.equal(frontendOAuthConfigIdentity({
    ...settings, VITE_CODEXIA_OAUTH_MOBILE_REDIRECT_URI: 'invalid retired setting',
  }), frontendOAuthConfigIdentity(settings));
  assert.equal(readFrontendOAuthConfig({ VITE_CODEXIA_OAUTH_MOBILE_REDIRECT_URI: 'retired' }), null);
});

test('historical artifact identities retain and strictly validate their recorded callbacks', () => {
  const legacy = { ...expectedConfig, mobileRedirectUri: 'https://codexia.example.test/mobile' };
  const { scopes, ...config } = legacy;
  const serialize = settings => JSON.stringify({ format: 'codexia-web-oauth-config/v1', settings });
  const identity = serialize({ ...config, scopes });
  assert.deepEqual(parsePublicFrontendConfigIdentity(identity), legacy);
  assert.throws(() => assertFrontendOAuthConfigIdentity({ oauthConfigIdentity: identity }, settings), /does not match/u);
  assert.throws(() => parsePublicFrontendConfigIdentity(serialize({
    ...config, mobileRedirectUri: 'https://other.example.test/mobile', scopes,
  })), /Invalid public frontend configuration identity/u);
  assert.throws(() => parsePublicFrontendConfigIdentity(serialize({
    ...config, scopes, extra: true,
  })), /Invalid public frontend configuration identity/u);
});
