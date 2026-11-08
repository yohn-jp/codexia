#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFile(path.join(root, relative), 'utf8');
const workerConfig = JSON.parse(await read('edge/frontend/wrangler.jsonc'));
const edgePackage = JSON.parse(await read('edge/frontend/package.json'));
const edgeLock = JSON.parse(await read('edge/frontend/package-lock.json'));
const uiRoutes = JSON.parse(await read('deploy/cloudflare/ui-routes.json'));
const publicFiles = await listFiles('app/public');
const [workerSource, apiSource, apiClient, terraformMain, terraformVariables, apiQuadlet, tunnelQuadlet, backendDockerfile, deploymentDocs] = await Promise.all([
  read('edge/frontend/src/index.ts'),
  read('packages/api/src/server.ts'),
  read('app/src/api.ts'),
  read('deploy/cloudflare/terraform/main.tf'),
  read('deploy/cloudflare/terraform/variables.tf'),
  read('deploy/quadlet/codexia-api.container'),
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
assert.equal(workerConfig.assets.binding, 'ASSETS');
assert.equal(workerConfig.assets.not_found_handling, 'none');
assert.deepEqual(uiRoutes.routes, ['/', '/index.html*', '/assets/*', '/desktop*', '/mobile*', '/r/*']);
assert.equal(uiRoutes.apiPrefix, '/api/');
assert.ok(uiRoutes.routes.every((route) => route.startsWith('/')));
assert.ok(uiRoutes.routes.every((route) => route !== '/*' && !route.includes(uiRoutes.apiPrefix)));
for (const file of publicFiles.filter((item) => path.posix.basename(item) !== '_headers')) {
  const assetPath = `/${file}`;
  assert.ok(uiRoutes.routes.some((route) => route === assetPath || (route.endsWith('*') && assetPath.startsWith(route.slice(0, -1)))),
    `Static public asset ${assetPath} needs an explicit Worker Route`);
}
assert.equal(workerConfig.assets.run_worker_first.includes('!/assets/*'), true);
assert.equal(workerConfig.assets.run_worker_first.includes('!/desktop/assets/*'), true);
assert.equal(workerConfig.assets.run_worker_first.includes('!/mobile/assets/*'), true);
assert.ok(!workerConfig.assets.run_worker_first.some((route) => route.includes('/api')));
assert.match(terraformMain, /jsondecode\(file\("\$\{path\.module\}\/\.\.\/ui-routes\.json"\)\)\.routes/u);
assert.match(terraformMain, /pattern\s+=\s+"\$\{var\.app_hostname\}\$\{each\.value\}"/u);
assert.match(terraformMain, /service\s+=\s+var\.origin_service/u);
assert.match(terraformMain, /required\s+=\s+true/u);
assert.match(terraformVariables, /http:\/\/codexia-api:3000/u);

assert.match(workerSource, /Content-Security-Policy/u);
assert.match(workerSource, /__CODEXIA_STYLE_NONCE__/u);
assert.match(workerSource, /env\.ASSETS\.fetch/u);
assert.doesNotMatch(workerSource, /(?<!ASSETS\.)fetch\(request\)/u, 'the UI Worker must not proxy requests to the origin');
assert.ok(apiClient.includes('"/api/login"'), 'the UI API client must keep using same-origin API paths');
assert.doesNotMatch(apiClient, /VITE_API_URL/u, 'the frontend API origin is same-origin and must not be injected at build time');
assert.doesNotMatch(apiSource, /Access-Control-Allow-Origin/u, 'the API must not grant cross-origin browser access');
assert.match(apiSource, /sameOrigin\(request, trustProxy\)/u);

assert.match(apiQuadlet, /Image=ghcr\.io\/yohn-jp\/codexia-backend:sha-/u);
assert.match(apiQuadlet, /CODEXIA_AUTH_TOKEN_FILE=\/run\/secrets\/codexia-auth-token/u);
assert.match(apiQuadlet, /CODEXIA_GITHUB_TOKEN_FILE=\/run\/secrets\/codexia-github-token/u);
assert.match(apiQuadlet, /HealthCmd=.*\/health\/ready/u);
assert.match(apiQuadlet, /Network=codexia\.network/u);
assert.doesNotMatch(apiQuadlet, /^PublishPort=/mu, 'the API must not publish a host port');
assert.match(tunnelQuadlet, /Secret=codexia-tunnel-token/u);
assert.match(tunnelQuadlet, /Network=codexia\.network/u);
assert.match(tunnelQuadlet, /PublishPort=127\.0\.0\.1:2000:2000\/tcp/u, 'Tunnel metrics must bind to host loopback only');
assert.doesNotMatch(tunnelQuadlet, /^PublishPort=(?!127\.0\.0\.1:2000:2000\/tcp)/mu, 'the Tunnel must not publish a public host port');
assert.match(backendDockerfile, /--server-only/u);
assert.match(deploymentDocs, /pg_dump/u);
assert.match(deploymentDocs, /VITE_API_URL/u);
assert.match(deploymentDocs, /CORS/u);
assert.match(deploymentDocs, /restore/u);
assert.match(deploymentDocs, /127\.0\.0\.1:2000\/ready/u);

console.info('Deployment configuration is consistent: UI/API routes, same-origin auth, Worker assets, GHCR Quadlet and secret mounts.');

async function listFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(path.join(root, directory, prefix), { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(directory, relative));
    else files.push(relative);
  }
  return files;
}
