import { execFileSync } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import { isTraceTestSource } from './test-source-path.mjs';

const TEST_ID = /^TEST-(?:[A-Z0-9]+-)+\d{3}$/u;
const TEST_PREFIX = /\[(TEST-(?:[A-Z0-9]+-)+\d{3})\]/gu;
const RUNNERS = new Map([
  ['node:test', 'node'],
  ['@playwright/test', 'playwright'],
  ['playwright/test', 'playwright'],
]);
const traverse = traverseModule.default;

export function testIdsFromName(name) {
  if (typeof name !== 'string') return [];
  const prefix = name.match(/^(?:\[TEST-(?:[A-Z0-9]+-)+\d{3}\] )+/u)?.[0];
  return prefix ? [...prefix.matchAll(TEST_PREFIX)].map((match) => match[1]) : [];
}

function literalString(node) {
  if (node?.type === 'StringLiteral') return node.value;
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0]?.value.cooked;
  return undefined;
}

function staticPropertyName(node) {
  if (!node) return undefined;
  if (node.isMemberExpression?.()) {
    return node.node.computed ? literalString(node.node.property) : node.node.property?.name;
  }
  if (node.isObjectProperty?.()) {
    return node.node.computed ? literalString(node.node.key) : node.node.key?.name ?? node.node.key?.value;
  }
  return undefined;
}

function requireKind(pathRef) {
  if (!pathRef?.isCallExpression?.() || !pathRef.get('callee').isIdentifier({ name: 'require' }) || pathRef.scope.getBinding('require')) return undefined;
  const kind = RUNNERS.get(literalString(pathRef.node.arguments[0]));
  return kind ? { module: kind } : undefined;
}

async function sourceFiles(root) {
  let candidates;
  try {
    const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    candidates = tracked.split('\0').filter(Boolean).filter(isTraceTestSource).map(file => path.resolve(root, file));
  } catch {
    candidates = [];
    const excluded = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', 'target']);
    const walk = async (directory) => {
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!excluded.has(entry.name)) await walk(file);
        } else if (entry.isFile() && isTraceTestSource(entry.name)) candidates.push(file);
      }
    };
    await walk(root);
  }
  const result = [];
  for (const file of [...new Set(candidates)].sort()) {
    try { if ((await lstat(file)).isFile()) result.push(file); }
    catch { /* A tracked file deleted from the worktree is not a source candidate. */ }
  }
  return result;
}

function unwrap(pathRef) {
  let current = pathRef;
  while (current?.isTSAsExpression?.() || current?.isTSTypeAssertion?.() || current?.isTSNonNullExpression?.() ||
      current?.isTSInstantiationExpression?.() || current?.isParenthesizedExpression?.()) {
    current = current.get('expression');
  }
  return current;
}

function makeResolver(importBindings) {
  const cache = new Map();
  const resolving = new Set();

  const resolveBinding = (binding) => {
    if (!binding) return undefined;
    if (!binding.constant) return undefined;
    if (importBindings.has(binding)) return importBindings.get(binding);
    if (cache.has(binding)) return cache.get(binding);
    if (resolving.has(binding)) return undefined;
    resolving.add(binding);
    const sourcePath = binding.path;
    let result;
    if (sourcePath.isVariableDeclarator()) {
      const id = sourcePath.get('id');
      const init = unwrap(sourcePath.get('init'));
      if (id.isIdentifier()) result = resolveExpression(init);
      else if (id.isObjectPattern()) {
        const module = requireKind(init);
        if (module) {
          const localName = binding.identifier.name;
          const property = id.get('properties').find(item => item.isObjectProperty() &&
            (item.get('value').isIdentifier({ name: localName }) || item.get('key').isIdentifier({ name: localName })));
          if (property) {
            const imported = staticPropertyName(property);
            if (imported === 'test' || imported === 'it') result = { runner: module.module };
          }
        }
      }
    }
    resolving.delete(binding);
    cache.set(binding, result);
    return result;
  };

  const resolveExpression = (pathRef) => {
    const current = unwrap(pathRef);
    if (!current?.node) return undefined;
    if (current.isIdentifier()) return resolveBinding(current.scope.getBinding(current.node.name));
    if (current.isCallExpression()) {
      const callee = unwrap(current.get('callee'));
      if (callee.isMemberExpression() && staticPropertyName(callee) === 'extend') {
        const base = resolveExpression(callee.get('object'));
        if (base?.runner === 'playwright') return base;
      }
      return requireKind(current);
    }
    if (current.isMemberExpression()) {
      const property = staticPropertyName(current);
      const owner = resolveExpression(current.get('object'));
      if ((property === 'test' || property === 'it') && owner?.module) return { runner: owner.module };
      if ((property === 'test' || property === 'it') && owner?.exports?.has(property)) return { runner: owner.exports.get(property) };
      if (['skip', 'todo', 'only'].includes(property) && owner?.runner === 'node') return owner;
      return undefined;
    }
    return undefined;
  };

  return { resolveBinding, resolveExpression };
}

