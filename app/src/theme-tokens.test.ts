import assert from 'node:assert/strict';
import test from 'node:test';
import { themeTokens } from './theme-tokens';

const modes = ['light', 'dark', 'paper'] as const;
const expectedTokens = [
  'accent',
  'accentStrong',
  'badgeBg',
  'badgeSelectedBg',
  'badgeSelectedBorder',
  'buttonForeground',
  'dangerBg',
  'dangerBorder',
  'dangerForeground',
  'dangerHover',
  'diffAdd',
  'diffRemove',
  'diffRemoveText',
  'error',
  'errorBg',
  'errorBorder',
  'errorText',
  'focusRing',
  'focusShadow',
  'ink',
  'inputBorder',
  'line',
  'manuscriptSans',
  'manuscriptSerif',
  'muted',
  'pageBg',
  'paper',
  'paperDark',
  'placeholder',
  'proposalBg',
  'readerBorder',
  'rubyMuted',
  'scratchBg',
  'sidebarBg',
  'success',
  'surfaceHover',
  'surfaceSelected',
  'surfaceSelectedBorder',
  'surfaceSubtle',
  'toolbarBg',
].sort();

test('light, dark and paper define the same typed semantic token set', () => {
  for (const mode of modes) {
    assert.deepEqual(Object.keys(themeTokens[mode]).sort(), expectedTokens);
  }
});

test('the accepted theme accents remain mapped to their semantic tokens', () => {
  assert.equal(themeTokens.light.accent, '#70452f');
  assert.equal(themeTokens.dark.accent, '#7daf9f');
  assert.equal(themeTokens.paper.accent, '#3d3429');
  assert.equal(themeTokens.light.badgeSelectedBorder, 'var(--surface-selected-border)');
  assert.equal(themeTokens.dark.errorBorder, 'var(--error)');
});
