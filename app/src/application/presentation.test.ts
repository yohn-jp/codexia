import assert from 'node:assert/strict';
import test from 'node:test';
import type { UiContribution } from '@codexia/contracts';
import type { ProjectId } from '@codexia/persistence-contracts';
import { endFileScope, setFileScope } from '@vanilla-extract/css/fileScope';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The Node/tsx SSR test does not run Vite's vanilla-extract transform.
// Evaluate the real recipe once in its file scope before loading consumers.
setFileScope('src/components/button.css.ts', '@codexia/app');
try {
  await import('../components/button.css');
} finally {
  endFileScope();
}
const buttonStyles = (await import('../components/button.css')) as unknown as {
  buttonRecipe?: (options: { size?: 'compact' }) => string;
};
let scopeGlobalSelector: ((selector: string) => string) | undefined;
setFileScope('src/styles/scoped-global-style.css.ts', '@codexia/app');
try {
  const scopedStyles = (await import('../styles/scoped-global-style.css')) as unknown as {
    scopeGlobalSelector?: typeof scopeGlobalSelector;
  };
  scopeGlobalSelector = scopedStyles.scopeGlobalSelector;
} catch {
  // Keep the red test assertion focused on the missing scoping contract.
} finally {
  endFileScope();
}
const { ApplicationStatus, hasApplicationStatus } = await import('./ApplicationStatus');
const { availableModulePanels } = await import('./AvailableModulePanels');
const { DocumentInspector } = await import('./DocumentInspector');
const { LibraryOutline } = await import('./LibraryOutline');

const tree = {
  title: 'Novel',
  volumes: [
    {
      id: 'volume-1',
      title: 'Volume One',
      chapters: [{ id: 'chapter-1', title: 'Chapter One', scenes: [{ id: 'scene-1', title: 'Opening' }] }],
    },
  ],
};

test('shared button recipe exposes a distinct compact size variant', () => {
  assert.equal(typeof buttonStyles.buttonRecipe, 'function');
  assert.notEqual(buttonStyles.buttonRecipe?.({}), buttonStyles.buttonRecipe?.({ size: 'compact' }));
});

test('global component selectors stay inside the React root while document and theme roots remain global', () => {
  assert.equal(typeof scopeGlobalSelector, 'function');
  assert.equal(
    scopeGlobalSelector?.('.panel, body, :root[data-zp-theme="dark"] .panel'),
    ':where(#root) :is(.panel),\nbody,\n:root[data-zp-theme="dark"] :where(#root) :is(.panel)',
  );
  assert.equal(
    scopeGlobalSelector?.('.shell :is(.a, .b), .shell[data-label="a,b"] .item'),
    ':where(#root) :is(.shell :is(.a, .b)),\n:where(#root) :is(.shell[data-label="a,b"] .item)',
  );
});

test('status presentation hides an empty state and exposes current errors and recovery visibility', () => {
  const emptyProps = {
    status: { message: '', kind: 'normal' },
    globalError: '',
    journalOpenError: '',
    isolatedRecoveryCount: 0,
    remoteState: 'fresh',
  } as const;
  assert.equal(hasApplicationStatus(emptyProps), false);
  const empty = renderToStaticMarkup(createElement(ApplicationStatus, emptyProps));
  assert.match(empty, /保存と接続/u);
  assert.doesNotMatch(empty, /<details[^>]* open/u);

  const visible = renderToStaticMarkup(
    createElement(ApplicationStatus, {
      status: { message: '保存に失敗しました', kind: 'error' },
      globalError: '通信を確認してください',
      journalOpenError: '回復記録を開けません',
      isolatedRecoveryCount: 2,
      remoteState: 'failed',
    }),
  );
  assert.match(visible, /aria-live="assertive"/u);
  assert.match(visible, /role="alert"/u);
  assert.match(visible, /回復記録 2 件/u);
  assert.match(visible, /データベース確認状態: failed/u);
});

test('library outline renders project, continuation, scene, and recovery controls from explicit props', () => {
  const markup = renderToStaticMarkup(
    createElement(LibraryOutline, {
      projects: [
        { id: 'project-1' as ProjectId, title: 'Novel', version: 1, settings: {}, createdAt: '2026-11-09', updatedAt: '2026-11-09' },
      ],
      activeProjectId: 'project-1',
      tree,
      selectedSceneId: 'scene-1',
      continueCandidates: [{ sceneId: 'scene-1', sentenceOffset: 2, pageIndex: 3, source: 'local', deviceType: 'desktop' }],
      deviceType: 'desktop',
      continueError: '',
      recoverableEntries: [],
      onActivateProject: () => undefined,
      onContinue: () => undefined,
      onSelectScene: () => undefined,
    }),
  );
  assert.match(markup, /Novel/u);
  assert.match(markup, /aria-current="true"/u);
  assert.match(markup, /作品構成/u);
  assert.match(markup, /Chapter One: Opening/u);
  assert.match(markup, /<button[^>]*>続きを書く<\/button>/u);
  assert.match(markup, /<button[^>]*>読書位置を開く<\/button>/u);
});

test('document inspector renders only the document facts and recovery records it receives', () => {
  const markup = renderToStaticMarkup(
    createElement(DocumentInspector, {
      status: createElement('p', null, '保存状態'),
      editorFacts: { path: 'manuscript/opening.md', snapshot: 'snapshot-1', recoveryStatus: 'ready' },
      inspectedDocument: { path: 'notes/outline.md', content: 'Outline text' },
      recoveryEntries: [],
    }),
  );
  assert.match(markup, /aria-label="文書と保存状態"/u);
  assert.match(markup, /manuscript\/opening\.md/u);
  assert.match(markup, /snapshot-1/u);
  assert.match(markup, /notes\/outline\.md/u);
  assert.match(markup, /Outline text/u);
});

test('an available panel keeps its workspace identity and explains a missing project', () => {
  const contribution: UiContribution = {
    id: 'story:panel',
    module: 'story',
    slot: 'dock',
    title: 'Story tools',
    action: 'story.search',
  };
  const panels = availableModulePanels({
    items: [contribution],
    contributions: [contribution],
    modules: [{ id: 'story', availability: 'active', activeJobs: 0 }],
    projectId: null,
    authorScope: 'author:one',
    snapshot: null,
    journal: null,
    refresh: async () => undefined,
    onProposalStored: () => undefined,
    onNativeChangeSetProposed: () => undefined,
    readCurrentEditor: () => null,
    navigateDocument: async () => undefined,
  });
  assert.deepEqual(
    panels.map(({ id, title }) => [id, title]),
    [['module:story:panel', 'Story tools']],
  );
  const panel = panels[0];
  assert.ok(panel);
  const markup = renderToStaticMarkup(createElement(Fragment, null, panel.render()));
  assert.match(markup, /作品を選択してください/u);
});
