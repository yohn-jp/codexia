import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch, inject, start, validate } from '../../model.mjs';
import { features } from './feature.mjs';

const fixture = 'tide-studio';
const launch = (checkpoint = 'library') => start(validate(features), 'desktop', 'desktop-author', fixture, checkpoint);
const step = (state, ...events) => events.reduce((current, event) =>
  typeof event === 'string' ? dispatch(current, event) : dispatch(current, ...event), state);
const editor = () => step(launch(), 'open-project', ['open-document', 'scene-departure']);

test('a lost save is reconciled by the same ID and cannot own later typing', () => {
  let state = step(editor(), ['edit', '霧の中へ。'], 'protect', 'save', ['edit', '霧の中へ。さらに一行。']);
  const id = state.context.operation;
  state = step(inject(state, 'timeout'), 'response');
  assert.equal(state.screen, 'REC-01');
  assert.equal(state.context.receipt, null);
  state = step(state, 'reconcile');
  assert.equal(state.context.operation, null);
  assert.equal(state.context.receipt.operation, id);
  assert.equal(state.context.committed, '霧の中へ。');
  assert.equal(state.context.draft, '霧の中へ。さらに一行。');
  assert.equal(state.context.journal, 'pending');
});

test('composition and quota stop navigation while preserving text and position', () => {
  let state = step(editor(), ['position', [2, 4, 30]], 'composition-start', ['edit', '汽笛が鳴った。']);
  state = step(state, 'reading');
  assert.equal(state.screen, 'WRT-01');
  assert.equal(state.context.draft, '汽笛が鳴った。');
  state = step(inject(step(state, 'composition-end'), 'quota'), 'protect');
  assert.equal(state.screen, 'REC-01');
  assert.equal(state.context.journal, 'at-risk');
  assert.deepEqual(state.context.selection, [2, 4]);
  state = step(state, 'protect', 'reading', 'back-editor');
  assert.equal(state.screen, 'WRT-01');
  assert.equal(state.context.scroll, 30);
});

test('approval does not apply; refusal and unknown do not create a second operation', () => {
  let state = step(editor(), 'review', 'open-proposal', 'apply');
  assert.equal(state.context.proposal, 'proposed');
  assert.equal(state.context.receipt, null);
  state = step(state, 'approve');
  assert.equal(state.context.proposal, 'approved');
  assert.equal(state.context.receipt, null);
  state = step(inject(state, 'timeout'), 'apply');
  const id = state.context.pendingApply.operation;
  state = step(state, 'apply');
  assert.equal(state.context.pendingApply.operation, id);
  assert.equal(state.context.proposalReceipt, undefined);
  state = step(state, 'reconcile-application');
  assert.equal(state.context.proposalReceipt.operation, id);
  assert.equal(state.context.proposal, 'applied');
});

test('only known scene IDs can open and failed import does not replace a project', () => {
  const library = launch();
  const invalid = step(library, 'import', ['import-project', '{"title":"unknown"}']);
  assert.equal(invalid.context.project, library.context.project);
  assert.equal(invalid.history.at(-1).outcome, 'refused');
  const outline = step(library, 'open-project');
  const missing = step(outline, ['open-document', 'foreign-document']);
  assert.equal(missing.screen, 'OUT-01');
  assert.equal(missing.context.document, outline.context.document);
});

test('a corrupted workspace falls back without changing draft or replacing saved layout', () => {
  const state = step(editor(), 'display');
  const lost = step(inject(state, 'invalid'), 'save-layout');
  assert.equal(lost.context.layout.status, 'fallback');
  assert.deepEqual(lost.context.savedLayout, state.context.savedLayout);
  assert.equal(lost.context.draft, state.context.draft);
});

test('definitive save rejection allows retry and retains draft, cursor and journal', () => {
  let state = step(editor(), ['edit', '再試行で保存する原稿'], ['position', [1, 4, 20]], 'protect', 'save');
  state = step(inject(state, 'forbidden'), 'response');
  assert.equal(state.context.operation, null);
  assert.equal(state.context.draft, '再試行で保存する原稿');
  assert.equal(state.context.journal, 'protected');
  assert.deepEqual(state.context.selection, [1, 4]);
  state = step(state, 'return-to-editor', 'save', 'response');
  assert.equal(state.context.committed, '再試行で保存する原稿');
});

test('protected drafts survive creating another work and reopening the first from Library', () => {
  let state = step(editor(), ['edit', '最初の作品の下書き'], 'protect', 'outline', 'back-library',
    'create-project', ['confirm-project', '別の作品'], 'back-library', ['open-project', 'synthetic-tide'],
    ['open-document', 'scene-departure']);
  assert.equal(state.context.draft, '最初の作品の下書き');
  assert.equal(state.context.committed.startsWith('汽笛'), true);
});

test('saving the manuscript and changing the publishing selection cannot rebind an approved operation', () => {
  let state = step(editor(), 'modules', 'publishing', ['publishing-scope', 'chapter-two'], ['propose-share', '24'],
    'approve', 'back-publishing', ['publishing-scope', 'chapter-three'], 'back-modules', 'back-editor', 'review', 'open-proposal');
  state = step(inject(state, 'timeout'), 'apply');
  const id = state.context.pendingApply.operation;
  state = step(state, 'back-review', 'back-editor', ['edit', '保存済みの新しい版'], 'protect', 'save', 'response',
    'review', 'open-proposal', 'apply');
  assert.equal(state.context.pendingApply.operation, id);
  state = step(state, 'reconcile-application');
  assert.equal(state.context.share.scope, 'chapter-two');
  assert.equal(state.context.proposalReceipt.operation, id);
  assert.equal(state.context.committed, '保存済みの新しい版');
});
