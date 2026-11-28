import assert from 'node:assert/strict';
import test from 'node:test';
import { EditorState, Text, type Transaction } from '@codemirror/state';
import { resolveBracketInput } from './editor/cm/bracketLogic';
import { dispatchManuscriptTransactions } from './editor/cm/editability';
import { ellipsisNormalizeExtension, normalizeEllipsisInsert } from './editor/cm/ellipsisNormalize';
import { externalDocumentSync } from './editor/cm/textAnchorDecorations';
import { clampPageIndex, measureColumnPageCount, pageTranslateX, tapZoneAtX } from './editor/readingMetrics';
import { documentBody, parseRubySegments, replaceDocumentBody } from './editor/ruby';
import { normalizeTypographySettings, typographyPresetValues } from './editor/typography';
import { planWritingSymbol } from './editor/writingSymbols';

test('writing input retains Japanese bracket pairing and skips an existing closer', () => {
  const empty = Text.of(['']);
  assert.deepEqual(resolveBracketInput(empty, 0, 0, '「'), { insert: '「」', cursor: 1 });
  assert.deepEqual(resolveBracketInput(Text.of(['」']), 0, 0, '「'), { insert: '「', cursor: 1 });
  assert.deepEqual(resolveBracketInput(Text.of(['」']), 0, 0, '」'), { insert: '', cursor: 1 });
  assert.equal(resolveBracketInput(empty, 0, 0, 'あ'), null);
});

test("single ellipses normalize to the source's two-character form", () => {
  assert.equal(normalizeEllipsisInsert('', '…', ''), '……');
  assert.equal(normalizeEllipsisInsert('前', '…', '後'), '……');
  assert.equal(normalizeEllipsisInsert('', '……', ''), '……');
});

test('typing after a complete ellipsis pair does not duplicate either character', () => {
  const state = EditorState.create({ doc: '前……後', extensions: [ellipsisNormalizeExtension()] });
  const updated = state.update({ changes: { from: 3, insert: 'y' } }).state;
  assert.equal(updated.doc.toString(), '前……y後');
});

test('normalizing an ellipsis preserves the input event and the caret for the next character', () => {
  for (const userEvent of ['input.type', 'input.paste', 'input.type.compose.end']) {
    const state = EditorState.create({ doc: '前後', selection: { anchor: 1 }, extensions: [ellipsisNormalizeExtension()] });
    const input = state.update(state.replaceSelection('…'), { userEvent });
    assert.equal(input.newDoc.toString(), '前……後');
    assert.equal(input.newSelection.main.head, 3);
    assert.equal(input.isUserEvent(userEvent), true);
    assert.equal(input.state.update(input.state.replaceSelection('次')).newDoc.toString(), '前……次後');
  }
});

test('external manuscript sync preserves the persisted ellipsis spelling', () => {
  const state = EditorState.create({ doc: '旧稿', extensions: [ellipsisNormalizeExtension()] });
  const updated = state.update({
    changes: { from: 0, to: state.doc.length, insert: '以前…の原稿' },
    annotations: externalDocumentSync.of(true),
  }).state;
  assert.equal(updated.doc.toString(), '以前…の原稿');
});

test('read-only editor rejects local transactions but permits external sync', () => {
  let state = EditorState.create({ doc: '本文', extensions: [EditorState.readOnly.of(true)] });
  const view = {
    update(transactions: readonly Transaction[]) {
      for (const transaction of transactions) state = transaction.state;
    },
  };
  dispatchManuscriptTransactions([state.update({ changes: { from: 2, insert: '入力' }, userEvent: 'input.type' })], view);
  dispatchManuscriptTransactions([state.update({ changes: { from: 2, insert: '……' }, filter: false })], view);
  assert.equal(state.doc.toString(), '本文');
  dispatchManuscriptTransactions([state.update({ selection: { anchor: 2 } })], view);
  assert.equal(state.selection.main.head, 2);
  const external = state.update({ changes: { from: 0, to: 2, insert: '同期' }, annotations: externalDocumentSync.of(true) });
  dispatchManuscriptTransactions([external], view);
  assert.equal(state.doc.toString(), '同期');
});

test("ruby parsing keeps the source's explicit Aozora syntax and frontmatter bytes", () => {
  const segments = parseRubySegments('彼は|東京《とうきょう》へ行く。');
  assert.deepEqual(
    segments.map(segment => (segment.kind === 'ruby' ? [segment.base, segment.reading] : segment.value)),
    ['彼は', ['東京', 'とうきょう'], 'へ行く。'],
  );
  const fullwidth = parseRubySegments('｜東京《とうきょう》');
  assert.equal(fullwidth.length, 1);
  assert.equal(fullwidth[0]?.kind === 'text' && fullwidth[0].value, '｜東京《とうきょう》');
  const document = '---\ntitle: 試験\n---\n\n本文\n';
  assert.deepEqual(documentBody(document), { prefix: '---\ntitle: 試験\n---\n\n', body: '本文\n' });
  assert.equal(replaceDocumentBody(document, '新しい本文'), '---\ntitle: 試験\n---\n\n新しい本文');
});

test('mobile writing symbols wrap selected text and preserve the cursor inside quotes', () => {
  assert.deepEqual(planWritingSymbol('本文', 0, 2, 'quotes'), {
    from: 0,
    to: 2,
    insert: '「本文」',
    cursor: 3,
  });
  assert.equal(planWritingSymbol('本文', 2, 2, 'paragraph').insert, '\n\n');
});

test('typography preferences retain source ranges and reject invalid values', () => {
  assert.deepEqual(normalizeTypographySettings({ fontSize: 100, lineHeight: 0, letterSpacing: 0.08, fontFamily: 'mincho' }), {
    fontSize: 16,
    lineHeight: 1.8,
    letterSpacing: 0.08,
    maxWidth: 960,
    fontFamily: 'mincho',
  });
  assert.deepEqual(normalizeTypographySettings(null), {
    fontSize: 16,
    lineHeight: 1.8,
    letterSpacing: 0,
    maxWidth: 960,
    fontFamily: 'gothic',
  });
  // Preset widths are a design contract in docs/design/VISUAL-SYSTEM.sdoc.
  assert.equal(typographyPresetValues('bunko').maxWidth, 560);
  assert.equal(typographyPresetValues('web-novel').maxWidth, 720);
  assert.equal(typographyPresetValues('genko').maxWidth, 480);
  assert.equal(normalizeTypographySettings({ maxWidth: 100 }).maxWidth, 960);
});

test('mobile reading pagination clamps pages, measures columns, and follows writing direction', () => {
  assert.equal(measureColumnPageCount(901, 300), 4);
  assert.equal(measureColumnPageCount(0, 300), 1);
  assert.equal(clampPageIndex(8, 4), 3);
  assert.equal(clampPageIndex(Number.NaN, 4), 0);
  assert.equal(pageTranslateX(2, 320, 'ltr'), -640);
  assert.equal(pageTranslateX(2, 320, 'rtl'), 640);
  assert.equal(pageTranslateX(0, 320, 'rtl', 960), -640);
  assert.equal(pageTranslateX(1, 320, 'rtl', 960), -320);
  assert.equal(tapZoneAtX(10, 0, 400), 'left');
  assert.equal(tapZoneAtX(390, 0, 400), 'right');
  assert.equal(tapZoneAtX(200, 0, 400), 'center');
});
