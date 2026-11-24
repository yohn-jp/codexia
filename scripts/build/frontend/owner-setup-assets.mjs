import assert from 'node:assert/strict';
import { copyFile, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectHtml } from '../../shared/html-document.mjs';
import setupIngress from '../../../deploy/cloudflare/owner-setup.json' with { type: 'json' };

const setup = 'console/setup';
const redirects = '/console/setup /console/setup/index.html 200\n/console/setup/ /console/setup/index.html 200\n';
const headers = `/*
  Cache-Control: no-store
  X-Content-Type-Options: nosniff
  Referrer-Policy: same-origin
  X-Frame-Options: DENY
  Strict-Transport-Security: max-age=31536000
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'
`;
const assetName = /^[a-zA-Z0-9_-]+\.(?:js|css)$/u;

export function ownerSetupWranglerConfig(directory) {
  return { name: setupIngress.worker, compatibility_date: '2026-11-08', workers_dev: false,
    preview_urls: false, assets: { directory, html_handling: 'none', not_found_handling: 'none' } };
}

// The caller must first verify and extract the exact frontend release artifact.
// No ordinary UI, OAuth page, redirect, or script configuration is taken from it.
export async function stageOwnerSetupAssets(frontendDirectory, destination) {
  const source = join(frontendDirectory, setup);
  for (const directory of [join(frontendDirectory, 'console'), source, join(source, 'assets')]) {
    assert.ok((await lstat(directory)).isDirectory(), 'Owner setup requires a regular asset directory');
  }
  const index = join(source, 'index.html');
  assert.ok((await lstat(index)).isFile(), 'Owner setup requires a regular HTML entry');
  const assets = await readdir(join(source, 'assets'), { withFileTypes: true });
  assert.ok(assets.length && assets.every(asset => asset.isFile() && assetName.test(asset.name)),
    'Owner setup assets must be regular JS or CSS files');
  const { references, scripts, stylesheets } = inspectHtml(await readFile(index, 'utf8'));
  const locations = new Set(assets.map(asset => `/${setup}/assets/${asset.name}`));
  assert.ok(scripts.length > 0 && stylesheets.length > 0 && references.every(reference => locations.has(reference)),
    'Owner setup HTML must reference only its certified local assets');

  await mkdir(destination, { mode: 0o700 });
  try {
    const output = join(destination, setup);
    await mkdir(join(output, 'assets'), { recursive: true });
    await copyFile(index, join(output, 'index.html'));
    for (const { name } of assets) await copyFile(join(source, 'assets', name), join(output, 'assets', name));
    await writeFile(join(destination, '_redirects'), redirects);
    await writeFile(join(destination, '_headers'), headers);
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
