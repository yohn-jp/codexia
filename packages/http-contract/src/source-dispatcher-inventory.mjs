import { tmpdir } from 'node:os';
import path from 'node:path';
import * as ts from 'typescript/unstable/ast';
import { createVirtualFileSystem } from 'typescript/unstable/fs';
import { API } from 'typescript/unstable/sync';

const VALID_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE']);
const parserRoot = path.join(tmpdir(), 'codexia-source-dispatcher-inventory').replaceAll(path.sep, '/');
const parserFs = createVirtualFileSystem({
  [`${parserRoot}/tsconfig.json`]: JSON.stringify({ compilerOptions: { noLib: true, noResolve: true, types: [] }, include: ['**/*.ts'] }),
});
const parser = new API({ fs: parserFs });
let parserSequence = 0;
process.once('beforeExit', () => parser.close());

function parseSource(source, filename) {
  const filePath = `${parserRoot}/${parserSequence++}/${filename}`;
  parserFs.writeFile(filePath, source);
  const snapshot = parser.updateSnapshot({ openFiles: [filePath] });
  const sourceFile = snapshot.getDefaultProjectForFile(filePath)?.program.getSourceFile(filePath);
  if (!sourceFile) {
    snapshot.dispose();
    throw new Error(`TypeScript could not parse ${filename}`);
  }
  return { sourceFile, dispose: () => snapshot.dispose() };
}

/** Find explicit method === literal and routePath === literal pairs in bounded dispatcher source. */
export function discoverLiteralDispatcherOperations(source, filename = 'dispatcher.ts') {
  const parsed = parseSource(source, filename);
  const operations = [];
  const comparisons = (node, variable, values = []) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) {
      if (ts.isIdentifier(node.left) && node.left.text === variable && ts.isStringLiteral(node.right)) values.push(node.right.text);
      if (ts.isIdentifier(node.right) && node.right.text === variable && ts.isStringLiteral(node.left)) values.push(node.left.text);
    }
    node.forEachChild(child => {
      comparisons(child, variable, values);
    });
    return values;
  };
  const visit = node => {
    if (ts.isIfStatement(node)) {
      const paths = comparisons(node.expression, 'routePath');
      const methods = comparisons(node.expression, 'method').filter(method => VALID_METHODS.has(method));
      for (const method of methods) for (const routePath of paths) operations.push(`${method} ${routePath}`);
    }
    node.forEachChild(visit);
  };
  try {
    visit(parsed.sourceFile);
    return operations;
  } finally {
    parsed.dispose();
  }
}
