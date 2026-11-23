import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import ts from "typescript";
import test from "node:test";
import { toFastifyRoutes } from "../src/fastify-schema.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
const inventory = JSON.parse(readFileSync(path.join(packageRoot, "test", "fixtures", "admitted-routes.json"), "utf8"));
const contract = parse(readFileSync(path.join(packageRoot, "openapi", "codexia.openapi.yaml"), "utf8"));
for (const sourcePath of Object.values(inventory.sourceBasis)) {
  assert.ok(existsSync(path.resolve(repositoryRoot, sourcePath)), `inventory source must exist: ${sourcePath}`);
}

function operationKeys(openapi) {
  const methods = new Set(["delete", "get", "head", "options", "patch", "post", "put", "trace"]);
  return Object.entries(openapi.paths ?? {}).flatMap(([pathname, pathItem]) =>
    Object.keys(pathItem).filter((method) => methods.has(method.toLowerCase()))
      .map((method) => `${method.toUpperCase()} ${pathname}`));
}

function assertAdmittedOperations(openapi) {
  const actual = operationKeys(openapi).sort();
  const expected = [...inventory.current, ...inventory.target].sort();
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((operation) => !actualSet.has(operation));
  const unexpected = actual.filter((operation) => !expectedSet.has(operation));
  assert.deepEqual({ missing, unexpected, duplicate: actual.length !== actualSet.size }, {
    missing: [], unexpected: [], duplicate: false,
  }, "generated OpenAPI must exactly match the independently admitted current and target operation inventory");
  const target = new Set(inventory.target);
  for (const key of actual) {
    const operation = key.slice(0, key.indexOf(" ")).toLowerCase();
    const pathname = key.slice(key.indexOf(" ") + 1);
    const status = openapi.paths[pathname][operation]["x-codexia-contract-status"] ?? openapi["x-codexia-contract-status"];
    if (target.has(key)) assert.equal(status, "target", `${key} must stay explicitly marked target`);
    else assert.notEqual(status, "target", `${key} is current and cannot be marked target`);
  }
  return actual;
}

