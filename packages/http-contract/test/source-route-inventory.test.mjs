import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript/unstable/ast';
import { createVirtualFileSystem } from 'typescript/unstable/fs';
import { API } from 'typescript/unstable/sync';
import { parse } from 'yaml';
import { toFastifyRoutes } from '../src/fastify-schema.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(packageRoot, '../..');
const inventory = JSON.parse(readFileSync(path.join(packageRoot, 'test', 'fixtures', 'admitted-routes.json'), 'utf8'));
const contract = parse(readFileSync(path.join(packageRoot, 'openapi', 'codexia.openapi.yaml'), 'utf8'));
for (const sourcePath of Object.values(inventory.sourceBasis)) {
  assert.ok(existsSync(path.resolve(repositoryRoot, sourcePath)), `inventory source must exist: ${sourcePath}`);
}

const virtualRoot = path.join(tmpdir(), 'codexia-source-route-inventory').replaceAll(path.sep, '/');
// Route inventory needs syntax from individual source strings, including mutations.
const parserFs = createVirtualFileSystem({
  [`${virtualRoot}/tsconfig.json`]: JSON.stringify({
    compilerOptions: { noLib: true, noResolve: true, types: [] },
    include: ['**/*.ts'],
  }),
});
const parser = new API({ fs: parserFs });
after(() => parser.close());
let sourceIndex = 0;

function parseSourceFile(filename, source) {
  // Give each source variation its own document so mutation tests cannot reuse an unchanged AST.
  const filePath = `${virtualRoot}/${sourceIndex++}/${filename}`;
  parserFs.writeFile(filePath, source);
  const snapshot = parser.updateSnapshot({ openFiles: [filePath] });
  try {
    const sourceFile = snapshot.getDefaultProjectForFile(filePath)?.program.getSourceFile(filePath);
    assert.ok(sourceFile, `TypeScript could not parse ${filename}`);
    return sourceFile;
  } finally {
    snapshot.dispose();
  }
}

function operationKeys(openapi) {
  const methods = new Set(['delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'trace']);
  return Object.entries(openapi.paths ?? {}).flatMap(([pathname, pathItem]) =>
    Object.keys(pathItem)
      .filter(method => methods.has(method.toLowerCase()))
      .map(method => `${method.toUpperCase()} ${pathname}`),
  );
}

function assertAdmittedOperations(openapi) {
  const actual = operationKeys(openapi).sort();
  const expected = [...inventory.current, ...inventory.target].sort();
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter(operation => !actualSet.has(operation));
  const unexpected = actual.filter(operation => !expectedSet.has(operation));
  assert.deepEqual(
    { missing, unexpected, duplicate: actual.length !== actualSet.size },
    {
      missing: [],
      unexpected: [],
      duplicate: false,
    },
    'generated OpenAPI must exactly match the independently admitted current and target operation inventory',
  );
  const target = new Set(inventory.target);
  for (const key of actual) {
    const operation = key.slice(0, key.indexOf(' ')).toLowerCase();
    const pathname = key.slice(key.indexOf(' ') + 1);
    const status = openapi.paths[pathname][operation]['x-codexia-contract-status'] ?? openapi['x-codexia-contract-status'];
    if (target.has(key)) assert.equal(status, 'target', `${key} must stay explicitly marked target`);
    else assert.notEqual(status, 'target', `${key} is current and cannot be marked target`);
  }
  return actual;
}

function fastifyRegistrations(source, filename) {
  const sourceFile = parseSourceFile(filename, source);
  const constants = new Map();
  const readStaticString = node => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isIdentifier(node)) return constants.get(node.text);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = readStaticString(node.left);
      const right = readStaticString(node.right);
      return left === undefined || right === undefined ? undefined : left + right;
    }
    return undefined;
  };
  const findConstants = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const value = readStaticString(node.initializer);
      if (value !== undefined) constants.set(node.name.text, value);
    }
    node.forEachChild(findConstants);
  };
  findConstants(sourceFile);
  const registrations = [];
  const methods = new Set(['get', 'head', 'post', 'put', 'patch', 'delete', 'options']);
  const collect = node => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && methods.has(node.expression.name.text)) {
      const pathname = node.arguments[0] && readStaticString(node.arguments[0]);
      if (pathname !== undefined) registrations.push(`${node.expression.name.text.toUpperCase()} ${pathname}`);
    }
    node.forEachChild(collect);
  };
  collect(sourceFile);
  return registrations;
}

