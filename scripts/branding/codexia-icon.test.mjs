import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { renderIcon, chooseProfile } = require('./codexia-icon.cjs');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

for (const [size, expectedBox] of [[16,'16'],[20,'16'],[24,'24'],[32,'32'],[48,'256'],[180,'256'],[1024,'256']]) {
  test('optical '+size+'px has authoritative viewBox and native size', () => {
    const out = renderIcon({size,accessible:false});
    assert.match(out,new RegExp('width="'+size+'" height="'+size+'" viewBox="0 0 '+expectedBox+' '+expectedBox+'"'));
    assert.ok(!/<(?:image|foreignObject|script)\b/i.test(out));
    assert.ok(!/https?:\/\/(?!www\.w3\.org\/2000\/svg)/i.test(out));
  });
}

test('24px uses a native authored master instead of fractional 32px projection', () => {
  const out=renderIcon({size:24,accessible:false});
  assert.match(out,/M1\.5 13\.5/);
  assert.doesNotMatch(out,/M2\.1 17\.4/);
  assert.equal(chooseProfile(24),'compact');
});

test('16px uses a centered spine with no fine decorative layers', () => {
  const out=renderIcon({size:16,accessible:false});
  assert.match(out,/M8 10 V14\.5/);
  assert.match(out,/stroke-width="1"/);
  assert.doesNotMatch(out,/<linearGradient/);
});

test('light and monochrome preserve geometry and accessible title', () => {
  for(const mode of ['dark','light','mono']) {
    const out=renderIcon({size:24,mode});
    assert.match(out,/role="img" aria-label=/);
    assert.match(out,/<title>[^<]+<\/title>/);
    assert.match(out,/<path/);
  }
});

test('checked-in favicon matches the canonical JS source byte-for-byte', async () => {
  const actual=await readFile(resolve(root,'app/public/favicon.svg'),'utf8');
  assert.equal(actual,renderIcon({size:16,id:'codexia-favicon'})+'\n');
});

test('checked-in optical SVGs are deterministic', async () => {
  for (const size of [24,32,64,180,512,1024]) {
    const actual=await readFile(resolve(root,'app/public/icons/codexia-'+size+'.svg'),'utf8');
    assert.equal(actual,renderIcon({size,id:'codexia-'+size})+'\n');
  }
});

test('invalid sizes and palettes cannot silently generate wrong icons', () => {
  assert.throws(()=>renderIcon({size:0}),RangeError);
  assert.throws(()=>renderIcon({size:20.5}),RangeError);
  assert.throws(()=>renderIcon({size:16,mode:'unknown'}),RangeError);
});
