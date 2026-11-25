import type { CSSProperties } from '@vanilla-extract/css';
import { scopedGlobalStyle as globalStyle } from '../styles/scoped-global-style.css';

globalStyle('.proposal-review.native-changeset-review', {
  container: 'native-review / inline-size',
  minWidth: '0',
  margin: '0',
  padding: 'clamp(0.75rem, 2.2cqi, 1.4rem)',
  border: '0',
  borderRadius: '0',
  color: 'var(--ink)',
  background: 'transparent',
});
globalStyle('.native-review-masthead', {
  display: 'flex',
  alignItems: 'flex-end',
  justifyContent: 'space-between',
  gap: '1rem',
  padding: '0.25rem 0 1rem',
  borderBottom: '1px solid var(--line)',
});
globalStyle(
  '.native-review-row-meta,\n.native-review-detail-meta,\n.native-review-section-heading > span,\n.native-review-operation-number',
  { color: 'var(--muted)', fontSize: '0.72rem', fontWeight: '700', letterSpacing: '0.08em' },
);
globalStyle('.native-review-masthead h2', { margin: '0', color: 'var(--ink)', fontSize: '1.15rem', lineHeight: '1.35' });
globalStyle('.native-review-intro', {
  maxWidth: '42rem',
  margin: '0.35rem 0 0',
  color: 'var(--muted)',
  fontSize: '0.84rem',
  lineHeight: '1.55',
});
globalStyle('.native-review-toolbar', {
  display: 'flex',
  minWidth: '0',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: '0.6rem 1rem',
  padding: '0.7rem 0',
  borderBottom: '1px solid var(--line)',
  color: 'var(--muted)',
  fontSize: '0.82rem',
});
globalStyle('.native-review-toolbar > span:first-child', { flex: '1 1 auto', color: 'var(--accent-strong)', fontWeight: '650' });
globalStyle('.native-review-toolbar [role="status"]', { flex: '1 1 100%' });
globalStyle('.native-review-refresh', {
  minHeight: '2.5rem',
  padding: '0.35rem 0.7rem',
  borderColor: 'var(--line)',
  color: 'var(--ink)',
  background: 'var(--paper)',
  fontSize: '0.82rem',
});
globalStyle('.native-review-refresh:hover:not(:disabled)', {
  borderColor: 'var(--accent)',
  color: 'var(--accent-strong)',
  background: 'var(--surface-selected)',
});
globalStyle('.native-review-core-feed', {
  margin: '0.9rem 0',
  padding: '0.8rem',
  border: '1px solid var(--line)',
  borderRadius: '0.45rem',
  background: 'var(--paper-dark)',
});
globalStyle('.native-review-core-feed > p', { margin: '0.4rem 0 0.65rem', color: 'var(--muted)', fontSize: '0.8rem', lineHeight: '1.55' });
globalStyle('.native-review-core-feed > ul', { display: 'grid', gap: '0.55rem', margin: '0', padding: '0', listStyle: 'none' });
globalStyle('.native-review-core-feed .proposal-card', { margin: '0', padding: '0.7rem' });
globalStyle('.native-review-core-feed .native-review-detail-meta', { display: 'flex', justifyContent: 'space-between', gap: '0.6rem' });
globalStyle('.native-review-core-feed .native-review-detail-meta strong', {
  color: 'var(--ink)',
  fontSize: '0.84rem',
  letterSpacing: 'normal',
  overflowWrap: 'anywhere',
});
globalStyle('.native-review-core-feed article > p', { margin: '0.35rem 0', color: 'var(--muted)', fontSize: '0.77rem', lineHeight: '1.5' });
globalStyle('.native-review-core-feed pre', {
  maxWidth: '100%',
  maxHeight: '18rem',
  overflow: 'auto',
  overflowWrap: 'anywhere',
  whiteSpace: 'pre-wrap',
  color: 'var(--ink)',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '0.72rem',
});
globalStyle('.native-review-message,\n.native-review-unknown', {
  padding: '0.75rem 0.9rem',
  border: '1px solid var(--error-border)',
  borderRadius: '0.4rem',
  color: 'var(--error-text)',
  background: 'var(--error-bg)',
  lineHeight: '1.55',
});
globalStyle('.native-review-empty', {
  display: 'grid',
  minHeight: '12rem',
  alignContent: 'center',
  justifyItems: 'center',
  padding: '1.5rem',
  borderBottom: '1px solid var(--line)',
  textAlign: 'center',
});
globalStyle('.native-review-empty > span', { color: 'var(--accent)', fontFamily: 'Georgia, serif', fontSize: '2rem' });
globalStyle('.native-review-empty h3', { margin: '0.35rem 0', fontSize: '1.08rem' });
globalStyle('.native-review-empty p', { maxWidth: '26rem', margin: '0', color: 'var(--muted)', fontSize: '0.9rem', lineHeight: '1.55' });
globalStyle('.native-review-layout', { display: 'grid', gap: '1rem', minWidth: '0', paddingTop: '0.85rem' });
globalStyle('.native-review-queue,\n.native-review-detail', { minWidth: '0' });
globalStyle('.native-review-queue-heading,\n.native-review-section-heading', {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: '0.75rem',
  marginBottom: '0.55rem',
});
globalStyle('.native-review-queue-heading h3', { margin: '0', fontSize: '0.95rem' });
globalStyle('.native-review-queue-heading > span', { color: 'var(--muted)', fontSize: '0.78rem', fontVariantNumeric: 'tabular-nums' });
globalStyle('.native-changeset-list', { display: 'grid', gap: '0.45rem', margin: '0', padding: '0', listStyle: 'none' });
globalStyle('.native-changeset-list li', { minWidth: '0' });
globalStyle('.native-changeset-select', {
  position: 'relative',
  display: 'grid',
  width: '100%',
  minHeight: '0',
  gap: '0.35rem',
  padding: '0.75rem 0.8rem',
  border: '1px solid var(--line)',
  borderRadius: '0.35rem',
  color: 'var(--ink)',
  background: 'var(--paper)',
  textAlign: 'left',
});
globalStyle('.native-changeset-select:hover:not(:disabled)', {
  borderColor: 'var(--surface-selected-border)',
  background: 'var(--surface-selected)',
});
globalStyle('.native-changeset-select[aria-pressed="true"]', {
  borderColor: 'var(--surface-selected-border)',
  background: 'var(--surface-selected)',
});
globalStyle('.native-review-row-meta,\n.native-review-detail-meta', {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  justifyContent: 'space-between',
  gap: '0.5rem',
});
globalStyle('.native-review-row-meta > span:first-child,\n.native-review-detail-meta > span:last-child', { fontSize: '0.66rem' });
globalStyle('.native-review-state', {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.35rem',
  color: 'var(--muted)',
  fontSize: '0.76rem',
  fontWeight: '700',
  letterSpacing: '0',
});
globalStyle('.native-review-state::before', {
  width: '0.45rem',
  height: '0.45rem',
  flex: '0 0 auto',
  borderRadius: '50%',
  background: 'currentColor',
  content: '""',
});
globalStyle('.native-review-state.is-proposed', { color: 'var(--accent-strong)' });
globalStyle('.native-review-state.is-approved', { color: 'var(--focus-ring)' });
globalStyle('.native-review-state.is-applied', { color: 'var(--success)' });
globalStyle('.native-review-state.is-rejected', { color: 'var(--muted)' });
globalStyle('.native-changeset-select > strong', { fontSize: '0.92rem', lineHeight: '1.35' });
globalStyle('.native-review-row-target', { overflowWrap: 'anywhere', color: 'var(--ink)', fontSize: '0.82rem', lineHeight: '1.4' });
globalStyle('.native-changeset-select small', { color: 'var(--muted)', fontSize: '0.74rem', lineHeight: '1.4' });
globalStyle('.native-review-id-token', {
  position: 'absolute',
  width: '1px',
  height: '1px',
  overflow: 'hidden',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
});
globalStyle('.native-changeset-card', {
  minWidth: '0',
  margin: '0',
  padding: '0',
  border: '1px solid var(--line)',
  borderRadius: '0.4rem',
  color: 'var(--ink)',
  background: 'var(--paper)',
});
globalStyle('.native-review-detail-header', {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: '0.8rem',
  padding: '1rem',
  borderBottom: '1px solid var(--line)',
});
globalStyle('.native-review-detail-meta', { justifyContent: 'flex-start', marginBottom: '0.5rem' });
globalStyle('.native-review-detail-header h3', { margin: '0', fontSize: 'clamp(1.05rem, 2.2cqi, 1.35rem)', lineHeight: '1.35' });
globalStyle('.native-review-target', {
  margin: '0.3rem 0 0',
  overflowWrap: 'anywhere',
  color: 'var(--accent-strong)',
  fontSize: '0.94rem',
  fontWeight: '650',
  lineHeight: '1.45',
});
globalStyle('.native-review-created', { display: 'grid', flex: '0 0 auto', gap: '0.18rem', color: 'var(--muted)', textAlign: 'right' });
globalStyle('.native-review-created > span', { fontSize: '0.7rem' });
globalStyle('.native-review-created time', { fontSize: '0.8rem', fontVariantNumeric: 'tabular-nums' });
globalStyle('.native-review-facts', {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: '0',
  borderBottom: '1px solid var(--line)',
  background: 'var(--paper-dark)',
});
globalStyle('.native-review-facts p', { display: 'grid', minWidth: '0', gap: '0.2rem', margin: '0', padding: '0.65rem 0.75rem' });
globalStyle('.native-review-facts p + p', { borderLeft: '1px solid var(--line)' });
globalStyle('.native-review-facts span', { color: 'var(--muted)', fontSize: '0.71rem' });
globalStyle('.native-review-facts strong', { overflowWrap: 'anywhere', fontSize: '0.82rem', fontWeight: '650', lineHeight: '1.4' });
globalStyle('.native-review-changes', { padding: '0 1rem' });
globalStyle('.native-review-section-heading', { margin: '0', padding: '0.9rem 0 0.55rem' });
globalStyle('.native-review-section-heading h4', { margin: '0', fontSize: '0.92rem' });
globalStyle('.native-review-section-heading > span', { fontSize: '0.64rem' });
globalStyle('.native-review-operation', {
  margin: '0',
  padding: '0.85rem 0',
  border: '0',
  borderTop: '1px solid var(--line)',
  borderRadius: '0',
  background: 'transparent',
});
globalStyle('.native-review-operation-heading', { display: 'flex', alignItems: 'flex-start', gap: '0.65rem' });
globalStyle('.native-review-operation-number', {
  flex: '0 0 auto',
  paddingTop: '0.2rem',
  color: 'var(--accent-strong)',
  fontVariantNumeric: 'tabular-nums',
});
globalStyle('.native-review-operation-heading h5', { margin: '0', fontSize: '0.94rem' });
globalStyle('.native-review-operation-heading p', {
  margin: '0.18rem 0 0',
  overflowWrap: 'anywhere',
  color: 'var(--muted)',
  fontSize: '0.82rem',
  lineHeight: '1.45',
});
globalStyle('.native-review-diff-overview', {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 0.9fr) auto minmax(0, 1.1fr)',
  alignItems: 'start',
  gap: '0.6rem',
  marginTop: '0.75rem',
});
globalStyle('.native-review-diff-overview > div', {
  minWidth: '0',
  padding: '0.65rem',
  border: '1px solid var(--line)',
  borderRadius: '0.3rem',
});
globalStyle('.native-review-diff-overview .native-review-before', { background: 'var(--surface-subtle)' });
globalStyle('.native-review-diff-overview .native-review-after', {
  borderColor: 'var(--surface-selected-border)',
  background: 'var(--surface-selected)',
});
globalStyle('.native-review-diff-overview > div > span', { color: 'var(--muted)', fontSize: '0.71rem', fontWeight: '700' });
globalStyle('.native-review-diff-overview > div > p', {
  margin: '0.35rem 0 0',
  overflowWrap: 'anywhere',
  color: 'var(--ink)',
  fontSize: '0.82rem',
  lineHeight: '1.5',
});
globalStyle('.native-review-diff-arrow', { paddingTop: '1.1rem', color: 'var(--accent)' });
globalStyle('.native-review-fields', { display: 'grid', gap: '0.38rem', margin: '0.35rem 0 0' });
globalStyle('.native-review-fields > div', {
  display: 'grid',
  gridTemplateColumns: 'minmax(4.7rem, 0.42fr) minmax(0, 1fr)',
  gap: '0.45rem',
});
globalStyle('.native-review-fields dt', { color: 'var(--muted)', fontSize: '0.75rem' });
globalStyle('.native-review-fields dd', { minWidth: '0', margin: '0', overflowWrap: 'anywhere', fontSize: '0.81rem', lineHeight: '1.45' });
globalStyle(
  '.native-review-fields pre,\n.native-review-operation pre,\n.native-review-technical pre,\n.native-review-receipt pre,\n.native-review-body-copy pre',
  {
    maxWidth: '100%',
    maxHeight: '22rem',
    margin: '0.3rem 0 0',
    overflow: 'auto',
    overflowWrap: 'anywhere',
    whiteSpace: 'pre-wrap',
    color: 'var(--ink)',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '0.74rem',
    lineHeight: '1.5',
  },
);
globalStyle('.native-review-fields pre', {
  padding: '0.4rem 0.5rem',
  border: '1px solid var(--line)',
  borderRadius: '0.25rem',
  background: 'var(--paper)',
});
globalStyle('.native-changeset-review pre[tabindex="0"]:focus-visible', { outline: '3px solid var(--focus-ring)', outlineOffset: '2px' });
globalStyle('.native-review-body-copy,\n.native-review-operation-payload,\n.native-review-technical,\n.native-review-merge details', {
  marginTop: '0.65rem',
  borderTop: '1px solid var(--line)',
  color: 'var(--muted)',
});
globalStyle(
  '.native-review-body-copy summary,\n.native-review-operation-payload summary,\n.native-review-technical > summary,\n.native-review-merge summary',
  { minHeight: '2.5rem', padding: '0.65rem 0', color: 'var(--accent-strong)', cursor: 'pointer', fontSize: '0.82rem', fontWeight: '650' },
);
globalStyle('.native-review-pending', { color: 'var(--muted)', fontSize: '0.82rem', lineHeight: '1.5' });
globalStyle('.native-review-diff-list', { display: 'grid', gap: '0.55rem', marginTop: '0.7rem' });
globalStyle('.native-review-diff-row', { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '0.55rem' });
globalStyle('.native-review-diff-row > div,\n.native-review-revision-bodies details', {
  minWidth: '0',
  padding: '0.55rem',
  border: '1px solid var(--line)',
  borderRadius: '0.3rem',
  background: 'var(--paper)',
});
globalStyle('.native-review-diff-row h5', { margin: '0', color: 'var(--muted)', fontSize: '0.72rem' });
globalStyle('.native-review-diff-row pre', { maxHeight: '12rem' });
globalStyle('.native-review-revision-bodies', { marginTop: '0.65rem' });
globalStyle('.native-review-revision-bodies summary', {
  minHeight: '2.35rem',
  color: 'var(--accent-strong)',
  cursor: 'pointer',
  fontSize: '0.8rem',
});
globalStyle('.native-review-merge', {
  marginTop: '0.7rem',
  padding: '0.7rem',
  border: '1px solid var(--line)',
  borderRadius: '0.3rem',
  background: 'var(--paper-dark)',
});
globalStyle('.native-review-merge p', { margin: '0.25rem 0', overflowWrap: 'anywhere', fontSize: '0.8rem', lineHeight: '1.5' });
globalStyle('.native-review-merge [role="alert"]', { color: 'var(--error-text)' });
globalStyle('.native-review-evidence', { marginTop: '0.65rem' });
globalStyle('.native-review-evidence > button,\n.native-review-quote > button', {
  minHeight: '2.5rem',
  padding: '0.35rem 0.7rem',
  fontSize: '0.82rem',
});
globalStyle('.native-review-quote', {
  marginTop: '0.5rem',
  padding: '0.7rem',
  border: '1px solid var(--success)',
  borderRadius: '0.3rem',
  background: 'var(--paper-dark)',
});
globalStyle('.native-review-quote q', { lineHeight: '1.6' });
globalStyle('.native-review-quote p', { color: 'var(--muted)', fontSize: '0.78rem', overflowWrap: 'anywhere' });
globalStyle('.native-review-operation-payload', { marginTop: '0.55rem' });
globalStyle('.native-review-technical', { margin: '0 1rem' });
globalStyle('.native-review-technical-grid', { display: 'grid', gap: '0.7rem', paddingBottom: '0.8rem' });
globalStyle('.native-review-technical-grid section', { minWidth: '0' });
globalStyle('.native-review-technical-grid h4', { margin: '0.45rem 0', color: 'var(--ink)', fontSize: '0.82rem' });
globalStyle('.native-review-receipt', {
  margin: '0.85rem 1rem',
  padding: '0.75rem',
  border: '1px solid var(--success)',
  borderRadius: '0.35rem',
});
globalStyle('.native-review-receipt p', { margin: '0', color: 'var(--success)', fontSize: '0.82rem', lineHeight: '1.5' });
globalStyle('.native-review-actions', {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '0.55rem',
  margin: '0.8rem 1rem 1rem',
  paddingTop: '0.75rem',
  borderTop: '1px solid var(--line)',
});
globalStyle('.native-review-actions p', { flex: '1 1 100%', margin: '0', color: 'var(--muted)', fontSize: '0.82rem', lineHeight: '1.5' });
globalStyle('.native-review-actions button', { minHeight: '2.75rem' });
globalStyle('.native-review-actions .quiet-button', {
  borderColor: 'var(--error-border)',
  color: 'var(--error-text)',
  background: 'transparent',
});
globalStyle('.native-review-actions .quiet-button:hover:not(:disabled)', { background: 'var(--error-bg)' });
globalStyle('.native-review-detail > .native-review-pending,\n.native-review-detail > .native-review-unknown', {
  margin: '0',
  padding: '1rem',
});
globalStyle('.native-review-layout', {
  '@container': {
    'native-review (min-width: 52rem)': { gridTemplateColumns: 'minmax(14rem, 0.36fr) minmax(0, 1fr)', alignItems: 'start' },
  },
});
globalStyle('.native-review-queue', {
  '@container': { 'native-review (min-width: 52rem)': { position: 'sticky', top: '0', maxHeight: '78cqh', overflow: 'auto' } },
});
globalStyle('.native-review-technical-grid', {
  '@container': { 'native-review (min-width: 52rem)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' } },
});
globalStyle('.native-review-facts', { '@container': { 'native-review (max-width: 35rem)': { gridTemplateColumns: '1fr' } } });
globalStyle('.native-review-facts p + p', {
  '@container': { 'native-review (max-width: 35rem)': { borderTop: '1px solid var(--line)', borderLeft: '0' } },
});
globalStyle('.native-review-diff-overview', {
  '@container': { 'native-review (max-width: 35rem)': { gridTemplateColumns: 'minmax(0, 1fr)' } },
});
globalStyle('.native-review-diff-arrow', { '@container': { 'native-review (max-width: 35rem)': { display: 'none' } } });
globalStyle('.native-review-diff-row', { '@container': { 'native-review (max-width: 35rem)': { gridTemplateColumns: 'minmax(0, 1fr)' } } });
globalStyle('.native-review-created', { '@container': { 'native-review (max-width: 35rem)': { maxWidth: '8rem' } } });
globalStyle('.native-changeset-review *,\n  .native-changeset-review *::before,\n  .native-changeset-review *::after', {
  '@media': {
    '(prefers-reduced-motion: reduce)': {
      scrollBehavior: 'auto !important' as unknown as CSSProperties['scrollBehavior'],
      transitionDuration: '0.01ms !important',
      animationDuration: '0.01ms !important',
    },
  },
});