function dispatcherOperations(source) {
  const sourceFile = ts.createSourceFile("server.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const operations = [];
  const comparisons = (node, variable, values = []) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) {
      if (ts.isIdentifier(node.left) && node.left.text === variable && ts.isStringLiteral(node.right)) values.push(node.right.text);
      if (ts.isIdentifier(node.right) && node.right.text === variable && ts.isStringLiteral(node.left)) values.push(node.left.text);
    }
    ts.forEachChild(node, (child) => { comparisons(child, variable, values); });
    return values;
  };
  const visit = (node) => {
    if (ts.isIfStatement(node)) {
      const paths = comparisons(node.expression, "routePath");
      const methods = comparisons(node.expression, "method")
        .filter((method) => ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE"].includes(method));
      for (const method of methods) for (const pathname of paths) operations.push(`${method} ${pathname}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return operations;
}

function coreDispatcherEvidence(source) {
  const sourceFile = ts.createSourceFile("server.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const suffixRoutes = new Set();
  const regexRoutes = new Set();
  const pathRegexRoutes = new Set();
  const matcherByName = new Map();
  const projectRootPattern = String.raw`/^\/api\/projects\/([^/]+)(?:\/(.*))?$/u`;
  let hasProjectRootMatcher = false;
  const validMethods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE"]);
  const literals = (node, variable, result = new Set()) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) {
      if (ts.isIdentifier(node.left) && node.left.text === variable && ts.isStringLiteral(node.right)) result.add(node.right.text);
      if (ts.isIdentifier(node.right) && node.right.text === variable && ts.isStringLiteral(node.left)) result.add(node.left.text);
    }
    ts.forEachChild(node, (child) => { literals(child, variable, result); });
    return result;
  };
  const hasIdentifier = (node, name) => {
    if (ts.isIdentifier(node) && node.text === name) return true;
    let found = false;
    ts.forEachChild(node, (child) => { found ||= hasIdentifier(child, name); });
    return found;
  };
  const nestedInProjectRoot = (node) => {
    for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
      if (ts.isIfStatement(ancestor) && hasIdentifier(ancestor.expression, "projectRoot")) return true;
    }
    return false;
  };
  const findMatchers = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer) &&
        ts.isPropertyAccessExpression(node.initializer.expression) && node.initializer.expression.name.text === "match" &&
        ts.isIdentifier(node.initializer.expression.expression) && ["suffix", "routePath"].includes(node.initializer.expression.expression.text) &&
        node.initializer.arguments[0] && ts.isRegularExpressionLiteral(node.initializer.arguments[0])) {
      matcherByName.set(node.name.text, { pattern: node.initializer.arguments[0].text, source: node.initializer.expression.expression.text });
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "projectRoot" && node.initializer &&
        ts.isCallExpression(node.initializer) && ts.isPropertyAccessExpression(node.initializer.expression) &&
        node.initializer.expression.name.text === "match" && ts.isIdentifier(node.initializer.expression.expression) &&
        node.initializer.expression.expression.text === "routePath" && node.initializer.arguments[0] &&
        ts.isRegularExpressionLiteral(node.initializer.arguments[0])) {
      hasProjectRootMatcher = node.initializer.arguments[0].text === projectRootPattern;
    }
    ts.forEachChild(node, findMatchers);
  };
  findMatchers(sourceFile);
  const visit = (node) => {
    if (ts.isIfStatement(node)) {
      const methods = [...literals(node.expression, "method")].filter((method) => validMethods.has(method));
      if (nestedInProjectRoot(node)) {
        const suffixes = literals(node.expression, "suffix");
        for (const method of methods) for (const suffix of suffixes) suffixRoutes.add(`${method} ${suffix}`);
      }
      const matchNames = new Set();
      const findNames = (part) => {
        if (ts.isIdentifier(part) && matcherByName.has(part.text)) matchNames.add(part.text);
        ts.forEachChild(part, findNames);
      };
      findNames(node.expression);
      for (const name of matchNames) {
        const matcher = matcherByName.get(name);
        if (matcher.source === "suffix" && nestedInProjectRoot(node)) {
          for (const method of methods) regexRoutes.add(`${method} ${matcher.pattern}`);
        } else if (matcher.source === "routePath") {
          for (const method of methods) pathRegexRoutes.add(`${method} ${matcher.pattern}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { hasProjectRootMatcher, matcherByName, pathRegexRoutes, regexRoutes, suffixRoutes };
}

function sourceRegexForSuffix(pattern) {
  return pattern
    .replace(/^\//u, "")
    .replace(/\/[a-z]*$/u, "")
    .replace(/^\^/u, "")
    .replace(/\$$/u, "")
    .replace(/\(\[\^\/\]\+\)/gu, "{param}")
    .replace(/\\\//gu, "/");
}

function normalizePathParameters(pathname) {
  return pathname.replace(/\{[^}]+\}/gu, "{param}");
}

function hasAstIdentifier(node, name) {
  if (ts.isIdentifier(node) && node.text === name) return true;
  let found = false;
  ts.forEachChild(node, (child) => { found ||= hasAstIdentifier(child, name); });
  return found;
}

function serverBoundaryEvidence(source) {
  const sourceFile = ts.createSourceFile("server.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const readMethods = new Set();
  const healthPaths = new Set();
  const versionPaths = new Set();
  let versionReadGuard = false;
  let standaloneMcpSelector = false;
  let standaloneMcpRewrite = false;
  let contributionMethodFilter = false;
  let ownerContributionGuard = false;
  let publicReadContributionGuard = false;
  const invokeHttp = [];
  const hostRoles = new Set();
  const walk = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (node.name.text === "isRead") {
        for (const child of [node.initializer]) {
          const collect = (part) => {
            if (ts.isBinaryExpression(part) && part.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
                ts.isIdentifier(part.left) && part.left.text === "method" && ts.isStringLiteral(part.right)) readMethods.add(part.right.text);
            ts.forEachChild(part, collect);
          };
          collect(child);
        }
      }
      if (node.name.text === "VERSION_PATHS" && ts.isArrayLiteralExpression(node.initializer)) {
        for (const element of node.initializer.elements) if (ts.isStringLiteral(element)) versionPaths.add(element.text);
      }
      if (node.name.text === "standaloneMcpRoute" && ts.isBinaryExpression(node.initializer) &&
          node.initializer.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
          ts.isIdentifier(node.initializer.left) && node.initializer.left.text === "routePath" &&
          ts.isStringLiteral(node.initializer.right) && node.initializer.right.text === "/mcp") standaloneMcpSelector = true;
      if (node.name.text === "host" && ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression) &&
          node.initializer.expression.text === "actionHost" && ts.isStringLiteral(node.initializer.arguments[4])) hostRoles.add(node.initializer.arguments[4].text);
      if (node.name.text === "contributionFor" && node.initializer) {
        const visitContribution = (part) => {
          if (ts.isCallExpression(part) && ts.isPropertyAccessExpression(part.expression) && part.expression.name.text === "includes" &&
              ts.isPropertyAccessExpression(part.expression.expression) && part.expression.expression.name.text === "methods" &&
              hasAstIdentifier(part.arguments[0], "method")) contributionMethodFilter = true;
          ts.forEachChild(part, visitContribution);
        };
        visitContribution(node.initializer);
      }
    }
    if (ts.isIfStatement(node)) {
      if (hasAstIdentifier(node.expression, "isRead") && hasAstIdentifier(node.expression, "VERSION_PATHS") &&
          hasAstIdentifier(node.expression, "routePath")) versionReadGuard = true;
      const pathComparisons = new Set();
      const collectPaths = (part) => {
        if (ts.isBinaryExpression(part) && part.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
            ts.isIdentifier(part.left) && part.left.text === "routePath" && ts.isStringLiteral(part.right)) pathComparisons.add(part.right.text);
        ts.forEachChild(part, collectPaths);
      };
      collectPaths(node.expression);
      if (hasAstIdentifier(node.expression, "isRead")) for (const pathname of pathComparisons) healthPaths.add(pathname);
      const hasComparison = (leftName, rightValue) => {
        let matched = false;
        const inspect = (part) => {
          if (ts.isBinaryExpression(part) && part.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken &&
              ts.isPropertyAccessExpression(part.left) && ts.isIdentifier(part.left.expression) &&
              part.left.expression.text === "contribution" && part.left.name.text === leftName &&
              ts.isStringLiteral(part.right) && part.right.text === rightValue) matched = true;
          ts.forEachChild(part, inspect);
        };
        inspect(node.expression);
        return matched;
      };
      if (hasComparison("access", "owner")) ownerContributionGuard = true;
      if (hasComparison("access", "public") && hasComparison("effect", "read")) publicReadContributionGuard = true;
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "runtime" && node.expression.name.text === "invokeHttp") {
      const [moduleArg, contributionArg, requestArg, hostArg] = node.arguments;
      const idForwarded = ts.isPropertyAccessExpression(contributionArg) && ts.isIdentifier(contributionArg.expression) &&
        contributionArg.expression.text === "contribution" && contributionArg.name.text === "id";
      const requestKind = ts.isIdentifier(requestArg) && requestArg.text === "webRequest" ? "owner" :
        ts.isCallExpression(requestArg) && ts.isIdentifier(requestArg.expression) && requestArg.expression.text === "makeWebRequest" ? "public" : "unknown";
      invokeHttp.push({ idForwarded, moduleArgument: ts.isIdentifier(moduleArg) && moduleArg.text === "moduleId", requestKind,
        hostForwarded: ts.isIdentifier(hostArg) && hostArg.text === "host" });
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) && node.left.text === "routePath" && ts.isTemplateExpression(node.right) &&
        node.right.getText(sourceFile).includes("/modules/mcp/streamable")) {
      let ancestor = node.parent;
      while (ancestor && !(ts.isIfStatement(ancestor) && hasAstIdentifier(ancestor.expression, "standaloneMcpRoute"))) ancestor = ancestor.parent;
      if (ancestor) standaloneMcpRewrite = true;
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "includes" &&
        ts.isIdentifier(node.arguments[0]) && node.arguments[0].text === "method") contributionMethodFilter = true;
    ts.forEachChild(node, walk);
  };
  walk(sourceFile);
  return { contributionMethodFilter, healthPaths, hostRoles, invokeHttp, ownerContributionGuard, publicReadContributionGuard, readMethods,
    standaloneMcpRewrite, standaloneMcpSelector, versionPaths, versionReadGuard };
}

function sourceRegexToTemplate(pattern) {
  return `/${sourceRegexForSuffix(pattern).replace(/\(\[\^\/\]\+\)/gu, "{param}").replace(/\(\.\*\)/gu, "{param}")}`;
}

function fastifyRegistrations(source, filename) {
  const sourceFile = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const constants = new Map();
  const readStaticString = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isIdentifier(node)) return constants.get(node.text);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = readStaticString(node.left);
      const right = readStaticString(node.right);
      return left === undefined || right === undefined ? undefined : left + right;
    }
    return undefined;
  };
  const findConstants = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const value = readStaticString(node.initializer);
      if (value !== undefined) constants.set(node.name.text, value);
    }
    ts.forEachChild(node, findConstants);
  };
  findConstants(sourceFile);
  const registrations = [];
  const methods = new Set(["get", "head", "post", "put", "patch", "delete", "options"]);
  const collect = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && methods.has(node.expression.name.text)) {
      const pathname = node.arguments[0] && readStaticString(node.arguments[0]);
      if (pathname !== undefined) registrations.push(`${node.expression.name.text.toUpperCase()} ${pathname}`);
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);
  return registrations;
}