function contributionOperations(source, prefix) {
  const operations = [];
  for (const match of source.matchAll(/\{\s*id:\s*["'][^"']+["']\s*,\s*path:\s*["']([^"']+)["']\s*,\s*methods:\s*\[([^\]]*)\]/gu)) {
    const suffix = match[1].replace(/^\//u, '').replace(/:([A-Za-z][A-Za-z0-9_]*)/gu, '{$1}');
    for (const method of match[2].matchAll(/["'](GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|TRACE)["']/gu)) {
      operations.push(`${method[1]} ${prefix}${suffix}`);
    }
  }
  return operations;
}

test('current and target OpenAPI operations match the independent inventory', () => {
  const keys = assertAdmittedOperations(contract);
  assert.equal(keys.length, 116);
  assert.equal(inventory.current.length, 116);
  assert.equal(inventory.target.length, 0);
  assert.equal(new Set(keys.map(key => key.slice(key.indexOf(' ') + 1))).size, 91);
});

test('inventory mismatch gate detects missing, extra, and duplicate method/path operations', () => {
  const missing = structuredClone(contract);
  delete missing.paths['/api/auth/codexia/owner-session'].post;
  assert.throws(() => assertAdmittedOperations(missing), /generated OpenAPI must exactly match/u);

  const extra = structuredClone(contract);
  extra.paths['/api/unadmitted-probe'] = {
    get: {
      operationId: 'unadmitted_probe_get',
      responses: { 200: { description: 'ok' } },
      'x-codexia-contract-status': 'complete',
    },
  };
  assert.throws(() => assertAdmittedOperations(extra), /generated OpenAPI must exactly match/u);

  const duplicate = structuredClone(contract);
  duplicate.paths['/api/unadmitted-probe'] = {
    get: { operationId: 'unadmitted_probe_get', responses: { 200: { description: 'ok' } }, 'x-codexia-contract-status': 'complete' },
    GET: { operationId: 'unadmitted_probe_upper_get', responses: { 200: { description: 'ok' } }, 'x-codexia-contract-status': 'complete' },
  };
  assert.throws(() => assertAdmittedOperations(duplicate), /generated OpenAPI must exactly match/u);

  const misclassifiedTarget = structuredClone(contract);
  misclassifiedTarget.paths['/api/projects/{projectId}/tree'].get['x-codexia-contract-status'] = 'target';
  assert.throws(() => assertAdmittedOperations(misclassifiedTarget), /is current and cannot be marked target/u);
});

test('generated Fastify routes exactly cover the admitted HTTP operation inventory', () => {
  const generatedPath = path.resolve(repositoryRoot, 'packages/api/src/generated/http-contract.json');
  const generated = JSON.parse(readFileSync(generatedPath, 'utf8'));
  const routeKeys = generated.routes.map(({ method, url }) => `${method} ${url.replace(/:([A-Za-z][A-Za-z0-9_]*)/gu, '{$1}')}`);
  const admitted = [...inventory.current, ...inventory.target].sort();
  assert.deepEqual(
    [...routeKeys].sort(),
    admitted,
    'generated route registrations must retain every current and target operation exactly once',
  );
  assert.equal(new Set(routeKeys).size, routeKeys.length, 'generated Fastify route registrations must be unique');
  for (const route of generated.routes) {
    const key = `${route.method} ${route.url.replace(/:([A-Za-z][A-Za-z0-9_]*)/gu, '{$1}')}`;
    assert.ok(route.operationId, `${key} needs an operationId for runtime handler resolution`);
    assert.equal(
      route.contractStatus === 'target',
      inventory.target.includes(key),
      `${key} target status must match the admitted inventory`,
    );
  }
  const server = readFileSync(path.resolve(repositoryRoot, 'packages/api/src/server.ts'), 'utf8');
  assert.match(server, /for\s*\(const route of httpContract\.routes\)/u, 'the server must register routes from the generated contract');
  assert.match(server, /handlers\[route\.operationId\]/u, 'runtime handler resolution must be keyed by operationId');
  assert.match(server, /No handler registered for \$\{route\.operationId\}/u, 'missing route handlers must fail closed');
});

test('all explicit setup-only Fastify registrations match current routes and Better Auth overlay', () => {
  const source = readFileSync(path.resolve(repositoryRoot, inventory.sourceBasis.ownerSetupRegistrations), 'utf8');
  const actual = fastifyRegistrations(source, 'owner-setup.ts');
  const expected = [
    'GET /health/ready',
    ...inventory.current.filter(key => key.startsWith('GET /api/auth/codexia/setup/') || key.startsWith('POST /api/auth/codexia/setup/')),
    ...inventory.betterAuthExternal.excludedApplicationWrappers,
  ];
  assert.deepEqual(actual.sort(), expected.sort());
  assert.equal(new Set(actual).size, actual.length);
  const openapi = new Set(operationKeys(contract));
  for (const key of expected) {
    if (currentIncludes(key)) assert.ok(openapi.has(key), `${key} is an admitted Codexia route`);
    else assert.ok(!openapi.has(key), `${key} is an external Better Auth protocol route`);
  }
  assert.deepEqual(
    contract['x-codexia-external-contracts'].betterAuth.setupOnlyOfficialLibraryPaths,
    inventory.betterAuthExternal.excludedApplicationWrappers,
  );
  assert.ok(
    JSON.stringify(contract['x-codexia-external-contracts'].betterAuth.setupOnlyOverlay).includes(
      inventory.sourceBasis.ownerSetupRegistrations,
    ),
  );
});

function currentIncludes(key) {
  return inventory.current.includes(key);
}

test('the Codexia Better Auth plugin endpoint is admitted as an application adapter', () => {
  const source = readFileSync(path.resolve(repositoryRoot, 'packages', 'api', 'src', 'better-auth.ts'), 'utf8');
  assert.match(source, /id:\s*["']codexia-auth-methods["']/u);
  assert.match(source, /authMethods:\s*createAuthEndpoint\(["']\/codexia\/auth-methods["'],\s*\{\s*method:\s*["']GET["']/u);
  const key = 'GET /api/auth/codexia/auth-methods';
  assert.ok(inventory.current.includes(key));
  assert.ok(inventory.betterAuthAdapters.includes(key));
  assert.ok(contract.paths['/api/auth/codexia/auth-methods']?.get);
});

test('MCP and publishing contribution methods and paths match OpenAPI', () => {
  const mcp = readFileSync(path.resolve(repositoryRoot, 'modules', 'mcp', 'src', 'http.ts'), 'utf8');
  const publishing = readFileSync(path.resolve(repositoryRoot, 'modules', 'publishing', 'src', 'http.ts'), 'utf8');
  const mcpOperations = contributionOperations(mcp, '/api/projects/{projectId}/modules/mcp/');
  const publishingOperations = contributionOperations(publishing, '/api/public/projects/{projectId}/modules/publishing/');
  assert.deepEqual(mcpOperations, [
    'GET /api/projects/{projectId}/modules/mcp/streamable',
    'POST /api/projects/{projectId}/modules/mcp/streamable',
    'DELETE /api/projects/{projectId}/modules/mcp/streamable',
  ]);
  assert.deepEqual(publishingOperations.sort(), [
    'GET /api/public/projects/{projectId}/modules/publishing/share/{token}',
    'GET /api/public/projects/{projectId}/modules/publishing/share/{token}/scenes/{sceneId}',
  ]);
  const expected = new Set(inventory.current);
  const openapi = new Set(operationKeys(contract));
  for (const key of [...mcpOperations, ...publishingOperations]) {
    assert.ok(expected.has(key), `${key} must remain in the runtime inventory`);
    assert.ok(openapi.has(key), `${key} must remain in the generated contract`);
  }
});

test('generated persistence registrations resolve to independently declared handlers', () => {
  const source = readFileSync(path.resolve(repositoryRoot, 'packages', 'api', 'src', 'persistence-routes.ts'), 'utf8');
  const server = readFileSync(path.resolve(repositoryRoot, 'packages/api/src/server.ts'), 'utf8');
  const jsonIds = [...source.matchAll(/^ {2}(persistence_[a-z0-9_]+): async\b/gmu)].map(match => match[1]);
  const streaming = /const streamingPersistenceHandlers:[^\n]+ = \{(?<handlers>[^}]+)\}/u.exec(server)?.groups?.handlers;
  assert.ok(streaming, 'streaming persistence routes must declare their raw response handlers');
  const streamingIds = [...streaming.matchAll(/^ {4}(persistence_[a-z0-9_]+): [A-Za-z][A-Za-z0-9_]*,$/gmu)].map(match => match[1]);
  const ids = [...jsonIds, ...streamingIds];
  const persistenceRoutes = JSON.parse(
    readFileSync(path.resolve(repositoryRoot, 'packages/api/src/generated/http-contract.json'), 'utf8'),
  ).routes.filter(route => route.url.startsWith('/api/v1/persistence/') && route.contractStatus !== 'target');
  const expectedIds = persistenceRoutes.map(route => route.operationId);
  assert.deepEqual(ids.sort(), expectedIds.sort(), 'every current persistence operationId must resolve to exactly one handler');
  assert.equal(new Set(ids).size, ids.length, 'persistence handler operationIds must be unique');
  assert.match(source, /const handler = handlers\[operationId\]/u, 'persistence handlers must resolve by generated operationId');
  assert.match(source, /Unknown persistence operation \$\{operationId\}/u, 'unknown operationIds must fail closed');
  assert.match(
    server,
    /streamingPersistenceHandlers\[route\.operationId\]/u,
    'Fastify registrations must resolve streaming handlers by the generated operationId',
  );
  assert.match(
    server,
    /handlePersistenceOperation\(route\.operationId/u,
    'Fastify registrations must pass the generated operationId to persistence routing',
  );
  const openapi = new Set(operationKeys(contract));
  for (const route of persistenceRoutes) {
    const key = `${route.method} ${route.url.replace(/:([A-Za-z][A-Za-z0-9_]*)/gu, '{$1}')}`;
    assert.ok(openapi.has(key), `${key} must remain contracted`);
  }
});

test('generated owner-session request, response, header, error and security semantics are retained', () => {
  const methods = toFastifyRoutes(contract);
  const authMethods = contract.paths['/api/auth/codexia/auth-methods'].get;
  assert.equal(authMethods.responses['200'].content['application/json'].schema.$ref, '#/components/schemas/AuthMethodsBody');
  assert.deepEqual(authMethods.security, [{}]);
  const ownerSession = contract.paths['/api/auth/codexia/owner-session'].post;
  assert.deepEqual(ownerSession.security, [{ ApiKeyAuth: [] }]);
  assert.ok(ownerSession.parameters.some(parameter => parameter.name === 'Origin' && parameter.in === 'header' && parameter.required));
  assert.equal(ownerSession.requestBody.required, true);
  assert.deepEqual(
    Object.keys(ownerSession.responses)
      .filter(status => status.startsWith('4'))
      .sort(),
    ['400', '401', '403'],
  );
  assert.equal(ownerSession.responses['403'].content['application/json'].schema.$ref, '#/components/schemas/ApiError');
  assert.equal(ownerSession.responses['200'].headers['Cache-Control'].schema.enum[0], 'no-store');
  const route = methods.routes.find(({ method, url }) => method === 'POST' && url === '/api/auth/codexia/owner-session');
  assert.deepEqual(route.contentTypes['403'], ['application/json']);
  assert.equal(route.responseHeaders['200']['cache-control'].schema.enum[0], 'no-store');
  const consentContext = contract.paths['/api/auth/oauth2/consent-context'].post;
  const consents = contract.paths['/api/auth/oauth2/get-consents'].get;
  assert.match(consentContext['x-codexia-security-deviation'], /approved baseline encodes BearerAuth/u);
  assert.match(consents['x-codexia-security-deviation'], /approved baseline encodes BearerAuth/u);
  assert.match(consents['x-codexia-runtime-response-deviation'], /top-level array/u);
  assert.equal(consents.responses['200'].content['application/json'].schema.type, 'object');
  assert.equal(consents['x-codexia-desktop-response-schema'], '#/components/schemas/OAuthConsentRowList');
  const consentRow = contract.components.schemas.OAuthConsentRow;
  assert.deepEqual(consentRow.required.sort(), ['clientId', 'id', 'scopes']);
  assert.equal(consentRow.properties.id.type, 'string');
  assert.equal(consentRow.properties.clientId.type, 'string');
  assert.equal(consentRow.properties.scopes.type, 'array');
  assert.deepEqual(contract.components.schemas.OAuthConsentRowList.items.$ref, '#/components/schemas/OAuthConsentRow');
  assert.equal(
    contract.paths['/api/auth/codexia/setup/status'].get.responses['200'].content['application/json'].schema.$ref,
    '#/components/schemas/OwnerSetupStatusResponse',
  );
});
