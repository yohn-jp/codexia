#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { operations } from '../../../app/src/generated/http/client.operations.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (relative) => readFile(path.join(root, relative), 'utf8');
const workerConfig = JSON.parse(await read('edge/frontend/wrangler.jsonc'));
const edgePackage = JSON.parse(await read('edge/frontend/package.json'));
const edgeLock = JSON.parse(await read('edge/frontend/package-lock.json'));
const uiRoutes = JSON.parse(await read('deploy/cloudflare/ui-routes.json'));
const publicProtocolPaths = JSON.parse(await read('deploy/cloudflare/public-protocol-paths.json'));
const [staticHeaders, staticRedirects, apiSource, apiClient, terraformMain, terraformVariables, apiQuadlet, databaseQuadlet, databaseNetwork, databaseVolume, tunnelQuadlet, backendDockerfile, deploymentDocs, pushDeploymentDocs, iacDocs, ansibleDocs, backupDocs] = await Promise.all([
  read('edge/frontend/static/_headers'),
  read('edge/frontend/static/_redirects'),
  read('packages/api/src/server.ts'),
  read('app/src/api-transport.ts'),
  read('deploy/cloudflare/terraform/main.tf'),
  read('deploy/cloudflare/terraform/variables.tf'),
  read('deploy/quadlet/codexia-api.container'),
  read('deploy/quadlet/codexia-db.container'),
  read('deploy/quadlet/codexia-data.network'),
  read('deploy/quadlet/codexia-postgres.volume'),
  read('deploy/quadlet/codexia-tunnel.container'),
  read('Dockerfile.backend'),
  read('docs/deployment/DEPLOYMENT-REFERENCE.sdoc'),
  read('docs/deployment/PUSH-DEPLOYMENT.sdoc'),
  read('docs/deployment/IAC.sdoc'),
  read('docs/deployment/ANSIBLE-PUSH-DEPLOYMENT.sdoc'),
  read('docs/deployment/BACKUP.sdoc'),
]);
const [terraformProviderLock, terraformWorkflow, terraformExample] = await Promise.all([
  read('deploy/cloudflare/terraform/.terraform.lock.hcl'),
  read('.github/workflows/deployment-config.yml'),
  read('deploy/cloudflare/terraform/terraform.tfvars.example'),
]);

assert.equal(workerConfig.name, 'codexia-frontend');
assert.match(edgePackage.devDependencies.wrangler, /^\d+\.\d+\.\d+$/u, 'Wrangler must have an exact version pin');
assert.equal(edgeLock.packages['node_modules/wrangler'].version, edgePackage.devDependencies.wrangler);
assert.equal(workerConfig.$schema, './node_modules/wrangler/config-schema.json');
assert.equal(workerConfig.workers_dev, false, 'workers.dev must stay disabled');
assert.equal(workerConfig.preview_urls, false, 'Worker preview URLs must stay disabled');
assert.equal(workerConfig.assets.directory, '../../app/dist');
assert.equal(workerConfig.main, undefined, 'Static frontend must not execute Worker code');
assert.equal(workerConfig.assets.binding, undefined);
assert.equal(workerConfig.assets.run_worker_first, undefined);
assert.equal(workerConfig.assets.html_handling, 'none');
assert.equal(workerConfig.assets.not_found_handling, 'none');
assert.deepEqual(uiRoutes.routes, ['/*']);
assert.deepEqual(uiRoutes.originRoutes, ['/api*', '/health*', '/mcp*', '/.well-known/*']);
assert.equal(uiRoutes.apiPrefix, '/api/');
assert.match(staticHeaders, /script-src 'self';/u);
assert.match(staticHeaders, /style-src 'self' 'unsafe-inline';/u);
assert.match(staticHeaders, /X-Frame-Options: DENY/u);
assert.match(staticHeaders, /X-Robots-Tag: noindex, nofollow/u);
assert.ok(staticRedirects.split('\n').includes('/ /index.html 200'));
assert.ok(staticRedirects.split('\n').every(line => !['/api','/health','/mcp','/assets'].some(prefix => line.startsWith(prefix))));
assert.match(terraformMain, /jsondecode\(file\("\$\{path\.module\}\/\.\.\/ui-routes\.json"\)\)\.routes/u);
assert.match(terraformMain, /pattern\s+=\s+"\$\{var\.app_hostname\}\$\{each\.value\}"/u);
assert.match(terraformMain, /service\s+=\s+var\.origin_service/u);
assert.match(terraformMain, /required\s+=\s+true/u);
assert.match(terraformMain, /originRoutes/u);
assert.match(terraformVariables, /condition\s*=\s*var\.origin_service\s*==\s*"http:\/\/codexia-api:3000"/u);
assert.doesNotMatch(terraformVariables, /codexia-api-proxy/u, "retired proxy ingress must not be an accepted origin");

