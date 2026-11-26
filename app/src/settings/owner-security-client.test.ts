import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchOwnerIdentity,
  outcomeWasUnconfirmed,
  OwnerSecurityRequestError,
  revokeOwnerConsent,
  type OwnerConsent,
} from './owner-security-client';

const consent: OwnerConsent = {
  id: 'consent',
  clientId: 'web',
  scopes: ['openid', 'offline_access'],
  updatedAt: '2026-11-26T00:00:00.000Z',
  revision: 'A'.repeat(43),
};

test('owner identity uses the same-origin cookie and exposes only whitelisted client and grant fields', async () => {
  const identity = await fetchOwnerIdentity(async (input, init) => {
    assert.equal(input, '/api/auth/codexia/owner-security/identity');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.credentials, 'same-origin');
    assert.equal(init?.cache, 'no-store');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.mode, 'same-origin');
    assert.equal(new Headers(init?.headers).has('authorization'), false);
    return Response.json({
      provider: { status: 'operator-configured-unverified', clientSecret: 'never-expose' },
      clients: [{ clientId: 'web', name: 'Codexia Desktop', scopes: ['openid'], redirectUris: ['https://codexia.example/callback'], disabled: false, clientSecret: 'never-expose' }],
      consents: [{ ...consent, token: 'never-expose' }],
      unrelated: 'discarded',
    });
  });
  assert.deepEqual(identity, {
    provider: { status: 'operator-configured-unverified' },
    clients: [{ clientId: 'web', name: 'Codexia Desktop', scopes: ['openid'], redirectUris: ['https://codexia.example/callback'], disabled: false }],
    consents: [consent],
  });
});

test('owner identity fails closed for anonymous and malformed responses', async () => {
  await assert.rejects(fetchOwnerIdentity(async () => new Response(null, { status: 401 })), OwnerSecurityRequestError);
  await assert.rejects(fetchOwnerIdentity(async () => Response.json({ provider: { status: 'unknown' }, clients: [], consents: [] })));
  await assert.rejects(fetchOwnerIdentity(async () => Response.json({
    provider: { status: 'not-configured' }, clients: [], consents: [{ ...consent, scopes: [2] }],
  })));
});

test('grant withdrawal sends only consent identity and requires the full revocation receipt', async () => {
  await revokeOwnerConsent(consent, async (input, init) => {
    assert.equal(input, '/api/auth/codexia/owner-security/revoke-consent');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.credentials, 'same-origin');
    assert.equal(init?.cache, 'no-store');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.mode, 'same-origin');
    assert.equal(new Headers(init?.headers).has('authorization'), false);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      id: consent.id,
      clientId: consent.clientId,
      scopes: consent.scopes,
      revision: consent.revision,
    });
    return Response.json({ consentRemoved: true, grantRevoked: true });
  });
  await assert.rejects(
    revokeOwnerConsent(consent, async () => Response.json({ consentRemoved: true, grantRevoked: false })),
    outcomeWasUnconfirmed,
  );
  await assert.rejects(
    revokeOwnerConsent(consent, async () => new Response(JSON.stringify({ code: 'OWNER_SECURITY_REAUTH_REQUIRED' }), { status: 403 })),
    error => error instanceof OwnerSecurityRequestError && error.status === 403 && error.code === 'OWNER_SECURITY_REAUTH_REQUIRED',
  );
});

test('unknown mutation outcome distinguishes transport and upstream failures from explicit denials', () => {
  assert.equal(outcomeWasUnconfirmed(new TypeError('Failed to fetch')), true);
  assert.equal(outcomeWasUnconfirmed({ status: 503 }), true);
  assert.equal(outcomeWasUnconfirmed({ status: 403, code: 'OWNER_SECURITY_REAUTH_REQUIRED' }), false);
  assert.equal(outcomeWasUnconfirmed(new DOMException('Cancelled', 'NotAllowedError')), false);
});