function contributionOperations(source, prefix) {
  const operations = [];
  for (const match of source.matchAll(/\{\s*id:\s*["'][^"']+["']\s*,\s*path:\s*["']([^"']+)["']\s*,\s*methods:\s*\[([^\]]*)\]/gu)) {
    const suffix = match[1].replace(/^\//u, "").replace(/:([A-Za-z][A-Za-z0-9_]*)/gu, "{$1}");
    for (const method of match[2].matchAll(/["'](GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|TRACE)["']/gu)) {
      operations.push(`${method[1]} ${prefix}${suffix}`);
    }
  }
  return operations;
}

function persistenceBranches(source) {
  const sourceFile = ts.createSourceFile("persistence-routes.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const dynamicSelectors = new Set(["suffix", "documentSuffix", "anchorSuffix", "nodeSuffix", "assertionSuffix"]);
  const dynamicIds = new Set(["changeSetId", "action"]);
  const branches = [];
  const inspectCondition = (condition, branch) => {
    const visit = (node, negated = false) => {
      if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken && ts.isIdentifier(node.operand)) {
        const name = node.operand.text;
        if (dynamicSelectors.has(name) || dynamicIds.has(name)) branch.falsey.add(name);
        return;
      }
      if (ts.isBinaryExpression(node)) {
        const left = node.left;
        const right = node.right;
        const operator = node.operatorToken.kind;
        if (ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.expression) && left.expression.text === "input" && left.name.text === "method" && ts.isStringLiteral(right)) {
          if (operator === ts.SyntaxKind.EqualsEqualsEqualsToken) branch.methods.add(right.text);
          if (operator === ts.SyntaxKind.ExclamationEqualsEqualsToken) branch.rejectedMethods.add(right.text);
        }
        if (ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.expression) && left.expression.text === "url" && left.name.text === "pathname" &&
            operator === ts.SyntaxKind.EqualsEqualsEqualsToken && ts.isStringLiteral(right)) branch.exactPaths.add(right.text);
        if (ts.isIdentifier(left) && dynamicSelectors.has(left.text) && ts.isStringLiteral(right) && operator === ts.SyntaxKind.EqualsEqualsEqualsToken) {
          branch.selectors.set(left.text, right.text);
        }
      }
      if (ts.isIdentifier(node) && (dynamicSelectors.has(node.text) || dynamicIds.has(node.text))) {
        if (!negated) branch.truthy.add(node.text);
      }
      ts.forEachChild(node, (child) => visit(child, negated));
    };
    visit(condition);
  };
  const visitIf = (node) => {
    if (ts.isIfStatement(node)) {
      const own = { methods: new Set(), rejectedMethods: new Set(), exactPaths: new Set(), selectors: new Map(), truthy: new Set(), falsey: new Set() };
      inspectCondition(node.expression, own);
      if (own.methods.size || own.rejectedMethods.size) {
        const combined = { methods: new Set(), rejectedMethods: new Set(), exactPaths: new Set(), selectors: new Map(), truthy: new Set(), falsey: new Set() };
        let ancestor = node;
        while (ancestor) {
          if (ts.isIfStatement(ancestor)) inspectCondition(ancestor.expression, combined);
          ancestor = ancestor.parent;
        }
        branches.push(combined);
      }
    }
    ts.forEachChild(node, visitIf);
  };
  visitIf(sourceFile);
  return branches;
}

function persistenceRouteSelector(pathname) {
  const projectPrefix = "/api/v1/persistence/projects/{projectId}";
  if (pathname === "/api/v1/persistence/status" || pathname === "/api/v1/persistence/import" || pathname === "/api/v1/persistence/projects") {
    return { exactPath: pathname };
  }
  if (!pathname.startsWith(projectPrefix)) return undefined;
  const suffix = pathname.slice(projectPrefix.length).replace(/^\//u, "");
  if (suffix.startsWith("changesets")) {
    const rest = suffix.slice("changesets".length).replace(/^\//u, "");
    if (!rest) return { falsey: ["changeSetId"] };
    const [id, action, ...extra] = rest.split("/");
    if (!id.startsWith("{")) return undefined;
    if (!action) return { truthy: ["changeSetId"], falsey: ["action"] };
    if (extra.length || !["approve", "reject", "apply"].includes(action)) return undefined;
    return { truthy: ["changeSetId", "action"], action };
  }
  for (const [family, id, selector] of [
    ["documents", "{documentId}", "documentSuffix"],
    ["nodes", "{nodeId}", "nodeSuffix"],
    ["assertions", "{assertionId}", "assertionSuffix"],
  ]) {
    if (suffix.startsWith(`${family}/${id}`)) {
      const rest = suffix.slice(`${family}/${id}`.length).replace(/^\//u, "");
      if (family === "documents" && rest.startsWith("anchors/{anchorId}")) {
        return { selectors: [["anchorSuffix", rest.slice("anchors/{anchorId}".length).replace(/^\//u, "")]] };
      }
      return { selectors: [[selector, rest]] };
    }
  }
  return { selectors: [["suffix", suffix]] };
}

function branchMatchesOperation(branch, method, routeSelector) {
  if (routeSelector.exactPath) {
    if (!branch.exactPaths.has(routeSelector.exactPath)) return false;
  } else {
    for (const [selector, value] of routeSelector.selectors ?? []) {
      if (value === "" ? !branch.falsey.has(selector) : branch.selectors.get(selector) !== value) return false;
    }
  }
  const methodMatches = branch.methods.has(method) ||
    (branch.rejectedMethods.size === 1 && !branch.methods.size && branch.rejectedMethods.has(method));
  if (!methodMatches) return false;
  if (routeSelector.truthy?.some((name) => !branch.truthy.has(name))) return false;
  if (routeSelector.falsey?.some((name) => !branch.falsey.has(name))) return false;
  return true;
}

const persistenceSourceCache = new Map();
function persistenceOperationReachable(source, operation) {
  const [method, pathname] = operation.split(" ", 2);
  const selector = persistenceRouteSelector(pathname);
  if (!selector) return false;
  if (!persistenceSourceCache.has(source)) {
    const sourceFile = ts.createSourceFile("persistence-routes.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const matcherText = [];
    const visit = (node) => {
      if (ts.isRegularExpressionLiteral(node)) matcherText.push(node.text);
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    persistenceSourceCache.set(source, { branches: persistenceBranches(source), matcherText });
  }
  const evidence = persistenceSourceCache.get(source);
  const matcherText = evidence.matcherText;
  if (pathname.includes("{projectId}") && !matcherText.some((matcher) => matcher.includes("api\\/v1\\/persistence\\/projects\\/([^/]+)"))) return false;
  if (pathname.includes("/{changeSetId}") && !matcherText.some((matcher) => matcher.includes("changesets(?:\\/([^/]+)(?:\\/(approve|reject|apply))?)?"))) return false;
  if (pathname.includes("/documents/{documentId}") && !matcherText.some((matcher) => matcher.includes("documents\\/([^/]+)(?:\\/(.*))?"))) return false;
  if (pathname.includes("/anchors/{anchorId}") && !matcherText.some((matcher) => matcher.includes("anchors\\/([^/]+)(?:\\/(.*))?"))) return false;
  if (pathname.includes("/nodes/{nodeId}") && !matcherText.some((matcher) => matcher.includes("nodes\\/([^/]+)(?:\\/(.*))?"))) return false;
  if (pathname.includes("/assertions/{assertionId}") && !matcherText.some((matcher) => matcher.includes("assertions\\/([^/]+)(?:\\/(.*))?"))) return false;
  const branch = evidence.branches.find((candidate) => branchMatchesOperation(candidate, method, selector));
  if (!branch) return false;
  return true;
}

test("current and target OpenAPI operations match the independent inventory", () => {
  const keys = assertAdmittedOperations(contract);
  assert.equal(keys.length, 115);
  assert.equal(inventory.current.length, 104);
  assert.equal(inventory.target.length, 11);
  assert.equal(new Set(keys.map((key) => key.slice(key.indexOf(" ") + 1))).size, 90);
});

test("inventory mismatch gate detects missing, extra, and duplicate method/path operations", () => {
  const missing = structuredClone(contract);
  delete missing.paths["/api/auth/codexia/owner-session"].post;
  assert.throws(() => assertAdmittedOperations(missing), /generated OpenAPI must exactly match/u);

  const extra = structuredClone(contract);
  extra.paths["/api/unadmitted-probe"] = { get: {
    operationId: "unadmitted_probe_get", responses: { "200": { description: "ok" } },
    "x-codexia-contract-status": "complete",
  } };
  assert.throws(() => assertAdmittedOperations(extra), /generated OpenAPI must exactly match/u);

  const duplicate = structuredClone(contract);
  duplicate.paths["/api/unadmitted-probe"] = {
    get: { operationId: "unadmitted_probe_get", responses: { "200": { description: "ok" } }, "x-codexia-contract-status": "complete" },
    GET: { operationId: "unadmitted_probe_upper_get", responses: { "200": { description: "ok" } }, "x-codexia-contract-status": "complete" },
  };
  assert.throws(() => assertAdmittedOperations(duplicate), /generated OpenAPI must exactly match/u);

  const misclassifiedTarget = structuredClone(contract);
  misclassifiedTarget.paths["/api/projects/{projectId}/tree"].get["x-codexia-contract-status"] = "target";
  assert.throws(() => assertAdmittedOperations(misclassifiedTarget), /is current and cannot be marked target/u);
});

test("main dispatcher literal method/path predicates are admitted or explicitly external", () => {
  const source = readFileSync(path.resolve(repositoryRoot, "packages", "api", "src", "server.ts"), "utf8");
  const actual = dispatcherOperations(source);
  const unique = new Set(actual);
  assert.equal(actual.length, 15, "AST predicate parser must cover the current literal dispatcher branches");
  const current = new Set(inventory.current);
  const metadata = new Set(inventory.betterAuthExternal.metadataPaths.map((pathname) => `GET ${pathname}`));
  assert.deepEqual(actual.filter((key) => !current.has(key) && !metadata.has(key)), []);
  assert.equal(unique.size, actual.length, "dispatcher route predicates must not duplicate method/path pairs");
  const openapi = new Set(operationKeys(contract));
  for (const key of actual) assert.equal(openapi.has(key), current.has(key), `${key} is either a contracted Codexia route or Better Auth metadata`);
});

test("health/version read selectors and standalone MCP method dispatch match the contract", () => {
  const serverPath = path.resolve(repositoryRoot, "packages", "api", "src", "server.ts");
  const server = readFileSync(serverPath, "utf8");
  const evidence = serverBoundaryEvidence(server);
  const healthPaths = ["/api/health", "/api/ready", "/health/live", "/health/ready", "/health/startup"];
  assert.deepEqual([...evidence.readMethods].sort(), ["GET", "HEAD"]);
  assert.deepEqual([...evidence.healthPaths].sort(), healthPaths.sort());
  assert.deepEqual([...evidence.versionPaths].sort(), ["/api/browser/version", "/api/version"]);
  assert.ok(evidence.versionReadGuard, "version route dispatch must be protected by the isRead selector");
  const readPaths = [...healthPaths, ...evidence.versionPaths];
  const expectedReads = inventory.current.filter((key) => {
    const split = key.indexOf(" ");
    return readPaths.includes(key.slice(split + 1));
  });
  const actualReads = readPaths.flatMap((pathname) => [...evidence.readMethods].map((method) => `${method} ${pathname}`));
  assert.deepEqual(actualReads.sort(), expectedReads.sort(), "health and version GET/HEAD routes must match the admitted inventory");

  assert.ok(evidence.standaloneMcpSelector, "the standalone MCP selector must match exactly /mcp");
  assert.ok(evidence.standaloneMcpRewrite, "standalone /mcp requests must forward to the project MCP streamable adapter");
  assert.ok(evidence.contributionMethodFilter, "the server must filter HTTP contributions by the incoming method");
  const mcp = readFileSync(path.resolve(repositoryRoot, "modules", "mcp", "src", "http.ts"), "utf8");
  const mcpOperations = contributionOperations(mcp, "/api/projects/{projectId}/modules/mcp/");
  assert.deepEqual(mcpOperations.sort(), [
    "DELETE /api/projects/{projectId}/modules/mcp/streamable",
    "GET /api/projects/{projectId}/modules/mcp/streamable",
    "POST /api/projects/{projectId}/modules/mcp/streamable",
  ]);
  assert.deepEqual(mcpOperations.filter((key) => key.includes("/streamable")), inventory.current.filter((key) => key.includes("/api/projects/{projectId}/modules/mcp/streamable")).sort());

  const readMutation = server.replace('method === "GET" || method === "HEAD"', 'method === "GET" || method === "PUT"');
  assert.notEqual(readMutation, server);
  assert.deepEqual([...serverBoundaryEvidence(readMutation).readMethods].sort(), ["GET", "PUT"], "changing the HEAD read selector must alter health/version admission");
  const rewriteMutation = server.replace(
    "routePath = `/api/projects/${encodeURIComponent(projectId)}/modules/mcp/streamable`;",
    "routePath = `/api/projects/${encodeURIComponent(projectId)}/modules/mcp/wrong`;",
  );
  assert.notEqual(rewriteMutation, server);
  assert.equal(serverBoundaryEvidence(rewriteMutation).standaloneMcpRewrite, false, "changing the standalone MCP rewrite path must fail the source check");
});

test("private and public module contributions reach the server host with their descriptors", () => {
  const sourcePath = path.resolve(repositoryRoot, "packages", "api", "src", "server.ts");
  const source = readFileSync(sourcePath, "utf8");
  const evidence = serverBoundaryEvidence(source);
  assert.equal(evidence.invokeHttp.length, 2, "the Core server must expose one owner and one public module forwarding path");
  assert.deepEqual(evidence.invokeHttp.map(({ requestKind }) => requestKind).sort(), ["owner", "public"]);
  assert.ok(evidence.invokeHttp.every(({ moduleArgument, idForwarded, hostForwarded }) => moduleArgument && idForwarded && hostForwarded),
    "both forwarding branches must pass module ID, selected contribution ID, and constructed host");
  assert.ok(evidence.ownerContributionGuard, "private forwarding must retain the owner contribution access check");
  assert.ok(evidence.publicReadContributionGuard, "public forwarding must retain the public read-only contribution check");
  assert.deepEqual([...evidence.hostRoles].sort(), ["owner", "public"], "forwarded hosts must preserve private owner and public access modes");

  const mutatedId = source.replace("runtime.invokeHttp(moduleId, contribution.id, webRequest, host)",
    'runtime.invokeHttp(moduleId, "wrong", webRequest, host)');
  assert.notEqual(mutatedId, source, "negative forwarding mutation must find the owner adapter call");
  assert.ok(!serverBoundaryEvidence(mutatedId).invokeHttp.every(({ idForwarded }) => idForwarded),
    "dropping the selected contribution ID must fail the source evidence check");
});

test("Core dispatcher project suffix and literal regex branches match admitted routes", () => {
  const sourcePath = path.resolve(repositoryRoot, "packages", "api", "src", "server.ts");
  const source = readFileSync(sourcePath, "utf8");
  const evidence = coreDispatcherEvidence(source);
  assert.ok(evidence.hasProjectRootMatcher, "the dispatcher must retain its projectRoot routePath matcher");

  const projectPrefix = "/api/projects/{projectId}";
  const expected = inventory.current.filter((key) => {
    const split = key.indexOf(" ");
    const pathname = key.slice(split + 1);
    return (pathname === projectPrefix || pathname.startsWith(`${projectPrefix}/`)) && !pathname.includes("/modules/");
  }).map((key) => {
    const split = key.indexOf(" ");
    return `${key.slice(0, split + 1)}${normalizePathParameters(key.slice(split + 1))}`;
  });
  const normalizedActual = [];
  const actual = [];
  for (const pair of evidence.suffixRoutes) {
    const [method, suffix] = pair.split(" ", 2);
    normalizedActual.push(`${method} ${suffix ? `${projectPrefix}/${suffix}` : projectPrefix}`);
  }
  for (const pair of evidence.regexRoutes) {
    const [method, pattern] = pair.split(" ", 2);
    normalizedActual.push(`${method} ${projectPrefix}${sourceRegexToTemplate(pattern)}`);
  }
  assert.deepEqual(normalizedActual.map((key) => {
    const split = key.indexOf(" ");
    return `${key.slice(0, split + 1)}${normalizePathParameters(key.slice(split + 1))}`;
  }).sort(), expected.sort(), "Core project dispatcher suffix and regex branches must pair with the current route inventory");
  assert.equal(expected.length, 24, "the currently admitted Core project dispatcher surface contains 24 operations");

  const routeRegexOperations = [...evidence.pathRegexRoutes].map((pair) => {
    const [method, pattern] = pair.split(" ", 2);
    return `${method} ${sourceRegexToTemplate(pattern).replace(/^\//u, "")}`;
  });
  const expectedRegexRoutes = inventory.current.filter((key) => /^(?:GET \/api\/jobs\/\{jobId\}|POST \/api\/inbox\/\{inboxId\}\/read)$/u.test(key))
    .map((key) => {
      const split = key.indexOf(" ");
      return `${key.slice(0, split + 1)}${normalizePathParameters(key.slice(split + 1))}`;
    });
  assert.deepEqual(routeRegexOperations.sort(), expectedRegexRoutes.sort(), "job detail and inbox read regex routes must retain their exact method pairs");

  const treeMutation = source.replace('suffix === "tree" && method === "GET"', 'suffix === "tree" && method === "POST"');
  assert.notEqual(treeMutation, source, "tree route negative mutation must find its source predicate");
  const mutatedTree = coreDispatcherEvidence(treeMutation);
  assert.ok(!mutatedTree.suffixRoutes.has("GET tree"), "changing project tree GET to POST must fail source-to-contract parity");

  const jobMutation = source.replace('if (jobMatch && method === "GET")', 'if (jobMatch && method === "POST")');
  assert.notEqual(jobMutation, source, "job route negative mutation must find its source predicate");
  const mutatedJob = coreDispatcherEvidence(jobMutation);
  assert.ok(![...mutatedJob.pathRegexRoutes].some((pair) => pair.startsWith("GET ") && sourceRegexToTemplate(pair.slice(4)).replace(/^\//u, "") === "api/jobs/{param}"),
    "changing job detail GET to POST must fail source-to-contract parity");
});

test("all explicit setup-only Fastify registrations match current routes and Better Auth overlay", () => {
  const source = readFileSync(path.resolve(repositoryRoot, inventory.sourceBasis.ownerSetupDispatcher), "utf8");
  const actual = fastifyRegistrations(source, "owner-setup.ts");
  const expected = [
    "GET /health/ready",
    ...inventory.current.filter((key) => key.startsWith("GET /api/auth/codexia/setup/") || key.startsWith("POST /api/auth/codexia/setup/")),
    ...inventory.betterAuthExternal.excludedApplicationWrappers,
  ];
  assert.deepEqual(actual.sort(), expected.sort());
  assert.equal(new Set(actual).size, actual.length);
  const openapi = new Set(operationKeys(contract));
  for (const key of expected) {
    if (currentIncludes(key)) assert.ok(openapi.has(key), `${key} is an admitted Codexia route`);
    else assert.ok(!openapi.has(key), `${key} is an external Better Auth protocol route`);
  }
  assert.deepEqual(contract["x-codexia-external-contracts"].betterAuth.setupOnlyOfficialLibraryPaths,
    inventory.betterAuthExternal.excludedApplicationWrappers);
  assert.ok(JSON.stringify(contract["x-codexia-external-contracts"].betterAuth.setupOnlyOverlay)
    .includes(inventory.sourceBasis.ownerSetupDispatcher));
});

function currentIncludes(key) {
  return inventory.current.includes(key);
}

test("the Codexia Better Auth plugin endpoint is admitted as an application adapter", () => {
  const source = readFileSync(path.resolve(repositoryRoot, "packages", "api", "src", "better-auth.ts"), "utf8");
  assert.match(source, /id:\s*["']codexia-auth-methods["']/u);
  assert.match(source, /authMethods:\s*createAuthEndpoint\(["']\/codexia\/auth-methods["'],\s*\{\s*method:\s*["']GET["']/u);
  const key = "GET /api/auth/codexia/auth-methods";
  assert.ok(inventory.current.includes(key));
  assert.ok(inventory.betterAuthAdapters.includes(key));
  assert.ok(contract.paths["/api/auth/codexia/auth-methods"]?.get);
});

test("MCP and publishing contribution methods and paths match OpenAPI", () => {
  const mcp = readFileSync(path.resolve(repositoryRoot, "modules", "mcp", "src", "http.ts"), "utf8");
  const publishing = readFileSync(path.resolve(repositoryRoot, "modules", "publishing", "src", "http.ts"), "utf8");
  const mcpOperations = contributionOperations(mcp, "/api/projects/{projectId}/modules/mcp/");
  const publishingOperations = contributionOperations(publishing, "/api/public/projects/{projectId}/modules/publishing/");
  assert.deepEqual(mcpOperations, [
    "GET /api/projects/{projectId}/modules/mcp/streamable",
    "POST /api/projects/{projectId}/modules/mcp/streamable",
    "DELETE /api/projects/{projectId}/modules/mcp/streamable",
  ]);
  assert.deepEqual(publishingOperations.sort(), [
    "GET /api/public/projects/{projectId}/modules/publishing/share/{token}",
    "GET /api/public/projects/{projectId}/modules/publishing/share/{token}/scenes/{sceneId}",
  ]);
  const expected = new Set(inventory.current);
  const openapi = new Set(operationKeys(contract));
  for (const key of [...mcpOperations, ...publishingOperations]) {
    assert.ok(expected.has(key), `${key} must remain in the runtime inventory`);
    assert.ok(openapi.has(key), `${key} must remain in the generated contract`);
  }
});

test("persistence dispatcher path branches cover every contracted path family", () => {
  const source = readFileSync(path.resolve(repositoryRoot, "packages", "api", "src", "persistence-routes.ts"), "utf8");
  const routeKeys = inventory.current.filter((key) => key.includes(" /api/v1/persistence/"));
  assert.equal(routeKeys.length, 39);
  for (const key of routeKeys) assert.ok(persistenceOperationReachable(source, key), `${key} has no source path/method predicate pair`);

  const allMethods = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT", "TRACE"];
  const allowedByPath = new Map();
  for (const key of routeKeys) {
    const [method, pathname] = key.split(" ", 2);
    if (!allowedByPath.has(pathname)) allowedByPath.set(pathname, new Set());
    allowedByPath.get(pathname).add(method);
  }
  for (const [pathname, allowed] of allowedByPath) {
    for (const method of allMethods.filter((candidate) => !allowed.has(candidate))) {
      assert.ok(!persistenceOperationReachable(source, `${method} ${pathname}`), `${method} ${pathname} is not an admitted dispatcher branch`);
    }
  }

  const mutated = source.replace('documentSuffix === "metadata" && input.method === "PATCH"', 'documentSuffix === "metadata" && input.method === "POST"');
  assert.notEqual(mutated, source, "negative mutation must alter the exact metadata route branch");
  assert.ok(!persistenceOperationReachable(mutated, "PATCH /api/v1/persistence/projects/{projectId}/documents/{documentId}/metadata"),
    "moving PATCH to POST on the metadata path must fail the source-to-contract gate");
  const openapi = new Set(operationKeys(contract));
  for (const key of routeKeys) assert.ok(openapi.has(key), `${key} must remain contracted`);
});

test("generated owner-session request, response, header, error and security semantics are retained", () => {
  const methods = toFastifyRoutes(contract);
  const authMethods = contract.paths["/api/auth/codexia/auth-methods"].get;
  assert.equal(authMethods.responses["200"].content["application/json"].schema.$ref, "#/components/schemas/AuthMethodsBody");
  assert.deepEqual(authMethods.security, [{}]);
  const ownerSession = contract.paths["/api/auth/codexia/owner-session"].post;
  assert.deepEqual(ownerSession.security, [{ ApiKeyAuth: [] }]);
  assert.ok(ownerSession.parameters.some((parameter) => parameter.name === "Origin" && parameter.in === "header" && parameter.required));
  assert.equal(ownerSession.requestBody.required, true);
  assert.deepEqual(Object.keys(ownerSession.responses).filter((status) => status.startsWith("4")).sort(), ["400", "401", "403"]);
  assert.equal(ownerSession.responses["403"].content["application/json"].schema.$ref, "#/components/schemas/ApiError");
  assert.equal(ownerSession.responses["200"].headers["Cache-Control"].schema.enum[0], "no-store");
  const route = methods.routes.find(({ method, url }) => method === "POST" && url === "/api/auth/codexia/owner-session");
  assert.deepEqual(route.contentTypes["403"], ["application/json"]);
  assert.equal(route.responseHeaders["200"]["cache-control"].schema.enum[0], "no-store");
});
