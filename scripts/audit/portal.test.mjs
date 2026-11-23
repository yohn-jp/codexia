import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { generate, verify } from './portal.mjs';

const origin='https://yohn-jp.github.io/codexia';
const sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
function fixture() {
  const site=mkdtempSync(join(tmpdir(),'codexia-pages-portal-'));
  mkdirSync(join(site,'audit'),{recursive:true});
  writeFileSync(join(site,'manifest.json'),JSON.stringify({schemaVersion:1,observedAt:'2026-11-23T00:00:00Z',branches:[{branch:'main',sha}],snapshots:{}}));
  writeFileSync(join(site,'audit','index.html'),'<html><a href="../manifest.json">Manifest</a></html>');
  for (const route of ['architecture','graph','ci']) {
    mkdirSync(join(site,route),{recursive:true});
    writeFileSync(join(site,route,'index.html'),`<!doctype html><a href="../">Portal</a>`);
  }
  writeFileSync(join(site,'architecture','manifest.json'),JSON.stringify({sourceSha:sha}));
  writeFileSync(join(site,'graph','source.json'),JSON.stringify({sourceSha:sha}));
  mkdirSync(join(site,'graph'),{recursive:true});
  writeFileSync(join(site,'graph','communities.html'),'<html><a href="./">Graph</a></html>');
  return site;
}

test('generates and verifies a route registry without replacing audit manifest or downloads',()=>{
  const site=fixture();
  try {
    const before=readFileSync(join(site,'manifest.json'),'utf8');
    generate(site,sha,origin);
    const result=verify(site,origin);
    assert.equal(result.routes,6);
    assert.equal(readFileSync(join(site,'manifest.json'),'utf8'),before);
    assert.ok(readFileSync(join(site,'index.html'),'utf8').includes(sha));
    assert.equal(JSON.parse(readFileSync(join(site,'site-manifest.json'),'utf8')).siteOrigin,origin);
  } finally { rmSync(site,{recursive:true,force:true}); }
});

test('rejects a noncanonical public origin and broken internal links',()=>{
  const site=fixture();
  try {
    generate(site,sha,origin);
    assert.throws(()=>verify(site,'https://example.invalid'),/canonical public repository site/u);
    writeFileSync(join(site,'audit','index.html'),'<a href="../not-published.html">bad link</a>');
    assert.throws(()=>verify(site,origin),/Broken internal link/u);
  } finally { rmSync(site,{recursive:true,force:true}); }
});

test('rejects credential-like values and symlinked publication files',()=>{
  const site=fixture();
  try {
    generate(site,sha,origin);
    writeFileSync(join(site,'ci','leak.txt'),'ghp_'+'A'.repeat(40));
    assert.throws(()=>verify(site,origin),/Credential-like value/u);
    unlinkSync(join(site,'ci','leak.txt'));
    symlinkSync(join(site,'manifest.json'),join(site,'ci','redirect.json'));
    assert.throws(()=>verify(site,origin),/Symlink in Pages artifact/u);
  } finally { rmSync(site,{recursive:true,force:true}); }
});
