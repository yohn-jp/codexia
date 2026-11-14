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
assert.equal(edgePackage.devDependencies.wrangler, '4.158.0');
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
assert.match(staticRedirects, /^\\/ \\/index\\.html 200$/mu);
assert.doesNotMatch(staticRedirects, /^\\/(?:api|health|mcp|assets)(?:[ /]|$)/mu);
assert.match(terraformMain, /jsondecode\(file\("\$\{path\.module\}\/\.\.\/ui-routes\.json"\)\)\.routes/u);
assert.match(terraformMain, /pattern\s+=\s+"\$\{var\.app_hostname\}\$\{each\.value\}"/u);
assert.match(terraformMain, /service\s+=\s+var\.origin_service/u);
assert.match(terraformMain, /required\s+=\s+true/u);
assert.match(terraformMain, /originRoutes/u);
assert.match(terraformVariables, /http:\/\/codexia-api:3000/u);

assert.match(apiSource, /style-src-attr 'unsafe-inline'/u);
assert.ok(apiClient.includes('"/api/login"'), 'the UI API client must keep using same-origin API paths');
assert.doesNotMatch(apiClient, /VITE_API_URL/u, 'the frontend API origin is same-origin and must not be injected at build time');
assert.doesNotMatch(apiSource, /Access-Control-Allow-Origin/u, 'the API must not grant cross-origin browser access');
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
assert.match(databaseQuadlet, /Image=docker\.io\/library\/postgres:17-bookworm@sha256:[a-f0-9]{64}/u);
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
assert.match(tunnelQuadlet, /Secret=codexia-tunnel-token/u);
assert.match(tunnelQuadlet, /Network=codexia\.network/u);
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

console.info('Deployment configuration is consistent: UI/API routes, same-origin auth, Worker assets, GHCR Quadlet and secret mounts.');

