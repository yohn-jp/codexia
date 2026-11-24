import assert from 'node:assert/strict';
import test from 'node:test';
import { project } from './desktop.mjs';

function fixture() {
  const files = new Map([
    ['app/src/entries/desktop.tsx', 'window.location.pathname; <PersistenceEntry mode="desktop" />'],
    ['app/src/persistence/DocumentOutlineTree.tsx', '<button data-ux-control="OUT-01.B" onClick={() => item.primaryAction()}>Scene</button>'],
    ['app/src/persistence/PersistenceWorkspace.tsx', [
      '<button data-ux-control="WRT-01.A" onClick={() => saveDocument()}>Save</button>',
      '<button data-ux-control="WRT-01.B" onClick={() => protectTransition()}>Read</button>',
      '<button data-ux-control="WRT-02.A" onClick={() => loadRevisions()}>History</button>',
      '<button data-ux-control="WRT-02.B" onClick={() => restoreRevision()}>Restore</button>',
      'PersistenceWorkspaceController',
    ].join('\n')],
    ['app/src/persistence/NativeChangeSetReview.tsx', [
      '<button data-ux-control="REV-01.A" onClick={() => inspect()}>Review</button>',
      '<button data-ux-control="REV-02.A" onClick={() => updateAfterAction()}>Approve</button>',
    ].join('\n')],
    ['app/src/application/KnowledgeEvidenceList.tsx', 'export function KnowledgeEvidenceList() {} onOpenEvidence'],
    ['app/src/application/AvailableModulePanels.tsx', 'export function AvailableModulePanels() {}'],
    ['app/src/components/JobInbox.tsx', 'export function JobInbox() {}'],
    ['app/src/components/ThemeControl.tsx', 'export function ThemeControl() {}'],
    ['app/src/shells/desktop/DesktopShell.tsx', 'requestConsoleNavigation'],
    ['app/src/application/persistence-save-machine.ts', 'createMachine({ id: "persistenceSave", states: { active: { on: { "SAVE.MANUAL": { guard: ({ context, event }) => event.type === "SAVE.MANUAL" && context.dirty, target: "saving" } } } } })'],
  ]);
  return {
    read(path) { if (!files.has(path)) throw new Error(`missing ${path}`); return files.get(path); },
    exists(path) { return files.has(path); },
    list(dir) { return [...files.keys()].filter((path) => path.startsWith(dir + '/')).sort(); },
    location(path, needle) {
      const content = files.get(path);
      const index = content?.indexOf(needle) ?? -1;
      return index < 0 ? null : { path, line: content.slice(0, index).split('\n').length, symbol: needle };
    },
    files,
  };
}

test('Desktop projection follows canonical React controls and XState references', () => {
  const source = fixture();
  const before = project(source);
  assert.ok(before.screens.some(({ id }) => id === 'LIB-01'));
  assert.equal(before.controls.find(({ id }) => id === 'WRT-01.A').handler, 'saveDocument');
  assert.equal(before.controls.find(({ id }) => id === 'WRT-01.A').label, 'Save');
  assert.equal(before.controls.find(({ id }) => id === 'OUT-01.B').handler, 'item.primaryAction');
  assert.equal(before.controls.find(({ id }) => id === 'REV-02.A').handler, 'updateAfterAction');
  assert.ok(before.transitions.some(({ event, from, condition }) => event === 'SAVE.MANUAL' && from === 'WRT-01/active' && condition.includes('context.dirty')));

  const entry = source.files.get('app/src/entries/desktop.tsx');
  source.files.set('app/src/entries/desktop.tsx', entry.replace('window.location.pathname', 'window.location.routePath'));
  source.files.set('app/src/persistence/PersistenceWorkspace.tsx', source.files.get('app/src/persistence/PersistenceWorkspace.tsx')
    .replace('saveDocument()', 'submitCurrentDraft()').replace('>Save</button>', '>Store</button>')
    .replace('data-ux-control="WRT-02.B" ', ''));
  source.files.set('app/src/application/persistence-save-machine.ts', source.files.get('app/src/application/persistence-save-machine.ts')
    .replace('SAVE.MANUAL', 'SAVE.RETRY').replace('context.dirty', 'context.remoteConflict'));

  const after = project(source);
  assert.equal(after.screens.find(({ id }) => id === 'ENTRY-01'), undefined);
  assert.equal(after.controls.find(({ id }) => id === 'WRT-01.A').handler, 'submitCurrentDraft');
  assert.equal(after.controls.find(({ id }) => id === 'WRT-01.A').label, 'Store');
  assert.equal(after.controls.find(({ id }) => id === 'WRT-02.B'), undefined);
  assert.ok(after.gaps.some(({ id }) => id === 'WRT-02.B'));
  assert.ok(after.transitions.some(({ event, condition }) => event === 'SAVE.RETRY' && condition.includes('context.remoteConflict')));
  assert.ok(!after.transitions.some(({ event }) => event === 'SAVE.MANUAL'));

  source.files.set('app/src/persistence/PersistenceWorkspace.tsx', source.files.get('app/src/persistence/PersistenceWorkspace.tsx').replace('submitCurrentDraft()', 'undefined'));
  const callbackRemoved = project(source);
  assert.ok(!callbackRemoved.controls.some(({ id }) => id === 'WRT-01.A'));
  assert.ok(callbackRemoved.gaps.some(({ id }) => id === 'WRT-01.A'));
});