function importNames(specifierPath) {
  if (specifierPath.isImportSpecifier()) {
    return { imported: specifierPath.node.imported.name ?? specifierPath.node.imported.value, local: specifierPath.node.local.name };
  }
  if (specifierPath.isImportDefaultSpecifier()) return { imported: 'default', local: specifierPath.node.local.name };
  if (specifierPath.isImportNamespaceSpecifier()) return { imported: '*', local: specifierPath.node.local.name };
  return undefined;
}

async function modulePath(root, fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].map(ext => `${base}${ext}`),
    ...['index.ts', 'index.tsx', 'index.js', 'index.mjs'].map(name => path.join(base, name))];
  for (const candidate of candidates) {
    if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) continue;
    try { if ((await lstat(candidate)).isFile()) return candidate; }
    catch { /* Try the next standard source extension. */ }
  }
  return undefined;
}

async function prepareBindings(ast, file, root, analyzeFile) {
  const importBindings = new Map();
  const imports = [];
  traverse(ast, {
    ImportDeclaration(importPath) {
      imports.push(importPath);
    },
  });
  for (const importPath of imports) {
    const declaration = importPath.node;
    if (declaration.importKind === 'type') continue;
    const source = declaration.source.value;
    const directRunner = RUNNERS.get(source);
    const relevantSpecifiers = importPath.get('specifiers').filter(specifierPath => {
      const names = importNames(specifierPath);
      return names && (names.imported === '*' || names.imported === 'default' || names.imported === 'test' || names.imported === 'it');
    });
    if (relevantSpecifiers.length === 0) continue;
    let localExports;
    if (!directRunner && source.startsWith('.')) {
      const target = await modulePath(root, file, source);
      if (target) localExports = await analyzeFile(target);
    }
    for (const specifierPath of relevantSpecifiers) {
      if (specifierPath.node.importKind === 'type') continue;
      const names = importNames(specifierPath);
      const binding = importPath.scope.getBinding(names.local);
      if (!binding) continue;
      if (directRunner) {
        if (names.imported === '*' && directRunner === 'node') importBindings.set(binding, { module: directRunner });
        else if ((names.imported === 'test' || (names.imported === 'it' && directRunner === 'node')) || (names.imported === 'default' && directRunner === 'node')) {
          importBindings.set(binding, { runner: directRunner });
        } else if (names.imported === 'default' && directRunner === 'playwright') {
          importBindings.set(binding, { unsupportedDefaultRunner: directRunner });
        }
      } else if (localExports) {
        if (names.imported === '*') importBindings.set(binding, { exports: localExports });
        else if (localExports.has(names.imported)) importBindings.set(binding, { runner: localExports.get(names.imported) });
      }
    }
  }
  return makeResolver(importBindings);
}

