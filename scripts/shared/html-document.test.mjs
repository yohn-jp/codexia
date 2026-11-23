import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectHtml } from './html-document.mjs';

test('reads case-insensitive HTML tags, stylesheet rel tokens and decoded attributes', () => {
  const html = '<!DOCTYPE html><HTML><HEAD><TITLE>Codexia &amp; More</TITLE>' +
    '<META NAME=codexia-style-nonce CONTENT="nonce>with&gt;angle">' +
    "<LINK REL='Preload STYLESHEET' HREF='/assets/style.css?x=1&amp;y=2'></HEAD>" +
    "<BODY><SCRIPT SRC='/assets/app.js?x=1&amp;y=2'></SCRIPT></BODY></HTML>";
  assert.deepEqual(inspectHtml(html), {
    title: 'Codexia & More',
    nonce: 'nonce>with>angle',
    scripts: ['/assets/app.js?x=1&y=2'],
    stylesheets: ['/assets/style.css?x=1&y=2'],
    references: ['/assets/style.css?x=1&y=2', '/assets/app.js?x=1&y=2'],
  });
});

test('does not mistake HTML-like text and comments for tags or external assets', () => {
  const html = '<!doctype html><title>Safe</title>' +
    '<!-- <script src="/wrong.js"></script> -->' +
    '<script>const html = \'<link rel="stylesheet" href="/fake.css">\';</script>' +
    '<a data-src="/not-a-source" href="/reader">Read</a>';
  const result = inspectHtml(html);
  assert.deepEqual(result.scripts, []);
  assert.deepEqual(result.stylesheets, []);
  assert.deepEqual(result.references, ['/reader']);
  assert.equal(result.title, 'Safe');
});

test('handles missing attributes and ignores non-stylesheet link resources', () => {
  const result = inspectHtml('<meta name=other content=123><script></script>' +
    '<link rel=preload href="/other.js"><link rel=stylesheet>' +
    '<script src="/actual.js"></script>');
  assert.deepEqual(result.scripts, ['/actual.js']);
  assert.deepEqual(result.stylesheets, []);
  assert.deepEqual(result.references, ['/other.js', '/actual.js']);
  assert.equal(result.nonce, null);
});