assert.equal(operations.apiSessionGet.path, '/api/session', 'the UI API client must keep using same-origin API paths');
assert.doesNotMatch(apiClient, /VITE_API_URL/u, 'the frontend API origin is same-origin and must not be injected at build time');
assert.match(apiSource, /CODEXIA_CORS_ALLOWED_ORIGINS/u, 'cross-origin browser access must remain deploy-time opt-in');

assert.match(apiQuadlet, /^Image=CODEXIA_BACKEND_IMAGE$/mu);
assert.match(apiQuadlet, /^Secret=codexia-auth-database-url,type=env,target=CODEXIA_AUTH_DATABASE_URL$/mu);
assert.doesNotMatch(apiQuadlet, /CODEXIA_AUTH_TOKEN|codexia-auth-token/u);
assert.doesNotMatch(apiQuadlet, /GITHUB_TOKEN|github-token/u, "PostgreSQL authoring does not mount Git credentials");
assert.match(apiQuadlet, /CODEXIA_DATABASE_PASSWORD_FILE=\/run\/secrets\/app-password/u);
assert.match(apiSource, /CODEXIA_DATABASE_URL is required for Codexia authoring/u, "PostgreSQL startup is always required");
assert.match(apiQuadlet, /^Environment=CODEXIA_DATABASE_MIGRATE_ON_START=0$/mu);
assert.match(apiQuadlet, /^Environment=CODEXIA_PROFILE=CODEXIA_BACKEND_PROFILE$/mu);
assert.match(apiQuadlet, /Requires=codexia-db\.service/u);
assert.match(apiQuadlet, /Network=codexia-data\.network/u);
assert.match(apiQuadlet, /HealthCmd=.*\/health\/ready/u);
assert.match(apiQuadlet, /Network=codexia\.network/u);
assert.doesNotMatch(apiQuadlet, /^PublishPort=/mu, 'the API must not publish a host port');
const databaseImage = /^Image=(\S+)$/mu.exec(databaseQuadlet)?.[1];
assert.match(databaseImage ?? '', /^docker\.io\/library\/postgres:17-bookworm@sha256:[0-9a-f]{64}$/u,
  'the live database must use an immutable official PostgreSQL 17 image');
const backendSmoke = await read('scripts/verification/runtime/backend-image.sh');
const backendSmokeImage = /^database_image="([^"\r\n]+)"$/mu.exec(backendSmoke)?.[1];
assert.equal(backendSmokeImage, databaseImage, 'the backend image smoke test and database Quadlet must pin the same image');
assert.match(backendSmoke, /^[\t ]+"\$database_image" >\/dev\/null$/mu,
  'the backend image smoke test must run its pinned database image');
