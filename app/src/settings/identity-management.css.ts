import { scopedGlobalStyle as globalStyle } from '../styles/scoped-global-style.css';

globalStyle('.identity-management', { minWidth: '0', color: 'var(--ink)' });
globalStyle('.identity-management h2,\n.identity-management h3,\n.identity-management h4,\n.identity-management h5', {
  margin: '0',
  color: 'var(--ink)',
  fontFamily: 'inherit',
  fontWeight: '650',
  lineHeight: '1.4',
});
globalStyle('.identity-management h2', { fontSize: '1.125rem' });
globalStyle('.identity-management h3', { fontSize: '1rem' });
globalStyle('.identity-management h4', { fontSize: '1rem' });
globalStyle('.identity-management h5', { fontSize: '0.875rem' });
globalStyle('.identity-management p', { margin: '0', lineHeight: '1.55' });
globalStyle(
  '.identity-management__trigger,\n.identity-management__primary,\n.identity-management__secondary,\n.identity-management__danger,\n.identity-management__danger-quiet',
  { minHeight: '44px', font: 'inherit', lineHeight: '1.35', cursor: 'pointer' },
);
globalStyle('.identity-management__trigger', {
  padding: '0.5rem 0.8rem',
  border: '1px solid var(--input-border)',
  borderRadius: '0.4rem',
  color: 'var(--accent-strong)',
  background: 'var(--paper)',
  whiteSpace: 'nowrap',
});
globalStyle('.identity-management__primary', {
  padding: '0.55rem 0.9rem',
  border: '1px solid var(--accent-strong)',
  borderRadius: '0.4rem',
  color: 'var(--button-foreground)',
  background: 'var(--accent)',
});
globalStyle('.identity-management__secondary', {
  padding: '0.5rem 0.8rem',
  border: '1px solid var(--input-border)',
  borderRadius: '0.4rem',
  color: 'var(--accent-strong)',
  background: 'transparent',
});
globalStyle('.identity-management__danger,\n.identity-management__danger-quiet', {
  padding: '0.5rem 0.8rem',
  border: '1px solid var(--input-border)',
  borderRadius: '0.4rem',
  color: 'var(--ink)',
  background: 'var(--paper)',
});
globalStyle('.identity-management__danger', { borderColor: '#8b352e', color: '#842a24', background: 'var(--paper)' });
globalStyle(
  '.identity-management__trigger:hover:not(:disabled),\n.identity-management__secondary:hover:not(:disabled),\n.identity-management__danger-quiet:hover:not(:disabled)',
  { background: 'var(--surface-hover)' },
);
globalStyle('.identity-management__primary:hover:not(:disabled)', { background: 'var(--accent-strong)' });
globalStyle('.identity-management__danger:hover:not(:disabled)', { background: '#f3e8e4' });
globalStyle('.identity-management :is(button, input):focus-visible', { outline: '3px solid var(--focus-ring)', outlineOffset: '2px' });
globalStyle('.identity-management :is(button, input):disabled', { opacity: '0.58', cursor: 'not-allowed' });
globalStyle('.identity-management__unavailable', {
  marginBlockStart: '1rem',
  padding: '1rem',
  border: '1px solid var(--line)',
  borderRadius: '0.55rem',
  background: 'var(--paper)',
});
globalStyle('.identity-management__unavailable p', { marginBlockStart: '0.5rem', color: 'var(--muted)' });
globalStyle('.identity-management__unavailable-inline', {
  maxWidth: '19rem',
  color: 'var(--muted)',
  fontSize: '0.875rem',
  lineHeight: '1.4',
});
globalStyle('.identity-management__content', { minWidth: '0' });
globalStyle('.identity-management__section', { minWidth: '0' });
globalStyle('.identity-management__section + .identity-management__section', {
  marginBlockStart: '1.45rem',
  paddingBlockStart: '1.35rem',
  borderBlockStart: '1px solid var(--line)',
});
globalStyle(
  '.identity-management__intro,\n.identity-management__hint,\n.identity-management__meta,\n.identity-management__empty,\n.identity-management__current-label',
  { color: 'var(--muted)', fontSize: '0.875rem' },
);
globalStyle('.identity-management__intro', { marginBlock: '0.45rem 1rem !important' });
globalStyle('.identity-management__hint', { marginBlockStart: '0.5rem !important' });
globalStyle('.identity-management__empty', { marginBlockStart: '0.7rem !important' });
globalStyle('.identity-management__add-form,\n.identity-management__inline-form', { display: 'grid', gap: '0.55rem', minWidth: '0' });
globalStyle('.identity-management__add-form', {
  marginBlock: '0.9rem 1rem',
  paddingBlockEnd: '1rem',
  borderBlockEnd: '1px solid var(--line)',
});
globalStyle('.identity-management__add-form label,\n.identity-management__inline-form label', {
  color: 'var(--ink)',
  fontSize: '0.875rem',
  fontWeight: '600',
});
globalStyle('.identity-management__form-row', { display: 'flex', alignItems: 'center', gap: '0.65rem', minWidth: '0' });
globalStyle('.identity-management input', {
  boxSizing: 'border-box',
  width: '100%',
  minWidth: '0',
  minHeight: '48px',
  padding: '0.6rem 0.7rem',
  border: '1px solid var(--input-border)',
  borderRadius: '0.4rem',
  color: 'var(--ink)',
  background: 'var(--paper)',
  font: 'inherit',
  fontSize: 'max(1rem, 1em)',
});
globalStyle('.identity-management__form-row input', { flex: '1 1 16rem' });
globalStyle('.identity-management__form-row button', { flex: '0 0 auto' });
globalStyle('.identity-management__list', { display: 'grid', gap: '0', margin: '0', padding: '0', listStyle: 'none' });
globalStyle('.identity-management__list-item', {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  alignItems: 'start',
  gap: '0.75rem 1rem',
  minWidth: '0',
  paddingBlock: '1rem',
  borderBlockStart: '1px solid var(--line)',
});
globalStyle('.identity-management__item-main', { display: 'grid', gap: '0.28rem', minWidth: '0' });
globalStyle('.identity-management__meta', { overflowWrap: 'anywhere' });
globalStyle('.identity-management__user-agent', { maxWidth: '54ch' });
globalStyle('.identity-management__actions', { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.5rem' });
globalStyle('.identity-management__inline-form,\n.identity-management__inline-confirm', {
  gridColumn: '1 / -1',
  marginBlockStart: '0.15rem',
});
globalStyle('.identity-management__inline-confirm', {
  display: 'grid',
  gap: '0.65rem',
  paddingBlockStart: '0.7rem',
  borderBlockStart: '1px solid var(--line)',
});
globalStyle('.identity-management__inline-confirm p', { fontWeight: '600' });
globalStyle('.identity-management__current-label', { gridColumn: '1 / -1' });
globalStyle('.identity-management__error,\n.identity-management__message', {
  marginBlock: '0.65rem !important',
  padding: '0.65rem 0.75rem',
  border: '1px solid var(--line)',
  borderRadius: '0.4rem',
  overflowWrap: 'anywhere',
});
globalStyle('.identity-management__error', { borderColor: '#9b554c', color: '#762720', background: '#f8efec' });
globalStyle('.identity-management__message', { color: 'var(--ink)', background: 'var(--surface-subtle)' });
globalStyle('.identity-management__loading', { display: 'grid', gap: '0.65rem', paddingBlock: '0.75rem' });
globalStyle('.identity-management__loading span', {
  display: 'block',
  width: 'min(100%, 30rem)',
  height: '0.8rem',
  borderRadius: '0.2rem',
  background: 'var(--surface-subtle)',
});
globalStyle('.identity-management__loading span:last-child', { width: 'min(72%, 20rem)' });
globalStyle('.identity-management__dialog', {
  boxSizing: 'border-box',
  width: 'min(48rem, calc(100vw - 2rem))',
  maxWidth: 'calc(100vw - 2rem)',
  maxHeight: 'min(88dvh, 54rem)',
  padding: '1.4rem clamp(1rem, 3vw, 1.8rem) 1.6rem',
  border: '1px solid var(--line)',
  borderRadius: '0.8rem',
  color: 'var(--ink)',
  background: 'var(--paper)',
  boxShadow: '0 12px 38px var(--focus-shadow)',
  overscrollBehavior: 'contain',
});
globalStyle('.identity-management__dialog::backdrop', {
  overflow: 'hidden',
  background: 'rgb(13 17 16 / 48%)',
  overscrollBehavior: 'contain',
});
globalStyle('.identity-management__dialog-header', {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '1rem',
  marginBlockEnd: '1rem',
  paddingBlockEnd: '0.9rem',
  borderBlockEnd: '1px solid var(--line)',
});
globalStyle('.identity-management__dialog .identity-management__section + .identity-management__section', {
  marginBlockStart: '1.25rem',
  paddingBlockStart: '1.15rem',
});
globalStyle('.identity-management--desktop .identity-management__trigger', {
  '@media': { '(max-width: 640px)': { whiteSpace: 'normal' } },
});
globalStyle('.identity-management__form-row', { '@media': { '(max-width: 640px)': { alignItems: 'stretch', flexDirection: 'column' } } });
globalStyle('.identity-management__form-row button', { '@media': { '(max-width: 640px)': { width: '100%' } } });
globalStyle('.identity-management__list-item', { '@media': { '(max-width: 640px)': { gridTemplateColumns: 'minmax(0, 1fr)' } } });
globalStyle('.identity-management__actions', { '@media': { '(max-width: 640px)': { gridColumn: '1' } } });
globalStyle('.identity-management__actions > button', { '@media': { '(max-width: 640px)': { flex: '1 1 auto' } } });
globalStyle('.identity-management__dialog', {
  '@media': { '(max-width: 640px)': { width: 'calc(100vw - 1rem)', maxWidth: 'calc(100vw - 1rem)', maxHeight: '92dvh', padding: '1rem' } },
});
globalStyle('.identity-management__dialog-header', { '@media': { '(max-width: 640px)': { alignItems: 'flex-start' } } });
globalStyle(':root[data-zp-theme="dark"] .identity-management__danger,\n:root[data-zp-theme="dark"] .identity-management__error', {
  borderColor: '#b56e65',
  color: '#f4d4cf',
  background: '#382422',
});
globalStyle(':root[data-zp-theme="dark"] .identity-management__danger:hover:not(:disabled)', { background: '#4a2e2a' });
globalStyle(':root[data-zp-theme="paper"] .identity-management__danger,\n:root[data-zp-theme="paper"] .identity-management__error', {
  borderColor: '#9b554c',
  color: '#762720',
  background: '#f8efec',
});
