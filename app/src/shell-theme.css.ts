import { createGlobalTheme, createGlobalThemeContract } from '@vanilla-extract/css';
import { editorialShellTokens, type themeTokens, writingShellTokens } from './theme-tokens';

function tokenContract() {
  const contract = Object.fromEntries(Object.keys(editorialShellTokens.light).map(key => [key, null])) as {
    [Key in keyof typeof editorialShellTokens.light]: null;
  };
  return createGlobalThemeContract(contract, (_value, path) => {
    const name = path
      .join('-')
      .replace(/([a-z0-9])([A-Z])/gu, '$1-$2')
      .toLowerCase();
    return `--st-${name}`;
  });
}

const shellVars = tokenContract();

function writingTokens(mode: keyof typeof themeTokens) {
  return {
    ...editorialShellTokens[mode],
    ...writingShellTokens[mode],
    rail: 'var(--st-canvas)',
    railInk: 'var(--ink)',
    railMuted: 'var(--muted)',
    railEdge: 'var(--line)',
    railSelected: 'var(--surface-selected)',
  };
}

createGlobalTheme('.st-desktop-shell', shellVars, editorialShellTokens.light);
createGlobalTheme(':root[data-zp-theme="dark"] .st-desktop-shell', shellVars, editorialShellTokens.dark);
createGlobalTheme(':root[data-zp-theme="paper"] .st-desktop-shell', shellVars, editorialShellTokens.paper);
createGlobalTheme('.st-studio-shell', shellVars, writingTokens('light'));
createGlobalTheme(':root[data-zp-theme="dark"] .st-studio-shell', shellVars, writingTokens('dark'));
createGlobalTheme(':root[data-zp-theme="paper"] .st-studio-shell', shellVars, writingTokens('paper'));
