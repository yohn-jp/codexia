import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function writeGeneratedFile(output, bytes, check) {
  const directory = path.dirname(output);
  if (existsSync(directory)) assert.ok(lstatSync(directory).isDirectory(), `Expected a real output directory at ${directory}`);
  const matches = existsSync(output) && readFileSync(output).equals(bytes);
  if (check) assert.ok(matches, `Fresh generation differs from ${output}`);
  if (matches) return;
  // Other workspace builds can read the same output while generation runs.
  mkdirSync(directory, { recursive: true });
  const staging = mkdtempSync(path.join(directory, '.generate-'));
  try {
    const file = path.join(staging, 'output');
    writeFileSync(file, bytes);
    renameSync(file, output);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
