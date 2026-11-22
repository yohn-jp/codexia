import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { renderIcon } = require('./codexia-icon.cjs');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

for (const [size, expectedBox] of [[16,'16'],[20,'16'],[24,'24'],[32,'32'],[48,'256'],[180,'256'],[1024,'256']]) {
  test('optical '+size+'px has authoritative viewBox and native size', () => {
    const out = renderIcon({size,accessible:false});
    assert.match(out,new RegExp('width="'+size+'" height="'+size+'" viewBox="0 0 '+expectedBox+' '+expectedBox+'"'));
    assert.ok(!/<(?:image|foreignObject|script)\b/i.test(out));
    assert.ok(!/(?:^|[\s"'=])https?:\/\/(?!www\.w3\.org\/2000\/svg(?:[\s"'<>]|$))[^\s"'<>]+/i.test(out));
  });
}

const paths = svg => [...svg.matchAll(/<path\s+d="([^"]+)"/gu)].map(match => match[1]);

test('24px book and quill geometry fits its authored half-pixel grid', () => {
  const geometry = paths(renderIcon({ size: 24 }));
  assert.ok(geometry.length > 1);
  for (const path of geometry) {
    const points = [...path.matchAll(/-?\d+(?:\.\d+)?/gu)].map(match => Number(match[0]));
    assert.ok(points.length > 0);
    assert.ok(points.every(point => point >= 0 && point <= 24 && Number.isInteger(point * 2)), path);
  }
  const compact = paths(renderIcon({ size: 32 }));
  assert.notDeepEqual(geometry, compact, '24px must have separately authored contours');
});

test('16px uses a centered spine with no fine decorative layers', () => {
  const out=renderIcon({size:16,accessible:false});
  assert.match(out, /<path d="M8\s+[\d.]+\s+V[\d.]+"[^>]+stroke-width="1"/u);
  assert.doesNotMatch(out,/<linearGradient/);
});

test('light and monochrome preserve geometry and accessible title', () => {
  const variants = ['dark','light','mono'].map(mode => renderIcon({ size: 24, mode }));
  for (const out of variants) {
    assert.match(out,/role="img" aria-label=/);
    assert.match(out,/<title>[^<]+<\/title>/);
    assert.deepEqual(paths(out), paths(variants[0]));
  }
  assert.equal(new Set(variants).size, 3, 'each palette has distinct colors');
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
