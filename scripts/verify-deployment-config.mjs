#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFile(path.join(root, relative), 'utf8');
const workerConfig = JSON.parse(await read('edge/frontend/wrangler.jsonc'));
const edgePackage = JSON.parse(await read('edge/frontend/package.json'));
const edgeLock = JSON.parse(await read('edge/frontend/package-lock.json'));
const uiRoutes = JSON.parse(await read('deploy/cloudflare/ui-routes.json'));
const [staticHeaders, staticRedirects, apiSource, apiClient, terraformMain, terraformVariables, apiQuadlet, databaseQuadlet, databaseNetwork, databaseVolume, tunnelQuadlet, backendDockerfile, deploymentDocs] = await Promise.all([
  read('edge/frontend/static/_headers'),
  read('edge/frontend/static/_redirects'),
  read('packages/api/src/server.ts'),
  read('app/src/api.ts'),
  read('deploy/cloudflare/terraform/main.tf'),
  read('deploy/cloudflare/terraform/variables.tf'),
  read('deploy/quadlet/codexia-api.container'),
  read('deploy/quadlet/codexia-db.container'),
  read('deploy/quadlet/codexia-data.network'),
  read('deploy/quadlet/codexia-postgres.volume'),
  read('deploy/quadlet/codexia-tunnel.container'),
  read('Dockerfile.backend'),
  read('docs/deployment/README.md'),
]);

assert.equal(workerConfig.name, 'codexia-frontend');
assert.equal(edgePackage.devDependencies.wrangler, '4.162.0');
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
assert.match(terraformVariables, /condition\s*=\s*contains\(\["http:\/\/codexia-api:3000", "http:\/\/codexia-api-proxy:3000"\], var\.origin_service\)/u);

assert.match(apiSource, /style-src-attr 'unsafe-inline'/u);
assert.ok(apiClient.includes('"/api/login"'), 'the UI API client must keep using same-origin API paths');
assert.doesNotMatch(apiClient, /VITE_API_URL/u, 'the frontend API origin is same-origin and must not be injected at build time');
assert.match(apiSource, /normalizeCorsOrigins/u, 'cross-origin browser access requires normalized exact HTTPS origins');
assert.match(apiSource, /corsAllowedOrigins\.has\(originHeader\)/u, 'cross-origin API requests must match the configured exact origin');
assert.match(apiSource, /CODEXIA_CORS_ALLOWED_ORIGINS/u, 'cross-origin browser access must remain deploy-time opt-in');
assert.doesNotMatch(apiSource, /Access-Control-Allow-Credentials/u, 'the API must not enable credentialed CORS');
assert.doesNotMatch(apiSource, /Access-Control-Allow-Origin[^\n]*\*/u, 'the API must not grant wildcard CORS');
assert.match(apiSource, /sameOrigin\(request, trustProxy\)/u);

assert.match(apiQuadlet, /Image=ghcr\.io\/yohn-jp\/codexia-backend:sha-/u);
assert.match(apiQuadlet, /CODEXIA_AUTH_TOKEN_FILE=\/run\/secrets\/codexia-auth-token/u);
assert.doesNotMatch(apiQuadlet, /GITHUB_TOKEN|github-token/u, "PostgreSQL authoring does not mount Git credentials");
assert.match(apiQuadlet, /CODEXIA_DATABASE_PASSWORD_FILE=\/run\/secrets\/app-password/u);
assert.match(apiSource, /CODEXIA_DATABASE_URL is required for Codexia authoring/u, "PostgreSQL startup is always required");
assert.match(apiQuadlet, /CODEXIA_DATABASE_MIGRATE_ON_START=1/u);
assert.match(apiQuadlet, /Requires=codexia-db\.service/u);
assert.match(apiQuadlet, /Network=codexia-data\.network/u);
assert.match(apiQuadlet, /HealthCmd=.*\/health\/ready/u);
assert.match(apiQuadlet, /Network=codexia\.network/u);
assert.doesNotMatch(apiQuadlet, /^PublishPort=/mu, 'the API must not publish a host port');
const postgresImage = 'docker.io/library/postgres:17-bookworm@sha256:40865bc877a289da75963d97d72b59633f639fc5af7a4e856bfa3714cae5b536';
assert.ok(databaseQuadlet.split('\n').includes(`Image=${postgresImage}`), 'the live database image pin must remain the reviewed PostgreSQL digest');
assert.ok((await read('Dockerfile')).includes(`ARG POSTGRES_IMAGE=${postgresImage}`), 'the PostgreSQL smoke-test image must match the live database pin');
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
assert.match(tunnelQuadlet, /^Requires=codexia-api\.service$/mu, 'the initial Tunnel dependency stays with the legacy API');
assert.match(tunnelQuadlet, /^After=network-online\.target codexia-api\.service$/mu, 'the initial Tunnel dependency preserves network ordering');
assert.match(tunnelQuadlet, /PublishPort=127\.0\.0\.1:2000:2000\/tcp/u, 'Tunnel metrics must bind to host loopback only');
assert.doesNotMatch(tunnelQuadlet, /^PublishPort=(?!127\.0\.0\.1:2000:2000\/tcp)/mu, 'the Tunnel must not publish a public host port');
assert.match(backendDockerfile, /--server-only/u);
assert.match(deploymentDocs, /pg_dump/u);
assert.match(deploymentDocs, /codexia-db\.service/u);
assert.match(deploymentDocs, /codexia-postgres/u);
assert.match(deploymentDocs, /VITE_API_URL/u);
assert.match(deploymentDocs, /CORS/u);
assert.match(deploymentDocs, /restore/u);
assert.match(deploymentDocs, /127\.0\.0\.1:2000\/ready/u);


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
assert.ok(!uiRoutes.originRoutes.some(pattern => identityProbes.frontend.path.startsWith(pattern.replace(/\*$/u, ''))));
assert.match(terraformMain, /identity-probes\.json/u);
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
const release = await read('.github/workflows/frontend-release.yml');
const preflight = await read('.github/workflows/production-preflight.yml');
assert.match(release, /needs: \[source, preflight, build\]/u);
assert.match(release, /workflow_run:[\s\S]*?types: \[completed\]/u);
assert.match(release, /release-source-gate\.mjs frontend/u);
assert.doesNotMatch(release, /timeout-minutes: 70/u, 'Frontend release must not reserve a runner while waiting for Verify');
const preflightJob = release.split('  preflight:\n')[1].split('  build:\n')[0];
const deployJob = release.split('  deploy:\n')[1];
assert.match(preflightJob, /environment: codexia-production/u);
assert.match(preflightJob, /verify-frontend-compatibility\.mjs preflight/u);
assert.doesNotMatch(preflightJob, /uses: \.\/\.github\/workflows\//u, 'Production preflight must obtain secrets directly from the production environment');
for (const key of ['CODEXIA_ACCESS_CLIENT_ID', 'CODEXIA_ACCESS_CLIENT_SECRET']) {
  const binding = key + ': ${{ secrets.' + key + ' }}';
  assert.ok(preflightJob.includes(binding) && deployJob.includes(binding) && preflight.includes(binding), 'All production probes must use the same credential binding: ' + key);
}
assert.doesNotMatch(preflightJob, /CLOUDFLARE_API_TOKEN|wrangler deploy|terraform apply/u);
assert.match(preflight, /verify-frontend-compatibility\.mjs preflight/u);
assert.doesNotMatch(preflight, /CLOUDFLARE_API_TOKEN|wrangler deploy|terraform apply/u);

console.info('Deployment configuration is consistent: UI/API routes, same-origin auth, Worker assets, GHCR Quadlet and secret mounts.');

