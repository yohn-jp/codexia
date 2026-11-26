import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeGeneratedFile } from './generated-file.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const compilerRoot = path.join(packageRoot, 'node_modules/@typespec/compiler');
const compiler = JSON.parse(readFileSync(path.join(compilerRoot, 'package.json'), 'utf8')).bin.tsp;

export function generateOpenApi({ check = false } = {}) {
  const temporary = mkdtempSync(path.join(tmpdir(), 'codexia-typespec-'));
  try {
    const emitterOutput = path.join(temporary, 'openapi');
    execFileSync(
      process.execPath,
      [
        path.join(compilerRoot, compiler),
        'compile',
        'src/main.tsp',
        '--output-dir',
        path.join(temporary, 'compiler'),
        '--options',
        `@typespec/openapi3.emitter-output-dir=${emitterOutput}`,
      ],
      { cwd: packageRoot, stdio: 'inherit' },
    );
    const generated = readFileSync(path.join(emitterOutput, 'codexia.openapi.yaml'));
    writeGeneratedFile(path.join(packageRoot, 'openapi/codexia.openapi.yaml'), generated, check);
    return generated;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generateOpenApi({ check: process.argv.includes('--check') });
}
