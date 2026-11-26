import assert from 'node:assert/strict';
import test from 'node:test';
import { publicReaderOrigin, publicReaderUrl } from './share-url.js';

test('publishing rejects a non-web current origin', () => {
  assert.equal(publicReaderOrigin({ currentOrigin: 'reader://localhost' }), null);
});

test('web publishing keeps its same-origin reader link', () => {
  const origin = publicReaderOrigin({ currentOrigin: 'https://codexia.example.test' });
  assert.ok(origin);
  assert.equal(origin, 'https://codexia.example.test');
  assert.equal(publicReaderUrl(origin, 'project-1', 'share_token'), 'https://codexia.example.test/r/publishing/project-1/share_token');
});
