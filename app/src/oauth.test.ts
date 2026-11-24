import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { test } from 'node:test';
import { inspect } from 'node:util';
import { apiRequestUrl, beginOAuthAuthorization, completeOAuthAuthorization, type OAuthWebConfig } from './oauth.js';

const config: OAuthWebConfig = {
  issuer: 'https://codexia.example.test/api/auth',
  clientId: 'codexia-web-public',
  apiAudience: 'https://codexia.example.test/api',
  redirectUri: 'https://codexia.example.test/desktop',
  scopes: ['openid', 'codexia:api'],
};

const metadata = {
  issuer: config.issuer,
  authorization_endpoint: `${config.issuer}/oauth2/authorize`,
  token_endpoint: `${config.issuer}/oauth2/token`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code'],
  token_endpoint_auth_methods_supported: ['none'],
  code_challenge_methods_supported: ['S256'],
  authorization_response_iss_parameter_supported: true,
  scopes_supported: ['openid', 'codexia:api'],
};

function metadataFetch(): typeof fetch {
  return async (input, init) => {
    assert.equal(new URL(String(input)).pathname, '/.well-known/oauth-authorization-server/api/auth');
    assert.equal(init?.credentials, 'omit');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.cache, 'no-store');
    return Response.json(metadata);
  };
}

