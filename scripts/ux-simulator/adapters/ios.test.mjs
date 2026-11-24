import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { project } from './ios.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const overrides = (changes = new Map()) => ({
  read(path) {
    if (changes.has(path)) return changes.get(path);
    return readFileSync(resolve(root, path), 'utf8');
  },
  exists(path) { return existsSync(resolve(root, path)); },
  list(path) {
    const visit = (absolute, relative) => readdirSync(absolute, { withFileTypes: true })
      .flatMap((entry) => entry.isDirectory()
        ? visit(resolve(absolute, entry.name), relative + '/' + entry.name)
        : [relative + '/' + entry.name]);
    return visit(resolve(root, path), path).sort();
  },
  location(path, symbol) {
    const lines = this.read(path).split('\n');
    const index = lines.findIndex((line) => line.includes(symbol));
    return index < 0 ? null : { path, line: index + 1, symbol };
  },
});

const appPath = 'ios/CodexiaApp/Sources/CodexiaApp.swift';
const authoringPath = 'ios/CodexiaEditor/Sources/CodexiaEditor/AuthoringView.swift';
const source = overrides();

test('iOS projection is derived from source-bound SwiftUI structure and reports explicit placeholders', () => {
  const projection = project(source);
  const screenIds = projection.screens.map(({ id }) => id);
  assert.ok(screenIds.includes('LIB-01'));
  assert.ok(screenIds.includes('OUT-01'));
  assert.ok(screenIds.includes('WRT-01'));
  assert.ok(screenIds.includes('READ-01'));
  assert.ok(screenIds.includes('impl:ios.fixture-project'));
  assert.deepEqual(projection.controls.map(({ id }) => id), ['LIB-01.A', 'OUT-01.B', 'WRT-01.B']);
  assert.ok(projection.transitions.some(({ id, from, to, control }) =>
    id === 'ios.nav.outline.open-editor' && from === 'OUT-01' && to === 'WRT-01' && control === 'OUT-01.B'));
  assert.ok(projection.transitions.some(({ id, to }) => id === 'ios.nav.library.fixtureproject' && to === 'impl:ios.fixture-project'));
  assert.ok(projection.transitions.some(({ id, from, to, method }) =>
    id === 'ios.sheet.open.reading' && from === 'WRT-01' && to === 'READ-01' && method === 'static'));
  assert.deepEqual(projection.gaps.map(({ id, status }) => [id, status]), [
    ['WRT-02', 'unimplemented'], ['REV-01', 'unimplemented'], ['KNO-01', 'unimplemented'], ['PREF-01', 'unimplemented'],
  ]);
  for (const record of [...projection.screens, ...projection.controls, ...projection.transitions, ...projection.gaps]) {
    assert.ok(record.source);
    assert.ok(source.read(record.source.path).split('\n')[record.source.line - 1].includes(record.source.symbol));
  }
});

test('removing a Swift control annotation removes the observed control and transition mapping', () => {
  const original = source.read(appPath);
  const mutated = original.replace('.accessibilityIdentifier("CTRL-LIB-01.A")', '.accessibilityIdentifier("fixture.open-project")');
  assert.notEqual(mutated, original);
  const before = project(source);
  const after = project(overrides(new Map([[appPath, mutated]])));
  assert.ok(before.controls.some(({ id }) => id === 'LIB-01.A'));
  assert.ok(!after.controls.some(({ id }) => id === 'LIB-01.A'));
  assert.ok(before.transitions.some(({ id, control }) => id === 'ios.nav.library.fixtureproject' && control === 'LIB-01.A'));
  assert.ok(after.transitions.some(({ id, control }) => id === 'ios.nav.library.fixtureproject' && control === undefined));
});

test('removing a SwiftUI navigation declaration removes the derived route', () => {
  const original = source.read(appPath);
  const mutated = original.replace('NavigationLink("サンプル作品") { FixtureProjectView() }', 'Text("サンプル作品")');
  assert.notEqual(mutated, original);
  const before = project(source);
  const after = project(overrides(new Map([[appPath, mutated]])));
  assert.ok(before.transitions.some(({ id }) => id === 'ios.nav.library.fixtureproject'));
  assert.ok(!after.transitions.some(({ id }) => id === 'ios.nav.library.fixtureproject'));
});

test('detaching the outline editor action or destination callback removes the observed editor transition', () => {
  const original = source.read(appPath);
  const assignment = original.replace('editor = FixtureEditingSession(characterCount: count)', '_ = count');
  const callback = original.replace('if editor === session { editor = nil }', 'if false { editor = nil }');
  assert.notEqual(assignment, original);
  assert.notEqual(callback, original);
  const before = project(source);
  const noSelection = project(overrides(new Map([[appPath, assignment]])));
  const detachedDestination = project(overrides(new Map([[appPath, callback]])));
  assert.ok(before.transitions.some(({ id }) => id === 'ios.nav.outline.open-editor'));
  assert.ok(!noSelection.transitions.some(({ id }) => id === 'ios.nav.outline.open-editor'));
  assert.ok(!detachedDestination.transitions.some(({ id }) => id === 'ios.nav.outline.open-editor'));
  assert.ok(!detachedDestination.transitions.some(({ id }) => id === 'ios.nav.editor.back-to-outline'));
});

test('removing the SwiftUI reference case changes the projected sheet inventory', () => {
  const original = source.read(authoringPath);
  const mutated = original.replace('case reading, history, review, knowledge, settings', 'case reading, review, knowledge, settings');
  assert.notEqual(mutated, original);
  const before = project(source);
  const after = project(overrides(new Map([[authoringPath, mutated]])));
  assert.ok(before.screens.some(({ id }) => id === 'impl:WRT-02'));
  assert.ok(!after.screens.some(({ id }) => id === 'impl:WRT-02'));
  assert.ok(before.transitions.some(({ id }) => id === 'ios.sheet.open.history'));
  assert.ok(!after.transitions.some(({ id }) => id === 'ios.sheet.open.history'));
});
