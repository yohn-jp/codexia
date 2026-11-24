import { createGlobalTheme, createGlobalThemeContract, globalStyle } from '@vanilla-extract/css';
import type { ThemeMode } from './theme';
import { themeTokens } from './theme-tokens';

const oauthTokenNames = [
  'accent',
  'accentStrong',
  'buttonForeground',
  'focusRing',
  'focusShadow',
  'ink',
  'inputBorder',
  'line',
  'manuscriptSans',
  'muted',
  'pageBg',
  'paper',
] as const satisfies readonly (keyof typeof themeTokens.light)[];

type OAuthTokenName = (typeof oauthTokenNames)[number];
type OAuthThemeTokens = Pick<typeof themeTokens.light, OAuthTokenName>;

const contract = Object.fromEntries(oauthTokenNames.map(name => [name, null])) as {
  [Key in OAuthTokenName]: null;
};
const variables = createGlobalThemeContract(contract, (_value, path) => {
  const name = path
    .join('-')
    .replace(/([a-z0-9])([A-Z])/gu, '$1-$2')
    .toLowerCase();
  return `--${name}`;
});

function oauthTokens(mode: ThemeMode): OAuthThemeTokens {
  return Object.fromEntries(oauthTokenNames.map(name => [name, themeTokens[mode][name]])) as OAuthThemeTokens;
}

createGlobalTheme(':root', variables, oauthTokens('light'));
createGlobalTheme(':root[data-zp-theme="dark"]', variables, oauthTokens('dark'));
createGlobalTheme(':root[data-zp-theme="paper"]', variables, oauthTokens('paper'));

globalStyle(':root', { colorScheme: 'light' });
globalStyle(':root[data-zp-theme="dark"]', { colorScheme: 'dark' });
globalStyle(':root[data-zp-theme="paper"]', { colorScheme: 'light' });