const ociSmokeImage = /^[\t ]+(docker\.io\/library\/postgres:\S+)$/mu.exec(await read('scripts/verification/runtime/oci.sh'))?.[1];
assert.equal(ociSmokeImage, databaseImage, 'the OCI smoke test and database Quadlet must pin the same image');
assert.match(databaseQuadlet, /Network=codexia-data\.network/u);
assert.match(databaseQuadlet, /Volume=codexia-postgres\.volume:\/var\/lib\/postgresql\/data/u);
assert.match(databaseQuadlet, /POSTGRES_USER=codexia_admin/u);
assert.match(databaseQuadlet, /POSTGRES_PASSWORD_FILE=\/run\/secrets\/admin-password/u);
assert.match(databaseQuadlet, /\/etc\/codexia\/postgres\/010-create-app-role\.sh:\/docker-entrypoint-initdb\.d\/010-create-app-role\.sh:ro,Z/u);
assert.match(databaseQuadlet, /codexia-postgres-app-password/u);
assert.doesNotMatch(databaseQuadlet, /^PublishPort=/mu, 'PostgreSQL must not publish a host port');
assert.match(await read('deploy/postgres/010-create-app-role.sh'), /CREATE ROLE codexia LOGIN/u);
assert.match(await read('deploy/postgres/010-create-app-role.sh'), /ALTER DATABASE codexia OWNER TO codexia/u);
assert.match(databaseQuadlet, /HealthCmd=pg_isready -U codexia -d codexia/u);
assert.match(databaseNetwork, /Internal=true/u, 'PostgreSQL must be isolated from the Tunnel network');
assert.match(databaseVolume, /VolumeName=codexia-postgres/u);
assert.ok(tunnelQuadlet.split('\n').includes('Image=docker.io/cloudflare/cloudflared@sha256:b94b96edf2c9c4360f8879c8580cfaa99077f19c849ec595ca2f711b27d4f344'), 'Tunnel image must use the reviewed Cloudflare digest');
assert.match(tunnelQuadlet, /Secret=codexia-tunnel-token/u);
assert.match(tunnelQuadlet, /Network=codexia\.network/u);
assert.doesNotMatch(tunnelQuadlet, /^Network=codexia-data\.network$/mu, 'the Tunnel must not join the PostgreSQL network');
assert.match(tunnelQuadlet, /^Requires=codexia-api\.service$/mu, 'the Tunnel dependency stays with the canonical API');
assert.match(tunnelQuadlet, /^After=network-online\.target codexia-api\.service$/mu, 'the initial Tunnel dependency preserves network ordering');
assert.match(tunnelQuadlet, /PublishPort=127\.0\.0\.1:2000:2000\/tcp/u, 'Tunnel metrics must bind to host loopback only');
assert.doesNotMatch(tunnelQuadlet, /^PublishPort=(?!127\.0\.0\.1:2000:2000\/tcp)/mu, 'the Tunnel must not publish a public host port');
assert.match(backendDockerfile, /--server-only/u);
assert.match(deploymentDocs, /\]\(BACKUP\.md#受入シナリオ\)/u,
  'The deployment overview must link the canonical recovery acceptance');
assert.match(deploymentDocs, /\]\(\.\.\/\.\.\/deploy\/backup\/CONSOLE\.md\)/u,
  'The deployment overview must link operator backup provisioning');
assert.match(deploymentDocs, /codexia-db\.service/u);
assert.match(deploymentDocs, /codexia-postgres/u);
assert.match(deploymentDocs, /VITE_API_URL/u);
assert.match(deploymentDocs, /CORS/u);
assert.match(deploymentDocs, /127\.0\.0\.1:2000\/ready/u);
const operationsDocs = [deploymentDocs, pushDeploymentDocs, iacDocs, ansibleDocs, backupDocs].join('\n');
assert.ok(pushDeploymentDocs.includes('](PRODUCTION-BOOTSTRAP.md)') && pushDeploymentDocs.includes('`preflight_run_id`'),
  'The first activation runbook must use protected Bootstrap and the reviewed Preflight run');
assert.match(operationsDocs, /codexia_initial_install_approved=true/u);
assert.match(operationsDocs, /codexia_database_initialization_approved=true/u);
assert.match(operationsDocs, /CODEXIA_INITIAL_INSTALL_APPROVED=true/u);
assert.match(operationsDocs, /CODEXIA_DATABASE_INITIALIZATION_APPROVED=true/u);
assert.match(operationsDocs, /auth-runtime.*before.*deploy/u);
assert.match(pushDeploymentDocs, /\]\(BACKUP\.md#verify-a-candidate-ledger-on-a-restored-backup\)/u,
  'The push deployment runbook must link the isolated restore verification');
