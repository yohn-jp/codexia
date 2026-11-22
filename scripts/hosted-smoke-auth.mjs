import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readFile, realpath } from 'node:fs/promises';
import { createServer } from 'node:https';
import { createRequire } from 'node:module';
import path from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { pathToFileURL } from 'node:url';
import { clientId, clientSecret, createIdp, identity, register } from './push-auth-lifecycle-oidc.mjs';

async function listenLoopback(server, host) {
  server.listen(0, host);
  await once(server, 'listening');
  return `https://${host}:${server.address().port}`;
}

async function closeServer(server) {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
}

export async function setupHostedSmokeAuth({ packageDirectory, dataDirectory, databaseUrl }) {
  const apiDirectory = path.join(packageDirectory, 'node_modules/@codexia/api');
  const requireApi = createRequire(await realpath(path.join(apiDirectory, 'package.json')));
  const { Client } = requireApi('pg');
  const { createBetterAuthBootstrap } = await import(pathToFileURL(path.join(apiDirectory, 'dist/bootstrap-auth.js')));
  const { CODEXIA_AUTH_SCHEMA } = await import(pathToFileURL(path.join(apiDirectory, 'dist/better-auth.js')));
  const { CODEXIA_AUTH_RUNTIME_ROLE, migrateBetterAuth } = await import(pathToFileURL(path.join(apiDirectory, 'dist/migrate-auth.js')));
  const certPath = path.join(dataDirectory, 'auth-ca.crt');
  const keyPath = path.join(dataDirectory, 'auth-ca.key');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=Codexia Hosted Smoke',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', keyPath, '-out', certPath,
  ], { stdio: 'pipe', timeout: 10_000 });
  const tls = { cert: await readFile(certPath, 'utf8'), key: await readFile(keyPath), minVersion: 'TLSv1.2' };
  const authDatabase = new URL(databaseUrl);
  const password = randomBytes(32).toString('hex');
  authDatabase.username = CODEXIA_AUTH_RUNTIME_ROLE;
  authDatabase.password = password;
  const admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  const authRole = admin.escapeIdentifier(CODEXIA_AUTH_RUNTIME_ROLE);
  const authSchema = admin.escapeIdentifier(CODEXIA_AUTH_SCHEMA);
  let ownsAuthSchema = false;
  let provider;
  let setup;
  let bootstrap;
  const close = async () => {
    try {
      await Promise.all([closeServer(provider), closeServer(setup)]);
      await bootstrap?.close();
      if (ownsAuthSchema) {
        await admin.query(`DROP SCHEMA ${authSchema} CASCADE; DROP ROLE ${authRole}`);
      }
    } finally {
      await admin.end();
    }
  };

  try {
    // This transaction refuses an existing auth role or schema without modifying either.
    await admin.query('BEGIN');
    try {
      await admin.query(`CREATE ROLE ${authRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD ${admin.escapeLiteral(password)}`);
      await admin.query(`CREATE SCHEMA ${authSchema} AUTHORIZATION ${authRole}; REVOKE ALL ON SCHEMA ${authSchema} FROM PUBLIC`);
      await admin.query('COMMIT');
      ownsAuthSchema = true;
    } catch (error) {
      await admin.query('ROLLBACK');
      throw error;
    }

    provider = createServer(tls);
    setup = createServer(tls);
    const providerOrigin = await listenLoopback(provider, '127.0.0.1');
    const setupOrigin = await listenLoopback(setup, 'localhost');
    const idp = createIdp({ appOrigin: providerOrigin, setupOrigin });
    provider.on('request', (request, response) => {
      void idp(request, response, new URL(request.url, providerOrigin)).catch((error) => response.destroy(error));
    });
    const webClientId = 'codexia-hosted-smoke-web';
    const iosClientId = 'codexia-hosted-smoke-ios';
    const introspectionClientId = 'codexia-hosted-smoke-introspection';
    // Only the fixture IdP and the registration service need to accept connections.
    const publicOrigin = 'https://codexia-hosted-smoke.test';
    const config = {
      databaseUrl: authDatabase.href,
      publicOrigin,
      oidcIssuer: providerOrigin + '/idp',
      oidcClientId: clientId,
      oidcClientSecret: clientSecret,
      authSecret: randomBytes(32).toString('hex'),
      oauthIntrospectionClientId: introspectionClientId,
      oauthIntrospectionClientSecret: randomBytes(32).toString('hex'),
      ownerClientIds: [webClientId, iosClientId],
      mcpClientIds: [],
    };
    const previousCAs = getCACertificates('default');
    // Trust the ephemeral certificate for the package's OIDC discovery and callback.
    setDefaultCACertificates([...previousCAs, tls.cert]);
    let registration;
    try {
      await migrateBetterAuth(config);
      bootstrap = createBetterAuthBootstrap({ ...config, publicOrigin: setupOrigin, apiAudience: publicOrigin + '/api' }, {
        ownerOidcSubject: identity.sub,
        webRedirectUris: [`${publicOrigin}/desktop`, `${publicOrigin}/mobile`],
      });
      setup.on('request', bootstrap.listener);
      registration = await register({ appOrigin: providerOrigin, setupOrigin, ca: tls.cert });
    } finally {
      setDefaultCACertificates(previousCAs);
    }
    assert.deepEqual([registration.webClientId, registration.iosClientId, registration.introspectionClientId],
      [webClientId, iosClientId, introspectionClientId]);
    await closeServer(setup);
    await bootstrap.close();
    bootstrap = undefined;
    return {
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([name]) =>
          !/^(?:CODEXIA|SCRIPTORIUM)_(?:AUTH(?:_|$)|ACCESS(?:_|$)|OIDC(?:_|$)|OAUTH(?:_|$)|BROWSER_AUTH$|PUBLIC_ORIGIN$|TRUST_PROXY$|API_AUDIENCE$)/u.test(name))),
        CODEXIA_AUTH_MODE: 'better-auth',
        CODEXIA_AUTH_DATABASE_URL: config.databaseUrl,
        CODEXIA_PUBLIC_ORIGIN: config.publicOrigin,
        CODEXIA_OIDC_ISSUER: config.oidcIssuer,
        CODEXIA_OIDC_CLIENT_ID: config.oidcClientId,
        CODEXIA_OIDC_CLIENT_SECRET: config.oidcClientSecret,
        CODEXIA_AUTH_SECRET: config.authSecret,
        CODEXIA_OAUTH_INTROSPECTION_CLIENT_ID: config.oauthIntrospectionClientId,
        CODEXIA_OAUTH_INTROSPECTION_CLIENT_SECRET: config.oauthIntrospectionClientSecret,
        CODEXIA_OAUTH_OWNER_SUBJECT: registration.ownerSubject,
        CODEXIA_OAUTH_OWNER_CLIENT_IDS: config.ownerClientIds.join(','),
        NODE_EXTRA_CA_CERTS: certPath,
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
