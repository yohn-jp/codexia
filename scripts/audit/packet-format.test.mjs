import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { codeFence, numberedSource, renderReviewPacket } from './packet-format.mjs';

const sha256 = s => createHash('sha256').update(s).digest('hex');
const preview = { reviewable_count: 2, excluded_count: 1,
  reviewable_files: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }],
  excluded_files: [{ path: 'private/data.md', exclude_reason: 'security' }] };
function fixture() {
  const text = 'Review ownership and error handling. Do not invent missing dependencies.';
  return {
    base: 'a'.repeat(40), head: 'b'.repeat(40), mergeBase: 'c'.repeat(40), ocrVersion: '1.13.13', preview,
    files: [
      { path: 'src/a.ts', status: 'modified', insertions: 2, deletions: 1, preimage: 'verified',
        rule: { text, source: 'custom', pattern: '*' },
        patch: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1,2 @@\n+x = "```"\n',
        source: 'const a = "```";\n# Full file at head\n' },
      { path: 'src/b.ts', status: 'added', insertions: 1, deletions: 0, preimage: 'none',
        rule: { text, source: 'custom', pattern: '*' },
        patch: 'diff --git a/src/b.ts b/src/b.ts\n@@ -0,0 +1 @@\n+const b = 2;\n',
        source: 'const b = 2;\n' },
    ], skipped: [], guidance: [{ path: 'AGENTS.md', content: '# Canonical context\nDo not rewrite core.\n' }],
  };
}

test('full packet has consistent headings, numbered sources, deduplicated rules, coverage and valid fences', () => {
  const fixtureArgs = fixture();
  const { content, packetId, contentSha256, ruleCount } = renderReviewPacket(fixtureArgs);
  assert.equal(ruleCount, 1);
  let inFence = false, roots = 0;
  for (const line of content.split('\n')) {
    if (/^`{3,}/u.test(line)) { inFence = !inFence; continue; }
    if (!inFence && line.startsWith('# ')) roots++;
  }
  assert.equal(roots, 1, 'single root heading outside code fences');
  assert.equal((content.match(/^### R01$/gmu) ?? []).length, 1, 'one rule section for two files');
  assert.equal(content.split(fixtureArgs.files[0].rule.text).length - 1, 1);
  assert.match(content, /\| F001 \| `src\/a\.ts` \| modified \| \+2\/-1 \| R01 \|/u);
  assert.match(content, /\| F002 \| `src\/b\.ts` \| added \| \+1\/-0 \| R01 \|/u);
  assert.match(content, /<!-- BEGIN_FILE F001 -->/u);
  assert.match(content, /<!-- END_FILE F001 -->/u);
  assert.match(content, /<!-- BEGIN_FILE F002 -->/u);
  assert.match(content, /<!-- END_FILE F002 -->/u);
  assert.match(content, /0001 \| const a = "```";/u);
  assert.match(content, /0002 \| # Full file at head/u);
  assert.match(content, /SOURCE_SHA256:.*`[a-f0-9]{64}`/u);
  assert.match(content, /#### Unified diff/u);
  assert.match(content, /#### Complete source at HEAD/u);
  assert.match(content, /END_OF_PACKET.*INCLUDED=2 HEAD=/u);
  assert.ok(content.includes('PACKET_ID:** `' + packetId + '`'));
  assert.ok(content.includes('CONTENT_SHA256: ' + contentSha256));
  assert.equal(sha256(content.split('CONTENT_SHA256: ')[0]), contentSha256);
  assert.equal((content.match(/^`{3,}(?:typescript|diff|markdown|text)?$/gmu) ?? []).length % 2, 0);
  assert.equal(renderReviewPacket(fixtureArgs).content, content, 'byte-deterministic re-render');
});

test('diff-only packet is distinguishable, smaller, and does not claim full-source review', () => {
  const sample = fixture();
  const full = renderReviewPacket(sample);
  const compact = renderReviewPacket({ ...sample, full: false });
  assert.notEqual(full.packetId, compact.packetId);
  assert.ok(compact.content.length < full.content.length);
  assert.doesNotMatch(compact.content, /0001 \| const a/u);
  assert.doesNotMatch(compact.content, /Canonical context/u);
  assert.match(compact.content, /Limited context/u);
  assert.match(compact.content, /END_OF_PACKET/u);
  assert.match(compact.content, /Review ownership and error handling/u);
  assert.match(compact.content, /Required review output/u);
});

test('content changes alter packet ID; special source fences and line counting remain sound', () => {
  const sample = fixture();
  const full = renderReviewPacket(sample);
  sample.files[0].source += 'const x = 3;\n';
  assert.notEqual(renderReviewPacket(sample).packetId, full.packetId);
  const fence = codeFence('console.log("```");\n', 'javascript');
  assert.ok(fence.startsWith('````javascript\n'));
  assert.ok(fence.endsWith('\n````'));
  assert.equal(numberedSource('a\n\nb\n'), '0001 | a\n0002 | \n0003 | b');
  assert.equal(numberedSource(''), '');
});

test('partial coverage and OCR exclusions cannot be presented as complete', () => {
  const sample = fixture();
  sample.files.pop();
  sample.skipped = [{ path: 'src/b.ts', status: 'added', reason: 'not-in-verified-head-export' }];
  const { content } = renderReviewPacket(sample);
  assert.match(content, /OMITTED:\*\* 1/);
  assert.match(content, /src\/b\.ts.*not-in-verified-head-export/u);
  assert.match(content, /private\/data\.md.*security/u);
  assert.match(content, /Do not describe omitted or OCR-excluded paths as reviewed/u);
});

test('large markdown with many separate backtick runs does not exhaust call stack', () => {
  const raw = ('`backtick`\n').repeat(120000);
  const result = codeFence(raw, 'markdown');
  assert.ok(result.startsWith('```markdown\n'));
  assert.ok(result.endsWith('\n```'));
});