assert.match(operationsDocs, /migration fingerprint, API epoch, and persistence format/u);
assert.match(deploymentDocs, /CODEXIA_DATABASE_MIGRATE_ON_START=0/u);
assert.doesNotMatch(deploymentDocs, /CODEXIA_DATABASE_MIGRATE_ON_START=1/u);


const identityProbes = JSON.parse(await read('deploy/cloudflare/identity-probes.json'));
assert.deepEqual(Object.keys(identityProbes), ['backend', 'frontend']);
assert.equal(identityProbes.backend.path, '/api/version');
assert.equal(identityProbes.frontend.path, '/desktop/update-identity.json');
for (const probe of Object.values(identityProbes)) {
  assert.equal(probe.tunnelPath, '^' + probe.path.replaceAll('.', '\\.') + '$');
  const matcher = new RegExp(probe.tunnelPath, 'u');
  assert.ok(matcher.test(probe.path));
  assert.ok(!matcher.test(probe.path + '/other'));
}
assert.ok(uiRoutes.originRoutes.includes('/api*'));
assert.ok(uiRoutes.originRoutes.includes('/mcp*'));
assert.ok(uiRoutes.originRoutes.includes('/.well-known/*'));
assert.ok(!uiRoutes.originRoutes.some(pattern => identityProbes.frontend.path.startsWith(pattern.replace(/\*$/u, ''))));
assert.match(terraformMain, /identity-probes\.json/u);
assert.match(terraformMain, /public-protocol-paths\.json/u);
assert.match(terraformMain, /domain\s+=\s+"\$\{var\.app_hostname\}\$\{each\.value\.path\}"/u);
const parentAccess = terraformMain.split('resource "cloudflare_zero_trust_access_application" "codexia"')[1].split('resource "cloudflare_zero_trust_access_application" "identity_probe"')[0];
assert.doesNotMatch(parentAccess, /access_ci_policy_id/u, 'CI Service Auth must never be attached to the author app');
const probeAccess = terraformMain.split('resource "cloudflare_zero_trust_access_application" "identity_probe"')[1].split('resource "cloudflare_zero_trust_tunnel_cloudflared"')[0];
assert.match(probeAccess, /app_launcher_visible\s*=\s*false/u);
assert.match(probeAccess, /id\s+=\s+var\.access_ci_policy_id\s+precedence\s+=\s+1/u);
assert.match(probeAccess, /id\s+=\s+var\.access_policy_id\s+precedence\s+=\s+2/u);
assert.match(terraformMain, /path\s+=\s+probe\.tunnelPath/u);
const ingress = terraformMain.split('ingress = concat(')[1].split('# Scriptless exclusions')[0];
assert.match(ingress, /for key, probe in local\.identity_probes[\s\S]*?aud_tag = \[\s*cloudflare_zero_trust_access_application\.identity_probe\[key\]\.aud,\s*cloudflare_zero_trust_access_application\.codexia\.aud\s*\][\s\S]*?aud_tag\s+=\s+\[cloudflare_zero_trust_access_application\.codexia\.aud\][\s\S]*?http_status:404/u);
assert.match(terraformVariables, /variable "access_ci_policy_id"/u);
const publicEndpointPaths = Object.fromEntries(Object.entries(publicProtocolPaths).map(([key, endpoint]) => [key, endpoint.path]));
assert.deepEqual(publicEndpointPaths, {
  mcp: '/mcp',
  protected_resource_metadata: '/.well-known/oauth-protected-resource/api',
  authorization_server_metadata: '/.well-known/oauth-authorization-server/api/auth',
  openid_configuration: '/.well-known/openid-configuration/api/auth',
  oauth_authorize: '/api/auth/oauth2/authorize',
  oauth_token: '/api/auth/oauth2/token',
  oauth_introspect: '/api/auth/oauth2/introspect',
  oauth_revoke: '/api/auth/oauth2/revoke',
  oauth_userinfo: '/api/auth/oauth2/userinfo',
  oauth_consent: '/api/auth/oauth2/consent',
  oauth_consent_context: '/api/auth/oauth2/consent-context',
  oauth_jwks: '/api/auth/jwks',
  oauth_auth_methods: '/api/auth/codexia/auth-methods',
  auth_session: '/api/auth/get-session',
  passkey_authentication_options: '/api/auth/passkey/generate-authenticate-options',
  passkey_authentication_verify: '/api/auth/passkey/verify-authentication',
  oidc_sign_in: '/api/auth/sign-in/social',
  oidc_callback: '/api/auth/callback/workspace-oidc',
  sso_sign_in: '/api/auth/sign-in/sso',
  sso_callback: '/api/auth/sso/callback/codexia-owner-oidc',
  oauth_login_page: '/oauth/login',
  oauth_consent_page: '/oauth/consent',
  oauth_static_assets: '/oauth/assets/*',
});
for (const endpoint of Object.values(publicProtocolPaths)) {
  assert.equal(typeof endpoint.name, 'string');
  assert.ok(endpoint.name.startsWith('Codexia '));
  if (endpoint.tunnelPath !== null) {
    assert.equal(endpoint.tunnelPath.startsWith('^') && endpoint.tunnelPath.endsWith('$'), true,
      `${endpoint.path} must be an exact Tunnel ingress match`);
    const matcher = new RegExp(endpoint.tunnelPath, 'u');
    assert.ok(matcher.test(endpoint.path), `${endpoint.path} must match its Tunnel rule`);
    assert.ok(!matcher.test(endpoint.path + '/unexpected'), `${endpoint.path} must not admit nested routes`);
  }
}
assert.deepEqual(Object.values(publicProtocolPaths).filter((endpoint) => endpoint.tunnelPath === null).map((endpoint) => endpoint.path),
  ['/oauth/login', '/oauth/consent', '/oauth/assets/*'],
  'only the dedicated OAuth pages and their isolated static asset prefix bypass Access outside the Tunnel');
