import { style } from '@vanilla-extract/css';
import { themeVars } from '../theme.css';

export const navigation = style({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.5rem 1.25rem',
  marginBlock: '1rem 1.5rem',
  borderBlockEnd: `1px solid ${themeVars.line}`,
});

export const navLink = style({
  minBlockSize: '2.75rem',
  display: 'inline-flex',
  alignItems: 'center',
  paddingBlock: '0.25rem',
  color: themeVars.accentStrong,
  selectors: {
    '&[aria-current="page"]': { fontWeight: '700', textDecorationThickness: '0.15em' },
    '&:focus-visible': { outline: `3px solid ${themeVars.focusRing}`, outlineOffset: '2px' },
  },
});

export const content = style({ maxInlineSize: '62rem', minInlineSize: 0, overflowWrap: 'anywhere' });

export const section = style({
  marginBlockStart: '1.5rem',
  paddingBlockStart: '1rem',
  borderBlockStart: `1px solid ${themeVars.line}`,
});

export const details = style({
  display: 'grid',
  gridTemplateColumns: 'minmax(7rem, 0.8fr) minmax(0, 2fr)',
  gap: '0.5rem 1.25rem',
  marginBlock: '1rem',
  '@media': { '(max-width: 32rem)': { gridTemplateColumns: 'minmax(0, 1fr)', gap: '0.25rem' } },
});

export const term = style({ color: themeVars.muted, fontWeight: 650 });
export const value = style({ marginInlineStart: 0, fontVariantNumeric: 'tabular-nums' });
export const hint = style({ color: themeVars.muted, lineHeight: 1.6 });
export const fieldGroup = style({
  display: 'grid',
  alignItems: 'start',
  gap: '0.75rem',
  minInlineSize: 0,
  padding: 0,
  marginBlockStart: '0.8rem',
  border: 0,
});
export const form = style({ maxInlineSize: '38rem', display: 'grid', gap: '0.75rem' });
export const field = style({ display: 'grid', gap: '0.3rem', minInlineSize: 0, fontWeight: 650 });
export const input = style({
  minInlineSize: 0,
  inlineSize: '100%',
  minBlockSize: '2.75rem',
  padding: '0.55rem 0.7rem',
  border: `1px solid ${themeVars.inputBorder}`,
  borderRadius: '0.35rem',
  color: themeVars.ink,
  background: themeVars.pageBg,
  font: 'inherit',
  fontWeight: 'normal',
  selectors: {
    '&:focus-visible': { outline: `3px solid ${themeVars.focusRing}`, outlineOffset: '2px' },
    '&:user-invalid': { borderColor: themeVars.errorBorder },
  },
});
export const check = style({ display: 'flex', gap: '0.55rem', alignItems: 'baseline', lineHeight: 1.55 });
export const checkInput = style({ accentColor: themeVars.accentStrong });
export const list = style({ paddingInlineStart: 0, listStyle: 'none' });
export const listItem = style({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: '0.25rem 0.75rem',
  paddingBlock: '0.55rem',
  borderBlockEnd: `1px solid ${themeVars.line}`,
});
export const detailRow = style({ display: 'contents' });
export const runId = style({ marginInlineStart: '0.6rem', fontWeight: 'normal' });
