import { createGlobalTheme, createGlobalThemeContract, globalStyle } from '@vanilla-extract/css';
import { themeTokens } from './theme-tokens';

function toKebab(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/gu, '$1-$2').toLowerCase();
}

function contractFor<T extends Record<string, string>>(tokens: T): { [Key in keyof T]: null } {
  return Object.fromEntries(Object.keys(tokens).map(key => [key, null])) as { [Key in keyof T]: null };
}

function mapTokenName(prefix = ''): (value: string | null, path: string[]) => string {
  return (_value, path) => `--${prefix}${path.map(toKebab).join('-')}`;
}

export const themeVars = createGlobalThemeContract(contractFor(themeTokens.light), mapTokenName());

createGlobalTheme(':root', themeVars, themeTokens.light);
createGlobalTheme(':root[data-zp-theme="dark"]', themeVars, themeTokens.dark);
createGlobalTheme(':root[data-zp-theme="paper"]', themeVars, themeTokens.paper);

globalStyle(':root', { colorScheme: 'light' });
globalStyle(':root[data-zp-theme="dark"]', { colorScheme: 'dark' });
globalStyle(':root[data-zp-theme="paper"]', { colorScheme: 'light' });
