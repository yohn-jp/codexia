import assert from 'node:assert/strict';
import test from 'node:test';
import type { UiContribution } from '@codexia/contracts';
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
const { availableModulePanels } = await import('./AvailableModulePanels');

test('shared button recipe exposes a distinct compact size variant', () => {
  assert.equal(typeof buttonStyles.buttonRecipe, 'function');
  assert.notEqual(buttonStyles.buttonRecipe?.({}), buttonStyles.buttonRecipe?.({ size: 'compact' }));
});

test('global component selectors stay inside the React root while document and theme roots remain global', () => {
  assert.equal(typeof scopeGlobalSelector, 'function');
  assert.equal(
    scopeGlobalSelector?.('.panel, body, :root[data-zp-theme="dark"] .panel'),
    ':where(#root) .panel,\nbody,\n:root[data-zp-theme="dark"] :where(#root) .panel',
  );
  assert.equal(
    scopeGlobalSelector?.('.shell :is(.a, .b), .shell[data-label="a,b"] .item'),
    ':where(#root) .shell :is(.a, .b),\n:where(#root) .shell[data-label="a,b"] .item',
  );
});

test('global selector scoping preserves pseudo-elements and selector-list boundaries', () => {
  assert.equal(
    scopeGlobalSelector?.('.panel::before, .panel::after, x-scroll-host::part(scroll), dialog::backdrop'),
    ':where(#root) .panel::before,\n:where(#root) .panel::after,\n:where(#root) x-scroll-host::part(scroll),\n:where(#root) dialog::backdrop',
  );
  assert.equal(
    scopeGlobalSelector?.(':root[data-zp-theme="dark"] .panel::before, .shell:is(.a, .b) /* a,b */ .item'),
    ':root[data-zp-theme="dark"] :where(#root) .panel::before,\n:where(#root) .shell:is(.a, .b) /* a,b */ .item',
  );
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