assert.ok(!Object.values(publicProtocolPaths).some((endpoint) => endpoint.path === '/assets/*'),
  'the generic UI asset bundle must remain under the parent Access boundary');
assert.ok(Object.values(publicProtocolPaths).filter((endpoint) => endpoint.tunnelPath === null)
  .every((endpoint) => !uiRoutes.originRoutes.some((route) => endpoint.path.startsWith(route.replace(/\*$/u, '')))),
  'static OAuth pages and assets must continue to be served by the existing static Worker route');
assert.deepEqual(Object.values(publicProtocolPaths).filter((endpoint) => endpoint.path.startsWith('/api/auth/passkey/')).map((endpoint) => endpoint.path), [
  '/api/auth/passkey/generate-authenticate-options',
  '/api/auth/passkey/verify-authentication',
], 'only unauthenticated Passkey sign-in endpoints may be exposed');
assert.ok(!Object.values(publicProtocolPaths).some((endpoint) => /(?:registration|register|admin|provider|passkey\/(?:add|list|update|delete))/u.test(endpoint.path)),
  'OAuth client registration, admin, provider management, and Passkey management stay behind the author boundary');
assert.match(terraformVariables, /variable "public_oauth_edge_enabled"[\s\S]*?default\s+=\s+false/u,
  'public protocol edge access must be disabled by default');
assert.match(terraformVariables, /variable "passkey_oauth_runtime_ready"[\s\S]*?default\s+=\s+false/u,
  'Better Auth runtime readiness must require explicit operator confirmation');
