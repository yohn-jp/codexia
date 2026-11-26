import type { CSSProperties } from '@vanilla-extract/css';
import { scopedGlobalStyle as globalStyle } from '../styles/scoped-global-style.css';

globalStyle('.st-desktop-shell .st-desktop-chrome', { borderBottomColor: 'var(--line)', boxShadow: '0 1px 0 rgb(0 0 0 / 2%)' });
globalStyle('.st-desktop-shell .topbar', {
  position: 'static',
  minHeight: '4.5rem',
  gap: '1rem',
  padding: '0.75rem clamp(1rem, 2.3vw, 2rem)',
  background: 'var(--paper)',
});
globalStyle('.st-desktop-shell .brand', {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.7rem',
  marginRight: 'auto',
  color: 'var(--ink)',
  fontFamily: 'Georgia, "Times New Roman", serif',
  fontSize: '1.4rem',
  fontWeight: '650',
  letterSpacing: '-0.055em',
});
globalStyle('.st-desktop-shell .brand::before', {
  display: 'grid',
  width: '2.25rem',
  height: '2.25rem',
  flex: '0 0 auto',
  placeItems: 'center',
  borderRadius: '0.45rem',
  color: 'var(--button-foreground)',
  background: 'var(--accent-strong)',
  fontFamily: 'Georgia, "Times New Roman", serif',
  fontSize: '1.35rem',
  fontWeight: '400',
  content: '"S"',
});
globalStyle('.st-desktop-shell .topbar > .quiet-button', {
  minHeight: '2.35rem',
  borderColor: 'var(--input-border)',
  borderRadius: '0.5rem',
  fontSize: '0.8rem',
});
globalStyle('.st-desktop-shell .st-desktop-controls', {
  minHeight: '2.5rem',
  padding: '0.25rem clamp(1rem, 2.3vw, 2rem)',
  borderTop: '1px solid var(--line)',
  background: 'var(--surface-subtle)',
});
globalStyle('.st-desktop-shell .st-desktop-workbench-label', {
  color: 'var(--muted)',
  fontSize: '0.7rem',
  fontWeight: '700',
  letterSpacing: '0.14em',
});
globalStyle('.st-desktop-shell .st-desktop-workbench-label::before', {
  display: 'inline-block',
  width: '1.1rem',
  height: '1px',
  marginRight: '0.6rem',
  background: 'var(--accent)',
  verticalAlign: 'middle',
  content: '""',
});
globalStyle('.st-desktop-shell .st-desktop-switch', {
  minHeight: '1.95rem',
  borderColor: 'var(--input-border)',
  borderRadius: '0.35rem',
  background: 'transparent',
  fontSize: '0.75rem',
});
globalStyle('.st-desktop-shell .application-status', { display: 'grid', gap: '0.3rem', minWidth: '0' });
globalStyle('.st-desktop-shell .topbar-status', { fontSize: '0.8rem', whiteSpace: 'normal', overflowWrap: 'anywhere' });
globalStyle('.st-desktop-shell .st-desktop-workbench', { background: 'var(--st-canvas)' });
globalStyle('.st-desktop-shell .st-desktop-navigation', {
  color: 'var(--st-rail-ink)',
  background: 'var(--st-rail)',
  vars: {
    '--ink': 'var(--st-rail-ink)',
    '--muted': 'var(--st-rail-muted)',
    '--line': 'var(--st-rail-edge)',
    '--paper': 'var(--st-rail)',
    '--sidebar-bg': 'var(--st-rail)',
    '--toolbar-bg': 'var(--st-rail)',
    '--surface-selected': 'var(--st-rail-selected)',
  },
});
globalStyle('.st-desktop-shell .st-desktop-panel-tabs', {
  gap: '0.3rem',
  padding: '0.75rem 0.8rem 0',
  borderBottom: '1px solid var(--st-rail-edge)',
  background: 'var(--st-rail)',
});
globalStyle('.st-desktop-shell .st-desktop-panel-tab', {
  minHeight: '2.75rem',
  padding: '0.45rem 0.7rem 0.7rem',
  borderColor: 'transparent',
  borderBottom: '2px solid transparent',
  color: 'var(--st-rail-muted)',
  background: 'transparent',
  fontSize: '0.79rem',
  letterSpacing: '0.025em',
});
globalStyle('.st-desktop-shell .st-desktop-panel-tab:hover', { color: 'var(--st-rail-ink)', background: 'var(--surface-hover)' });
globalStyle('.st-desktop-shell .st-desktop-panel-tab[data-state="active"]', {
  borderBottomColor: 'var(--surface-selected-border)',
  color: 'var(--st-rail-ink)',
  background: 'transparent',
});
globalStyle('.st-desktop-shell .st-desktop-slot', { padding: '1.25rem 1rem 2.25rem' });
globalStyle('.st-desktop-shell .st-desktop-library-slot,\n.st-desktop-shell .st-desktop-tools-slot', { background: 'var(--st-rail)' });
globalStyle('.st-desktop-shell .sidebar', { padding: '0', border: '0', background: 'transparent' });
globalStyle('.st-desktop-shell .sidebar h2,\n.st-desktop-shell .tree-volume h3,\n.st-desktop-shell .shared-tools h2', {
  color: 'var(--st-rail-ink)',
  fontSize: '0.83rem',
  fontWeight: '700',
  letterSpacing: '0.04em',
});
globalStyle(
  '.st-desktop-shell .project-form,\n.st-desktop-shell .project-list-section,\n.st-desktop-shell .project-management,\n.st-desktop-shell .continue-panel',
  { padding: '0.9rem 0 1.3rem', borderBottom: '1px solid var(--st-rail-edge)' },
);
globalStyle('.st-desktop-shell .project-form', { paddingTop: '0' });
globalStyle('.st-desktop-shell .project-form label', { color: 'var(--st-rail-muted)' });
globalStyle('.st-desktop-shell .project-form input', { borderRadius: '0.5rem' });
globalStyle('.st-desktop-shell .st-desktop-navigation .danger-button', { color: '#fffefa' });
globalStyle('.st-desktop-shell .project-button,\n.st-desktop-shell .scene-button', {
  minHeight: '2.75rem',
  padding: '0.65rem 0.8rem',
  borderLeft: '2px solid transparent',
  borderRadius: '0.45rem',
  color: 'var(--st-rail-ink)',
  fontWeight: '500',
});
globalStyle('.st-desktop-shell :is(.project-button, .scene-button)[aria-current="true"]', {
  borderColor: 'var(--accent-strong)',
  color: 'var(--st-rail-ink)',
  background: 'var(--st-rail-selected)',
  fontWeight: '700',
});
globalStyle('.st-desktop-shell .tree', { marginTop: '1rem', paddingTop: '0' });
globalStyle('.st-desktop-shell .tree-volume', { margin: '0.9rem 0', paddingLeft: '0.7rem', borderLeft: '1px solid var(--st-rail-edge)' });
globalStyle('.st-desktop-shell .tree summary', { color: 'var(--st-rail-ink)', fontSize: '0.84rem' });
globalStyle('.st-desktop-shell .scene-list', { paddingLeft: '0.2rem' });
globalStyle('.st-desktop-shell .continue-list li', { padding: '0.45rem 0' });
globalStyle('.st-desktop-shell .st-desktop-resize-handle', {
  width: '0.4rem',
  minWidth: '0.4rem',
  flexBasis: '0.4rem',
  background: 'var(--st-canvas)',
});
globalStyle('.st-desktop-shell .st-desktop-resize-line', { background: 'var(--st-folio-edge)' });
globalStyle('.st-desktop-shell .st-desktop-editor-slot', {
  padding: 'clamp(1.3rem, 2.5vw, 2.7rem) clamp(1.3rem, 3.5vw, 4rem) 4rem',
  background: 'var(--st-canvas)',
});
globalStyle('.st-desktop-shell .editor', { maxWidth: '92rem' });
globalStyle('.st-desktop-shell .editor-header', {
  alignItems: 'center',
  paddingBottom: '1.1rem',
  borderBottom: '1px solid var(--st-folio-edge)',
});
globalStyle('.st-desktop-shell .scene-heading .eyebrow', {
  marginBottom: '0.4rem',
  color: 'var(--muted)',
  fontSize: '0.74rem',
  lineHeight: '1.6',
});
globalStyle('.st-desktop-shell .editor-header h1', {
  fontFamily: 'var(--manuscript-serif)',
  fontSize: 'clamp(1.8rem, 2.9vw, 2.8rem)',
  fontWeight: '600',
  letterSpacing: '-0.035em',
  lineHeight: '1.35',
});
globalStyle('.st-desktop-shell .editor-actions', { flex: '0 0 auto' });
globalStyle('.st-desktop-shell .editor-actions button', {
  minHeight: '2.45rem',
  borderRadius: '0.5rem',
  fontSize: '0.8rem',
  fontWeight: '650',
});
globalStyle('.st-desktop-shell .editor-actions .quiet-button', {
  borderColor: 'var(--input-border)',
  color: 'var(--ink)',
  background: 'var(--paper)',
});
globalStyle('.st-desktop-shell .editor-actions .quiet-button:hover:not(:disabled)', {
  color: 'var(--accent-strong)',
  background: 'var(--surface-hover)',
});
globalStyle('.st-desktop-shell .durability-row', { gap: '0.45rem', marginTop: '0.7rem' });
globalStyle('.st-desktop-shell .durability-badge', {
  padding: '0.28rem 0.55rem',
  borderColor: 'transparent',
  color: 'var(--muted)',
  background: 'transparent',
  fontSize: '0.72rem',
  fontWeight: '550',
});
globalStyle('.st-desktop-shell .durability-badge.is-current', {
  borderColor: 'var(--badge-selected-border)',
  color: 'var(--accent-strong)',
  background: 'var(--badge-selected-bg)',
  fontWeight: '700',
});
globalStyle('.st-desktop-shell .durability-badge.is-current::before', {
  display: 'inline-block',
  width: '0.42rem',
  height: '0.42rem',
  marginRight: '0.42rem',
  borderRadius: '50%',
  background: 'currentColor',
  verticalAlign: '0.09em',
  content: '""',
});
globalStyle('.st-desktop-shell .durability-message', {
  margin: '0.85rem 0 1rem',
  color: 'var(--muted)',
  fontSize: '0.8rem',
  lineHeight: '1.65',
});
globalStyle('.st-desktop-shell .typography-toolbar', {
  gap: '0.4rem 0.65rem',
  marginBottom: '1.4rem',
  padding: '0.6rem 0.8rem',
  borderColor: 'var(--st-folio-edge)',
  borderRadius: '0.55rem',
  background: 'var(--surface-subtle)',
});
globalStyle('.st-desktop-shell .typography-toolbar button', {
  minHeight: '2.15rem',
  padding: '0.32rem 0.55rem',
  borderColor: 'var(--input-border)',
  background: 'transparent',
  fontSize: '0.75rem',
});
globalStyle('.st-desktop-shell .typography-toolbar .quiet-button:hover:not(:disabled)', {
  color: 'var(--ink)',
  background: 'var(--surface-hover)',
});
globalStyle('.st-desktop-shell .editor-columns', { gridTemplateColumns: 'minmax(0, 1.27fr) minmax(15.5rem, 0.73fr)', gap: '1rem' });
globalStyle('.st-desktop-shell .manuscript-column,\n.st-desktop-shell .preview-column', {
  padding: '1.1rem',
  border: '1px solid var(--st-folio-edge)',
  borderRadius: '0.5rem',
  background: 'var(--st-folio)',
  boxShadow: 'var(--st-folio-shadow)',
});
globalStyle('.st-desktop-shell .manuscript-column', { border: '0', background: 'transparent', boxShadow: 'none' });
globalStyle('.st-desktop-shell .manuscript-input:focus-within', { outline: '3px solid var(--focus-ring)', outlineOffset: '2px' });
globalStyle('.st-desktop-shell .manuscript-input:focus-within .cm-editor.cm-focused', { outline: 'none' });
globalStyle('.st-desktop-shell .manuscript-column > label,\n.st-desktop-shell .preview-column h2', {
  color: 'var(--muted)',
  fontSize: '0.74rem',
  fontWeight: '750',
  letterSpacing: '0.09em',
});
globalStyle('.st-desktop-shell .manuscript-input', { border: '0', borderRadius: '0', background: 'transparent' });
globalStyle('.st-desktop-shell .cm-content', { maxWidth: '46em', marginInline: 'auto', padding: '2.1rem clamp(1.15rem, 2vw, 2.5rem)' });
globalStyle('.st-desktop-shell .preview-column', { background: 'var(--surface-subtle)' });
globalStyle('.st-desktop-shell .manuscript-preview', { borderColor: 'transparent', background: 'transparent' });
globalStyle('.st-desktop-shell .editor-hint', { lineHeight: '1.7' });
globalStyle('.st-desktop-shell .reading-view', {
  borderColor: 'var(--st-folio-edge)',
  borderRadius: '0.4rem',
  background: 'var(--st-folio)',
  boxShadow: 'var(--st-folio-shadow)',
});
globalStyle('.st-desktop-shell .empty-state', {
  maxWidth: '37rem',
  margin: 'clamp(3rem, 13vh, 9rem) auto',
  padding: '2rem',
  textAlign: 'left',
});
globalStyle('.st-desktop-shell .empty-state h1', {
  margin: '0.5rem 0 1rem',
  fontFamily: 'var(--manuscript-serif)',
  fontSize: 'clamp(2.5rem, 5vw, 4rem)',
  fontWeight: '550',
});
globalStyle('.st-desktop-shell .editor-header', { '@media': { '(max-width: 1180px)': { alignItems: 'flex-start', flexWrap: 'wrap' } } });
globalStyle('.st-desktop-shell .editor-columns', { '@media': { '(max-width: 1180px)': { gridTemplateColumns: 'minmax(0, 1fr)' } } });
globalStyle('.st-desktop-shell .manuscript-input,\n  .st-desktop-shell .cm-scroller,\n  .st-desktop-shell .cm-content', {
  '@media': { '(max-width: 1180px)': { minHeight: '48vh' } },
});
globalStyle('.st-desktop-shell .topbar', { '@media': { '(max-width: 680px)': { gap: '0.5rem', minHeight: '3.8rem', padding: '0.5rem' } } });
globalStyle('.st-desktop-shell .brand', { '@media': { '(max-width: 680px)': { fontSize: '1.07rem' } } });
globalStyle('.st-desktop-shell .brand::before', {
  '@media': { '(max-width: 680px)': { width: '1.7rem', height: '1.7rem', fontSize: '1rem' } },
});
globalStyle('.st-desktop-shell .st-desktop-editor-slot', { '@media': { '(max-width: 680px)': { padding: '1rem 0.75rem 2rem' } } });
globalStyle('.st-desktop-shell .st-desktop-panel-tabs', { '@media': { '(max-width: 680px)': { paddingInline: '0.3rem' } } });
globalStyle('.st-desktop-shell .st-desktop-panel-tab', {
  '@media': { '(max-width: 680px)': { paddingInline: '0.35rem', fontSize: '0.71rem' } },
});
globalStyle('.st-desktop-shell .st-desktop-slot', { '@media': { '(max-width: 680px)': { padding: '0.65rem' } } });
globalStyle('.st-desktop-shell *', {
  '@media': { '(prefers-reduced-motion: reduce)': { scrollBehavior: 'auto !important' as unknown as CSSProperties['scrollBehavior'] } },
});
globalStyle(
  '.st-desktop-shell,\n  .st-desktop-shell .st-desktop-workbench,\n  .st-desktop-shell .st-desktop-editor-panel,\n  .st-desktop-shell .st-desktop-editor-slot',
  { '@media': { print: { height: 'auto !important', overflow: 'visible !important', background: 'white !important' } } },
);
globalStyle(
  '.st-desktop-shell .st-desktop-chrome,\n  .st-desktop-shell .st-desktop-status,\n  .st-desktop-shell .st-desktop-navigation-panel,\n  .st-desktop-shell .st-desktop-resize-handle',
  { '@media': { print: { display: 'none !important' } } },
);
globalStyle('.st-desktop-shell .st-desktop-editor-slot', { '@media': { print: { padding: '0 !important' } } });
globalStyle('.st-desktop-shell .manuscript-column', {
  '@media': { print: { border: '0', boxShadow: 'none' } },
});