async function analyzeFile(file, root, findings, violations, active, cache) {
  if (cache.has(file)) return cache.get(file);
  if (active.has(file)) return new Map();
  active.add(file);
  const relativeFile = path.relative(root, file).split(path.sep).join('/');
  let source;
  let ast;
  try {
    source = await readFile(file, 'utf8');
    ast = parse(source, {
      sourceType: 'unambiguous',
      errorRecovery: false,
      plugins: ['typescript', ...(/\.(?:tsx|jsx)$/u.test(relativeFile) ? ['jsx'] : []), 'decorators-legacy', 'importAttributes'],
    });
  } catch (error) {
    violations.push(`${relativeFile} could not be parsed for TEST-ID discovery: ${error.message}`);
    active.delete(file);
    cache.set(file, new Map());
    return cache.get(file);
  }

  const resolver = await prepareBindings(ast, file, root, target => analyzeFile(target, root, findings, violations, active, cache));
  const exports = new Map();
  if (isTraceTestSource(file)) {
    traverse(ast, {
      CallExpression(callPath) {
        const callee = callPath.get('callee');
        const runner = resolver.resolveExpression(callee);
        const first = callPath.get('arguments.0');
        const name = first?.node ? literalString(first.node) : undefined;
        const sourcePosition = callPath.node.loc?.start.line ?? 0;
        if (!runner?.runner) {
          if (runner?.unsupportedDefaultRunner && name && name.includes('[TEST-')) {
            violations.push(`${relativeFile}:${sourcePosition} Playwright TEST-ID registration must use a named test import`);
          }
          return;
        }
        if (name === undefined) {
          if (first?.node && source.slice(first.node.start, first.node.end).includes('[TEST-')) {
            violations.push(`${relativeFile}:${sourcePosition} TEST-ID title must be a static string literal`);
          }
          return;
        }
        const matches = testIdsFromName(name);
        if (matches.length === 0 && !name.includes('[TEST-')) return;
        const prefix = matches.map(id => `[${id}] `).join('');
        const occurrences = [...name.matchAll(TEST_PREFIX)].map(match => match[1]);
        if (matches.length === 0 || occurrences.length !== matches.length || matches.some(id => !TEST_ID.test(id)) ||
            !name.startsWith(prefix) || new Set(matches).size !== matches.length) {
          violations.push(`${relativeFile}:${sourcePosition} TEST-ID title must begin with canonical contiguous [TEST-ID] prefixes`);
          return;
        }
        for (const testId of matches) findings.push({ testId, file: relativeFile, line: sourcePosition, name, runner: runner.runner });
      },
    });
  }

  traverse(ast, {
    ExportNamedDeclaration(exportPath) {
      const declaration = exportPath.get('declaration');
      if (declaration?.isVariableDeclaration()) {
        for (const declarator of declaration.get('declarations')) {
          const id = declarator.get('id');
          if (!id.isIdentifier()) continue;
          const runner = resolver.resolveBinding(exportPath.scope.getBinding(id.node.name))?.runner;
          if (runner) exports.set(id.node.name, runner);
        }
      }
      for (const specifier of exportPath.get('specifiers')) {
        const local = specifier.node.local.name ?? specifier.node.local.value;
        const name = specifier.node.exported.name ?? specifier.node.exported.value;
        const runner = resolver.resolveBinding(exportPath.scope.getBinding(local))?.runner;
        if (runner) exports.set(name, runner);
      }
    },
    ExportDefaultDeclaration(exportPath) {
      const runner = resolver.resolveExpression(exportPath.get('declaration'))?.runner;
      if (runner) exports.set('default', runner);
    },
  });

  active.delete(file);
  cache.set(file, exports);
  return exports;
}

export async function discoverTestSources(repositoryRoot) {
  const root = path.resolve(repositoryRoot);
  const files = await sourceFiles(root);
  const findings = [];
  const violations = [];
  const active = new Set();
  const cache = new Map();
  for (const file of files) await analyzeFile(file, root, findings, violations, active, cache);

  const byId = new Map();
  for (const finding of findings) {
    const prior = byId.get(finding.testId) ?? [];
    prior.push(finding);
    byId.set(finding.testId, prior);
  }
  const sources = new Map();
  for (const [testId, matches] of [...byId].sort(([left], [right]) => left.localeCompare(right))) {
    if (matches.length !== 1) {
      violations.push(`Duplicate TEST-ID ${testId}: ${matches.map(item => `${item.file}:${item.line}`).join(', ')}`);
    } else sources.set(testId, matches[0]);
  }
  return { sources, violations: [...new Set(violations)].sort() };
}