function installBrowserStubs(href = config.redirectUri) {
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const originalSessionStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const storage = new Map<string, string>();
  let assigned = '';
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => {
        storage.delete(key);
      },
    },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: {
        assign: (url: string) => {
          assigned = url;
        },
        href,
        origin: new URL(config.redirectUri).origin,
      },
    },
  });
  return {
    get assigned() {
      return assigned;
    },
    storage,
    restore() {
      for (const [key, descriptor] of [
        ['crypto', originalCrypto],
        ['sessionStorage', originalSessionStorage],
        ['window', originalWindow],
      ] as const) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('OAuth browser client uses state and S256 PKCE, exchanges once and returns to the original scene', async () => {
  const returnPath = '/desktop/projects/project-1/scenes/scene-1?chapter=chapter-1#manuscript';
  const browser = installBrowserStubs(new URL(returnPath, config.redirectUri).href);
  try {
    await beginOAuthAuthorization(config, metadataFetch());
    const authorization = new URL(browser.assigned);
    assert.equal(authorization.searchParams.get('client_id'), config.clientId);
    assert.equal(authorization.searchParams.get('resource'), config.apiAudience);
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    const state = authorization.searchParams.get('state');
    assert.match(state ?? '', /^[A-Za-z0-9_-]{43,}$/u);
    const callback = `${config.redirectUri}?code=authorization-code&state=${state}&iss=${encodeURIComponent(config.issuer)}`;

    let submitted = new URLSearchParams();
    let callbackValidated = 0;
    const authorizationResult = await completeOAuthAuthorization(
      config,
      callback,
      async (input, init) => {
        assert.equal(callbackValidated, 1, 'static preparation starts before discovery and token exchange');
        if (init?.method !== 'POST') return Response.json(metadata);
        assert.equal(String(input), metadata.token_endpoint);
        submitted = new URLSearchParams(init?.body as URLSearchParams);
        assert.equal(init?.credentials, 'omit');
        assert.equal(init?.redirect, 'error');
        assert.equal(init?.cache, 'no-store');
        return Response.json({
          access_token: 'codexia-api-access-token',
          token_type: 'Bearer',
          expires_in: 300,
        });
      },
      () => {
        callbackValidated += 1;
      },
    );
    assert.equal(callbackValidated, 1);
    assert.deepEqual(authorizationResult, { accessToken: 'codexia-api-access-token', returnPath });
    assert.equal(browser.storage.size, 0, 'token exchange leaves tab storage empty');
    const verifier = submitted.get('code_verifier') ?? '';
    assert.match(verifier, /^[A-Za-z0-9._~-]{43,128}$/u);
    assert.equal(authorization.searchParams.get('code_challenge'), createHash('sha256').update(verifier).digest('base64url'));
    assert.equal(submitted.get('code'), 'authorization-code');
    assert.equal(submitted.get('resource'), config.apiAudience);
    assert.equal(submitted.has('client_secret'), false, 'a public Web client never sends a client secret');
    await assert.rejects(
      completeOAuthAuthorization(config, callback, async () => {
        assert.fail('a consumed transaction cannot send another request');
      }),
      /state validation/u,
    );
  } finally {
    browser.restore();
  }
});

test('OAuth callback accepts an unexpired transaction created before the library migration', async () => {
  const browser = installBrowserStubs();
  const state = 's'.repeat(43);
  const verifier = 'v'.repeat(64);
  const callback = new URL(config.redirectUri);
  callback.search = new URLSearchParams({ code: 'one-time-code', state, iss: config.issuer }).toString();
  try {
    browser.storage.set(
      'codexia.oauth.pkce.v1',
      JSON.stringify({
        state,
        verifier,
        createdAt: Date.now(),
        returnPath: '/desktop',
      }),
    );
    assert.deepEqual(
      await completeOAuthAuthorization(config, callback.href, async (_input, init) => {
        if (init?.method !== 'POST') return Response.json(metadata);
        assert.equal(new URLSearchParams(init.body as URLSearchParams).get('code_verifier'), verifier);
        return Response.json({
          access_token: 'codexia-api-access-token',
          token_type: 'Bearer',
          expires_in: 300,
          scope: 'codexia:api',
        });
      }),
      { accessToken: 'codexia-api-access-token', returnPath: '/desktop' },
    );
    assert.equal(browser.storage.size, 0);
  } finally {
    browser.restore();
  }
});

test('OAuth callback rejects state mismatch and clears the one-time transaction', async () => {
  const browser = installBrowserStubs();
  try {
    await beginOAuthAuthorization(config, metadataFetch());
    const state = new URL(browser.assigned).searchParams.get('state');
    const unexpectedFetch = async () => assert.fail('a rejected or consumed transaction cannot send a request');
    let callbackValidated = 0;
    const onValidatedCallback = () => {
      callbackValidated += 1;
    };
    assert.equal(await completeOAuthAuthorization(config, config.redirectUri, unexpectedFetch, onValidatedCallback), null);
    await assert.rejects(
      completeOAuthAuthorization(config, `${config.redirectUri}?code=x&state=wrong`, unexpectedFetch, onValidatedCallback),
      /state validation/u,
    );
    await assert.rejects(
      completeOAuthAuthorization(config, `${config.redirectUri}?code=x&state=${state}`, unexpectedFetch, onValidatedCallback),
      /state validation/u,
    );
    assert.equal(callbackValidated, 0);
  } finally {
    browser.restore();
  }
});

test('OAuth callback rejects ambiguous state before making a token request', async () => {
  const browser = installBrowserStubs();
  try {
    await beginOAuthAuthorization(config, metadataFetch());
    const state = new URL(browser.assigned).searchParams.get('state');
    let requests = 0;
    await assert.rejects(
      completeOAuthAuthorization(config, `${config.redirectUri}?code=x&state=${state}&state=${state}`, async () => {
        requests += 1;
        return Response.json({});
      }),
      /ambiguous state/u,
    );
    assert.equal(requests, 0);
  } finally {
    browser.restore();
  }
});

test('OAuth callback rejects a token response without a usable API access token', async () => {
  const browser = installBrowserStubs();
  try {
    await beginOAuthAuthorization(config, metadataFetch());
    const state = new URL(browser.assigned).searchParams.get('state');
    await assert.rejects(
      completeOAuthAuthorization(
        config,
        `${config.redirectUri}?code=x&state=${state}&iss=${encodeURIComponent(config.issuer)}`,
        async (_input, init) =>
          init?.method === 'POST'
            ? Response.json({
                id_token: 'identity-token-is-not-an-api-credential',
                token_type: 'Bearer',
                expires_in: 300,
              })
            : Response.json(metadata),
      ),
      /usable API bearer access token/u,
    );
  } finally {
    browser.restore();
  }
});

test('OAuth callback rejects a different authorization-server issuer', async () => {
  const browser = installBrowserStubs();
  try {
    await beginOAuthAuthorization(config, metadataFetch());
    const state = new URL(browser.assigned).searchParams.get('state');
    let tokenExchanges = 0;
    let callbackValidated = 0;
    await assert.rejects(
      completeOAuthAuthorization(
        config,
        `${config.redirectUri}?code=x&state=${state}&iss=https%3A%2F%2Fwrong.example.test%2Fapi%2Fauth`,
        async (_input, init) => {
          if (init?.method === 'POST') tokenExchanges += 1;
          return Response.json(metadata);
        },
        () => {
          callbackValidated += 1;
        },
      ),
      /issuer(?: or state)? validation/u,
    );
    assert.equal(tokenExchanges, 0);
    assert.equal(callbackValidated, 0);
  } finally {
    browser.restore();
  }
});

test('OAuth discovery rejects a wrong issuer and public-client capability mismatch', async () => {
  const browser = installBrowserStubs();
  try {
    await assert.rejects(
      beginOAuthAuthorization(config, async () => Response.json({ ...metadata, issuer: 'https://wrong.example.test/api/auth' })),
      /metadata does not meet/u,
    );
    await assert.rejects(
      beginOAuthAuthorization(config, async () =>
        Response.json({ ...metadata, token_endpoint_auth_methods_supported: ['client_secret_post'] }),
      ),
      /metadata does not meet/u,
    );
  } finally {
    browser.restore();
  }
});

function authorizationCallback(authorizationUrl: string): URL {
  const callback = new URL(config.redirectUri);
  callback.searchParams.set('code', 'one-time-code');
  const state = new URL(authorizationUrl).searchParams.get('state');
  assert.ok(state);
  callback.searchParams.set('state', state);
  callback.searchParams.set('iss', config.issuer);
  return callback;
}

test('OAuth discovery refuses endpoints outside the exact issuer origin and path', async () => {
  const browser = installBrowserStubs();
  try {
    for (const override of [
      { authorization_endpoint: 'https://foreign.example.test/api/auth/oauth2/authorize' },
      { token_endpoint: 'https://foreign.example.test/api/auth/oauth2/token' },
      { authorization_endpoint: 'https://codexia.example.test/api/auth-other/authorize' },
      { token_endpoint: 'https://codexia.example.test/api/auth-other/token' },
      { authorization_endpoint: [metadata.authorization_endpoint] },
      { token_endpoint: ['invalid-token-endpoint'] },
      { scopes_supported: ['openid'] },
      { scopes_supported: 'openid codexia:api' },
    ]) {
      await assert.rejects(
        beginOAuthAuthorization(config, async () => Response.json({ ...metadata, ...override })),
        JSON.stringify(override),
      );
      assert.equal(browser.assigned, '');
      assert.equal(browser.storage.size, 0);
    }
  } finally {
    browser.restore();
  }
});

test('OAuth discovery refuses a redirect before creating an authorization transaction', async () => {
  const browser = installBrowserStubs();
  try {
    await assert.rejects(
      beginOAuthAuthorization(config, async (_input, init) => {
        assert.equal(init?.redirect, 'error');
        return Response.redirect('https://foreign.example.test/metadata');
      }),
    );
    assert.equal(browser.assigned, '');
    assert.equal(browser.storage.size, 0);
  } finally {
    browser.restore();
  }
});

test('OAuth rejects an issuer or redirect origin override and an invalid resource URL before discovery', async () => {
  const browser = installBrowserStubs();
  try {
    let requests = 0;
    for (const override of [
      { issuer: 'https://foreign.example.test/api/auth' },
      { redirectUri: 'https://foreign.example.test/desktop' },
      { apiAudience: 'https://codexia.example.test/api#invalid-resource' },
    ]) {
      await assert.rejects(
        beginOAuthAuthorization({ ...config, ...override }, async () => {
          requests += 1;
          return Response.json(metadata);
        }),
      );
    }
    assert.equal(requests, 0);
    assert.equal(browser.assigned, '');
  } finally {
    browser.restore();
  }
});

test('OAuth callback rejects ambiguous responses before sending an authorization code', async () => {
  const browser = installBrowserStubs();
  try {
    for (const { extraParams = [], fragment = '' } of [
      { extraParams: [['code', 'one-time-code']] },
      { extraParams: [['iss', config.issuer]] },
      { extraParams: [['error', 'access_denied']] },
      {
        extraParams: [
          ['error_description', 'provider-private-diagnostic'],
          ['error_description', 'another-diagnostic'],
        ],
      },
      { extraParams: [['id_token', 'unexpected-identity-token']] },
      { fragment: 'code=another-code' },
      { fragment: 'access_token=unexpected-access-token' },
    ]) {
      await beginOAuthAuthorization(config, metadataFetch());
      const callback = authorizationCallback(browser.assigned);
      for (const [name, value] of extraParams) callback.searchParams.append(name, value);
      callback.hash = fragment;
      let exchanges = 0;
      await assert.rejects(
        completeOAuthAuthorization(config, callback.href, async (_input, init) => {
          if (init?.method === 'POST') exchanges += 1;
          return Response.json(metadata);
        }),
      );
      assert.equal(exchanges, 0, JSON.stringify({ extraParams, fragment }));
    }
  } finally {
    browser.restore();
  }
});

test('OAuth callback matches the registered origin and path without consuming the transaction elsewhere', async () => {
  const browser = installBrowserStubs();
  try {
    await beginOAuthAuthorization(config, metadataFetch());
    for (const target of ['https://foreign.example.test/desktop', 'https://codexia.example.test/mobile']) {
      const callback = new URL(target);
      callback.search = authorizationCallback(browser.assigned).search;
      let requests = 0;
      assert.equal(
        await completeOAuthAuthorization(config, callback.href, async () => {
          requests += 1;
          return Response.json(metadata);
        }),
        null,
      );
      assert.equal(requests, 0);
      assert.equal(browser.storage.size, 1);
    }
  } finally {
    browser.restore();
  }
});

test('OAuth callback consumes an expired PKCE transaction without making a request', async t => {
  const browser = installBrowserStubs();
  const clock = t.mock.method(Date, 'now', () => 1000);
  try {
    await beginOAuthAuthorization(config, metadataFetch());
    clock.mock.mockImplementation(() => 1000 + 10 * 60 * 1000 + 1);
    let requests = 0;
    await assert.rejects(
      completeOAuthAuthorization(config, authorizationCallback(browser.assigned).href, async () => {
        requests += 1;
        return Response.json(metadata);
      }),
    );
    assert.equal(requests, 0);
    assert.equal(browser.storage.size, 0);
  } finally {
    browser.restore();
  }
});

test('OAuth callback refuses malformed token responses and nonmatching granted scopes', async () => {
  const browser = installBrowserStubs();
  const token = { access_token: 'synthetic-private-access-token', token_type: 'Bearer', expires_in: 300 };
  try {
    for (const result of [
      [],
      { ...token, expires_in: 0 },
      { ...token, expires_in: '300' },
      { ...token, token_type: 'DPoP' },
      { ...token, scope: 'openid' },
      { ...token, scope: 'openid codexia:api mcp:read' },
      { ...token, scope: ['openid', 'codexia:api'] },
    ]) {
      await beginOAuthAuthorization(config, metadataFetch());
      await assert.rejects(
        completeOAuthAuthorization(config, authorizationCallback(browser.assigned).href, async (_input, init) =>
          init?.method === 'POST' ? Response.json(result) : Response.json(metadata),
        ),
        (error: unknown) => {
          assert(error instanceof Error);
          assert.doesNotMatch(inspect(error), /synthetic-private-access-token/u);
          return true;
        },
        JSON.stringify(result),
      );
      assert.equal(browser.storage.size, 0);
    }
  } finally {
    browser.restore();
  }
});

test('OAuth token exchange refuses redirects and does not retain the transaction', async () => {
  const browser = installBrowserStubs();
  try {
    await beginOAuthAuthorization(config, metadataFetch());
    await assert.rejects(
      completeOAuthAuthorization(config, authorizationCallback(browser.assigned).href, async (input, init) => {
        if (init?.method !== 'POST') return Response.json(metadata);
        assert.equal(String(input), metadata.token_endpoint);
        assert.equal(init?.redirect, 'error');
        return Response.redirect('https://foreign.example.test/token', 307);
      }),
    );
    assert.equal(browser.storage.size, 0);
  } finally {
    browser.restore();
  }
});

test('OAuth callback rejects a provider PKCE failure and keeps provider diagnostics out of the error', async () => {
  const browser = installBrowserStubs();
  try {
    await beginOAuthAuthorization(config, metadataFetch());
    const authorization = new URL(browser.assigned);
    const callback = authorizationCallback(browser.assigned);
    const transactionKey = 'codexia.oauth.pkce.v1';
    const storedTransaction = browser.storage.get(transactionKey);
    assert.ok(storedTransaction);
    const transaction = JSON.parse(storedTransaction);
    browser.storage.set(transactionKey, JSON.stringify({ ...transaction, verifier: 'v'.repeat(64) }));
    let exchanges = 0;
    await assert.rejects(
      completeOAuthAuthorization(config, callback.href, async (input, init) => {
        if (init?.method !== 'POST') return Response.json(metadata);
        exchanges += 1;
        assert.equal(String(input), metadata.token_endpoint);
        const verifier = new URLSearchParams(init.body as URLSearchParams).get('code_verifier');
        assert.ok(verifier);
        const submittedChallenge = createHash('sha256').update(verifier).digest('base64url');
        assert.notEqual(submittedChallenge, authorization.searchParams.get('code_challenge'));
        return Response.json(
          {
            error: 'invalid_grant',
            error_description: 'provider-private-PKCE-diagnostic',
          },
          { status: 400 },
        );
      }),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.doesNotMatch(inspect(error), /provider-private-PKCE-diagnostic|one-time-code/u);
        return true;
      },
    );
    assert.equal(exchanges, 1);
    assert.equal(browser.storage.size, 0);
  } finally {
    browser.restore();
  }
});

test('API origin resolver accepts only explicit API paths and an HTTPS origin', () => {
  assert.equal(apiRequestUrl('/api/session'), '/api/session');
  assert.equal(
    apiRequestUrl('/api/session', 'https://api.example.test', 'https://codexia.example.test'),
    'https://api.example.test/api/session',
  );
  assert.equal(apiRequestUrl('/api/session', 'https://codexia.example.test', 'https://codexia.example.test'), '/api/session');
  assert.throws(() => apiRequestUrl('/oauth/consent', 'https://api.example.test'), /Only Codexia API paths/u);
  assert.throws(() => apiRequestUrl('/api/session', 'http://api.example.test'), /HTTPS/u);
  assert.throws(() => apiRequestUrl('/api/session', 'https://api.example.test/v1'), /only an origin/u);
});