assert.match(terraformExample, /^public_oauth_edge_enabled\s+=\s+false$/mu);
assert.match(terraformExample, /^passkey_oauth_runtime_ready\s+=\s+false$/mu);
assert.match(terraformProviderLock, /provider "registry\.terraform\.io\/cloudflare\/cloudflare"\s*\{\s*version\s+=\s+"5\.29\.0"/u,
  'Cloudflare Terraform provider version must remain locked to the schema tested here');
assert.match(terraformWorkflow, /terraform-provider-cloudflare\/releases\/assets\/737220880/u);
assert.match(terraformWorkflow, /800cf3c99cb3a40132eb73295cea67b99b8133162e464de58775332854b41a41/u);
assert.match(terraformWorkflow, /cloudflare\/cloudflare\/5\.29\.0\/linux_amd64/u,
  'The official release-asset fallback must match the locked provider version');
assert.doesNotMatch(terraformWorkflow, /5\.24\.0|528010301/u);
assert.match(terraformMain, /resource "terraform_data" "public_oauth_edge_readiness"[\s\S]*?precondition[\s\S]*?condition\s+=\s+var\.passkey_oauth_runtime_ready/u);
const publicAccess = terraformMain.split('resource "cloudflare_zero_trust_access_application" "public_protocol"')[1];
assert.match(publicAccess, /for_each\s+=\s+local\.public_access_paths/u);
assert.match(publicAccess, /domain\s+=\s+"\$\{var\.app_hostname\}\$\{each\.value\.path\}"/u);
assert.match(publicAccess, /decision\s+=\s+"bypass"/u);
assert.match(publicAccess, /everyone\s*=\s*\{\}/u);
assert.match(publicAccess, /app_launcher_visible\s+=\s+false/u);
assert.match(publicAccess, /cloudflare_zero_trust_tunnel_cloudflared_config\.codexia/u,
  'Access path bypass is applied only after exact Tunnel routing is staged');
const publicIngress = terraformMain.split('for _, endpoint in local.public_tunnel_paths')[1].split('for key, probe in local.identity_probes')[0];
assert.match(publicIngress, /path\s+=\s+endpoint\.tunnelPath/u);
assert.doesNotMatch(publicIngress, /access\s*=/u, 'public protocol ingress must not require an Access JWT at the origin');
assert.match(terraformMain, /public_tunnel_paths\s*=\s*\{[\s\S]*?if endpoint\.tunnelPath != null/u,
  'static OAuth pages and assets must receive Access overrides without Tunnel ingress entries');
assert.match(ingress, /access\s*=\s*\{\s*required\s+=\s+true/u,
  'identity probes and the catch-all must keep Tunnel Access JWT validation');
assert.match(terraformMain, /resource "cloudflare_zero_trust_access_application" "public_protocol"[\s\S]*?cloudflare_zero_trust_tunnel_cloudflared_config\.codexia/u,
  'Tunnel Access validation is staged before removing public protocol app Bypass on rollback');
const release = await read('.github/workflows/frontend-release.yml');
const preflight = await read('.github/workflows/production-preflight.yml');
assert.match(release, /needs: \[source, preflight, build\]/u);
assert.match(release, /workflow_run:[\s\S]*?types: \[completed\]/u);
assert.match(release, /source-gate\.mjs frontend/u);
assert.doesNotMatch(release, /timeout-minutes: 70/u, 'Frontend release must not reserve a runner while waiting for Verify');
const preflightJob = release.split('  preflight:\n')[1].split('  build:\n')[0];
const deployJob = release.split('  deploy:\n')[1];
assert.match(preflightJob, /environment: codexia-production/u);
assert.match(preflightJob, /verify-compatibility\.mjs preflight/u);
assert.doesNotMatch(preflightJob, /uses: \.\/\.github\/workflows\//u, 'Production preflight must obtain secrets directly from the production environment');
for (const key of ['CODEXIA_ACCESS_CLIENT_ID', 'CODEXIA_ACCESS_CLIENT_SECRET']) {
  const binding = key + ': ${{ secrets.' + key + ' }}';
  assert.ok(preflightJob.includes(binding) && deployJob.includes(binding) && preflight.includes(binding), 'All production probes must use the same credential binding: ' + key);
}
assert.doesNotMatch(preflightJob, /CLOUDFLARE_API_TOKEN|wrangler deploy|terraform apply/u);
assert.match(preflight, /verify-compatibility\.mjs preflight/u);
assert.doesNotMatch(preflight, /CLOUDFLARE_API_TOKEN|wrangler deploy|terraform apply/u);

console.info('Deployment configuration is consistent: UI/API routes, same-origin auth, Worker assets, GHCR Quadlet and secret mounts.');

