import { scopedGlobalStyle as globalStyle } from '../styles/scoped-global-style.css';

globalStyle('.cm-term-adornment', {
  textDecorationLine: 'underline',
  textDecorationStyle: 'dotted',
  textDecorationColor: 'currentColor',
  textUnderlineOffset: '0.18em',
});
globalStyle('.cm-text-anchor', { borderRadius: '0.12em', paddingInline: '0.02em' });
globalStyle('.cm-text-anchor-current', {
  borderBottom: '1px solid color-mix(in srgb, currentColor 55%, transparent)',
  background: 'color-mix(in srgb, currentColor 7%, transparent)',
});
globalStyle('.cm-text-anchor-current[role="link"]', { cursor: 'pointer' });
globalStyle('.cm-text-anchor-needs_review', {
  borderBottom: '1px dashed #9a6700',
  background: 'color-mix(in srgb, #e7a520 15%, transparent)',
  textDecoration: 'underline wavy #9a6700',
  textUnderlineOffset: '0.2em',
});
globalStyle('.cm-text-anchor-proposed', {
  borderBottom: '1px dotted color-mix(in srgb, currentColor 55%, transparent)',
  background: 'color-mix(in srgb, currentColor 4%, transparent)',
});
globalStyle('.text-anchor-panel', {
  marginBlock: '0.75rem',
  border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
  borderRadius: '0.45rem',
  padding: '0.45rem 0.7rem',
  color: 'inherit',
  background: 'color-mix(in srgb, currentColor 3%, transparent)',
});
globalStyle('.text-anchor-panel > summary', { cursor: 'pointer', fontWeight: '600' });
globalStyle('.text-anchor-list', { display: 'grid', gap: '0.5rem', margin: '0.75rem 0 0', padding: '0', listStyle: 'none' });
globalStyle('.text-anchor-list li', {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'baseline',
  gap: '0.4rem 0.65rem',
  borderTop: '1px solid color-mix(in srgb, currentColor 12%, transparent)',
  paddingTop: '0.5rem',
});
globalStyle('.text-anchor-status', {
  borderRadius: '999px',
  padding: '0.1rem 0.45rem',
  background: 'color-mix(in srgb, currentColor 9%, transparent)',
  fontSize: '0.8em',
});
globalStyle('.text-anchor-status.is-needs_review,\n.text-anchor-status.is-revision_conflict,\n.text-anchor-status.is-orphaned', {
  color: 'color-mix(in srgb, currentColor 76%, #9a6700)',
  background: 'color-mix(in srgb, #e7a520 16%, transparent)',
});
globalStyle('.text-anchor-status.is-proposed,\n.text-anchor-candidate,\n.text-anchor-assertion', {
  color: 'color-mix(in srgb, currentColor 78%, #805500)',
});
globalStyle('.text-anchor-candidate,\n.text-anchor-assertion', { fontSize: '0.9em' });
globalStyle('.text-anchor-reference', { fontWeight: '600' });
globalStyle('.text-anchor-list q', { color: 'color-mix(in srgb, currentColor 75%, transparent)' });
globalStyle('.term-navigation', {
  display: 'inline',
  minHeight: '0',
  margin: '0',
  padding: '0',
  border: '0',
  borderRadius: '0',
  color: 'inherit',
  background: 'transparent',
  font: 'inherit',
  letterSpacing: 'inherit',
  lineHeight: 'inherit',
  textAlign: 'inherit',
  textDecorationLine: 'underline',
  textDecorationStyle: 'dotted',
  textDecorationColor: 'currentColor',
  textUnderlineOffset: '0.18em',
  cursor: 'pointer',
});
globalStyle('.term-navigation:focus-visible', { outline: '2px solid currentColor', outlineOffset: '2px' });
