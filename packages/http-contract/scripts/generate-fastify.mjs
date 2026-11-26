import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { toFastifyRoutes } from '../src/fastify-schema.mjs';
import { generateOpenApi } from './generate-openapi.mjs';
import { writeGeneratedFile } from './generated-file.mjs';

export function generateFastify({ check = false } = {}) {
  const openapi = generateOpenApi({ check });
  const output = fileURLToPath(new URL('../../api/src/generated/http-contract.json', import.meta.url));
  const { schemas, routes } = toFastifyRoutes(parse(openapi.toString('utf8')));
  const lines = items => items.map(item => `    ${JSON.stringify(item)}`).join(',\n');
  const generated = `{\n  "schemas": [\n${lines(schemas)}\n  ],\n  "routes": [\n${lines(routes)}\n  ]\n}\n`;
  writeGeneratedFile(output, Buffer.from(generated), check);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generateFastify({ check: process.argv.includes('--check') });
}
