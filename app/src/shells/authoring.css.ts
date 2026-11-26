import type { CSSProperties } from '@vanilla-extract/css';
import { scopedGlobalStyle as globalStyle } from '../styles/scoped-global-style.css';

globalStyle('.st-studio-shell', {
  vars: { '--authoring-control-height': '2.75rem', '--authoring-status-height': '2.25rem' },
});
globalStyle('.st-studio-shell .scene-heading', { minWidth: '0' });
globalStyle('.st-studio-shell .scene-heading :is(h1, .eyebrow)', { overflowWrap: 'anywhere' });
globalStyle('.st-studio-shell .editor-header', { gap: '0.75rem', flexWrap: 'wrap' });
globalStyle('.st-studio-shell .writing-toolbar', {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.35rem',
  marginBlock: '0.35rem',
});
globalStyle('.st-studio-shell .writing-toolbar button', {
  minHeight: 'var(--authoring-control-height)',
  padding: '0.35rem 0.65rem',
  borderColor: 'transparent',
  color: 'var(--ink)',
  background: 'transparent',
});
globalStyle('.st-studio-shell .writing-toolbar button[aria-pressed="true"]', {
  borderColor: 'var(--surface-selected-border)',
  background: 'var(--surface-selected)',
});
globalStyle('.st-studio-shell :is(.typography-settings, .editor-protection) > summary', {
  display: 'flex',
  alignItems: 'center',
  minHeight: 'var(--authoring-control-height)',
  padding: '0.3rem 0.4rem',
  color: 'var(--muted)',
  cursor: 'pointer',
  fontSize: '0.8rem',
});
globalStyle('.st-studio-shell :is(.typography-settings, .editor-protection) > summary::before', {
  content: '"+"',
  marginRight: '0.5rem',
});
globalStyle('.st-studio-shell :is(.typography-settings, .editor-protection)[open] > summary::before', {
  content: '"−"',
});
globalStyle('.st-studio-shell .editor-protection', { position: 'relative', zIndex: '3' });
globalStyle('.st-studio-shell .editor-protection-detail', {
  position: 'absolute',
  insetInline: '0',
  top: '100%',
  maxHeight: '16rem',
  overflow: 'auto',
  padding: '0.75rem 1rem',
  border: '1px solid var(--line)',
  borderRadius: '0.4rem',
  color: 'var(--ink)',
  background: 'var(--paper)',
  boxShadow: '0 0.5rem 1.5rem rgb(0 0 0 / 12%)',
  fontSize: '0.85rem',
  overflowWrap: 'anywhere',
});
globalStyle('.st-studio-shell .durability-row', { margin: '0', minHeight: '1.5rem' });
globalStyle('.st-studio-shell .durability-badge.is-current', {
  margin: '0',
  padding: '0',
  border: '0',
  borderRadius: '0',
  color: 'var(--accent-strong)',
  background: 'transparent',
  fontSize: '0.8rem',
});
globalStyle('.st-studio-shell .st-workspace .editor-columns:not(.has-preview)', { gridTemplateColumns: 'minmax(0, 1fr)' });
globalStyle('.st-studio-shell .preview-column[hidden]', { display: 'none' });
globalStyle('.st-studio-shell .st-workspace .manuscript-column', {
  border: '0',
  boxShadow: 'none',
  padding: '1rem clamp(0.75rem, 2vw, 2rem)',
});
globalStyle('.st-studio-shell .st-workspace .cm-content', {
  fontFamily: 'var(--editor-font-family)',
  lineHeight: 'var(--editor-line-height)',
  letterSpacing: 'var(--editor-letter-spacing)',
  padding: '1rem 0.5rem',
});
globalStyle('.st-studio-shell .st-workspace .editor-header', { padding: '0.5rem 0.25rem', margin: '0' });
globalStyle('.st-studio-shell .st-workspace .editor-header h1', { fontSize: 'clamp(1.4rem, 2vw, 1.9rem)' });
globalStyle('.st-studio-shell .st-workspace .typography-toolbar', { margin: '0' });
globalStyle('.st-studio-shell .st-workspace-configuration > summary', { display: 'none' });
globalStyle('.st-workspace-configuration', { flex: '0 0 auto' });
globalStyle('.st-workspace-configuration > summary', {
  padding: '0.4rem 0.7rem',
  cursor: 'pointer',
  color: 'var(--muted)',
  fontSize: '0.8rem',
});
globalStyle('.st-studio-shell .st-desktop-status', {
  position: 'relative',
  inset: 'auto',
  zIndex: '30',
  flex: '0 0 var(--authoring-status-height)',
  width: '100%',
  height: 'var(--authoring-status-height)',
  maxHeight: 'none',
  overflow: 'visible',
  padding: '0',
  border: '0',
  borderTop: '1px solid var(--line)',
  borderRadius: '0',
  background: 'var(--paper)',
  color: 'var(--ink)',
  boxShadow: 'none',
});
globalStyle('.application-status > summary', {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.75rem',
  height: 'var(--authoring-status-height)',
  padding: '0 0.8rem',
  cursor: 'pointer',
  color: 'var(--muted)',
  fontSize: '0.78rem',
});
globalStyle('.application-status[data-attention] > summary', { color: 'var(--error-text)', background: 'var(--error-bg)' });
globalStyle('.st-desktop-status .application-status-content', {
  position: 'absolute',
  bottom: '100%',
  insetInline: '0.5rem',
  maxHeight: 'min(35dvh, 18rem)',
  overflow: 'auto',
  padding: '0.8rem 1rem',
  border: '1px solid var(--line)',
  borderRadius: '0.4rem',
  background: 'var(--paper)',
  color: 'var(--ink)',
  boxShadow: '0 -0.4rem 1.5rem rgb(0 0 0 / 12%)',
  overflowWrap: 'anywhere',
});
globalStyle('.application-status-content .topbar-status', { whiteSpace: 'normal', margin: '0', maxWidth: 'none' });
globalStyle('.application-status-content p', { margin: '0.35rem 0' });
globalStyle('.st-studio-shell .st-desktop-switch-error', { position: 'absolute', bottom: '100%', insetInline: '0' });
globalStyle('.st-studio-shell :is(button, summary, select, a):focus-visible', {
  outline: '3px solid var(--focus-ring)',
  outlineOffset: '2px',
});
globalStyle('.st-studio-topbar', {
  '@media': { '(max-width: 850px)': { flex: '0 0 auto', height: 'auto', minHeight: '4.5rem', flexWrap: 'wrap', paddingBlock: '0.5rem' } },
});
globalStyle('.st-studio-wordmark', { '@media': { '(max-width: 850px)': { fontSize: '1.1rem' } } });
globalStyle('.st-studio-masthead-actions', { '@media': { '(max-width: 850px)': { flexWrap: 'wrap', gap: '0.35rem' } } });
globalStyle('.st-studio-shell .st-workspace-toolbar', { '@media': { '(max-width: 850px)': { flexWrap: 'wrap' } } });
globalStyle('.st-studio-shell .st-workspace .editor-header', { '@media': { '(max-width: 850px)': { alignItems: 'flex-start' } } });
globalStyle('.st-studio-shell .st-workspace .editor-actions', { '@media': { '(max-width: 850px)': { flexWrap: 'wrap' } } });
globalStyle('.st-studio-shell *', {
  '@media': { '(prefers-reduced-motion: reduce)': { scrollBehavior: 'auto !important' as unknown as CSSProperties['scrollBehavior'] } },
});
globalStyle(
  '.st-studio-shell .st-workspace :is(.project-button, .scene-button),\n.st-studio-shell .st-workspace :is(.project-button, .scene-button)[aria-current="true"]',
  { color: 'var(--ink)' },
);
globalStyle('.st-studio-shell .st-workspace :is(.project-button, .scene-button)[aria-current="true"]', {
  background: 'var(--surface-selected)',
});
globalStyle('.st-studio-shell .st-workspace .tree details > summary', { color: 'var(--ink)' });
globalStyle('.st-studio-shell .scene-button', { whiteSpace: 'normal', overflowWrap: 'anywhere' });
globalStyle(
  '.writing-toolbar, .typography-settings, .editor-protection,\n  .st-studio-rail, .st-studio-topbar, .st-workspace-configuration',
  { '@media': { print: { display: 'none !important' } } },
);
globalStyle('.st-studio-shell .st-workspace .manuscript-input', {
  width: '100%',
  maxWidth: 'min(100%, var(--reader-max-width, 960px))',
  alignSelf: 'center',
});
globalStyle('.st-studio-shell', {
  gridTemplateColumns: 'minmax(0, 1fr)',
  minBlockSize: '100dvh',
  background: 'var(--st-canvas)',
  vars: { '--authoring-status-height': '30px' },
});
globalStyle('.st-studio-rail,\n.st-studio-footer', { display: 'none !important' });
globalStyle('.st-studio-main', {
  container: 'st-main / inline-size',
  position: 'relative',
  display: 'grid',
  gridTemplateRows: 'minmax(54px, auto) minmax(0, 1fr)',
  blockSize: '100dvh',
  minBlockSize: '0',
  overflow: 'clip',
});
globalStyle('.st-studio-topbar', {
  minBlockSize: '54px',
  blockSize: 'auto',
  flex: '0 0 auto',
  gap: 'clamp(12px, 2vw, 28px)',
  paddingInline: 'clamp(18px, 3vw, 44px)',
  borderColor: 'var(--st-folio-edge)',
  background: 'var(--st-canvas)',
});
globalStyle('.st-studio-identity', { gap: 'clamp(14px, 2vw, 30px)' });
globalStyle('.st-studio-wordmark', { color: 'var(--ink)', fontSize: '19px', letterSpacing: '-0.045em' });
globalStyle('.st-studio-wordmark span', { color: 'var(--accent-strong)' });
globalStyle('.st-studio-breadcrumb', { maxInlineSize: 'min(52vw, 46rem)', fontSize: '12px' });
globalStyle('.st-studio-breadcrumb strong', { fontWeight: '600' });
globalStyle('.st-studio-masthead-actions', { flex: '0 0 auto', gap: '10px' });
globalStyle('.st-studio-header-slot button:last-child', {
  minBlockSize: '34px',
  paddingInline: '8px',
  borderColor: 'transparent',
  color: 'var(--muted)',
  background: 'transparent',
  fontSize: '11px',
});
globalStyle('.st-studio-header-slot button:last-child:hover', { color: 'var(--ink)', background: 'var(--surface-hover)' });
globalStyle('.st-studio-real-actions button', { minBlockSize: '34px' });
globalStyle('.st-studio-header-slot .theme-control', { fontSize: '0' });
globalStyle('.st-studio-header-slot .theme-control select', {
  minBlockSize: 'var(--authoring-control-height)',
  paddingInline: '8px',
  fontSize: '12px',
});
globalStyle('.st-studio-console-link', {
  minBlockSize: '34px',
  paddingInline: '8px',
  border: '0',
  color: 'var(--muted)',
  background: 'transparent',
  font: 'inherit',
  fontSize: '11px',
  cursor: 'pointer',
});
globalStyle('.st-studio-console-link:hover', { color: 'var(--ink)' });
globalStyle('.st-studio-shell .st-workspace', {
  minBlockSize: '0',
  border: '0',
  background: 'var(--st-canvas)',
  vars: { '--paper': 'var(--st-canvas)', '--line': 'var(--st-folio-edge)', '--toolbar-bg': 'var(--st-canvas)' },
});
globalStyle('.st-studio-shell .st-workspace :is(button, select)', {
  minHeight: 'var(--authoring-control-height)',
  borderColor: 'var(--input-border)',
});
globalStyle('.st-studio-shell .st-workspace-desktop-controls', {
  minBlockSize: '48px',
  border: '0',
  borderBlockEnd: '1px solid var(--st-folio-edge)',
  background: 'var(--st-canvas)',
});
globalStyle('.st-studio-shell .st-workspace-toolbar', {
  minBlockSize: '48px',
  gap: 'clamp(10px, 1.6vw, 24px)',
  padding: '5px clamp(18px, 3vw, 44px)',
  background: 'var(--st-canvas)',
});
globalStyle('.st-studio-shell .st-workspace-presets', { gap: '8px' });
globalStyle('.st-studio-shell .st-workspace-preset-label', {
  marginInlineEnd: '4px',
  color: 'var(--muted)',
  fontSize: '10px',
  letterSpacing: '.04em',
});
globalStyle('.st-studio-shell .st-workspace-presets button', {
  minBlockSize: 'var(--authoring-control-height)',
  paddingInline: '12px',
  border: '1px solid transparent',
  borderRadius: '3px',
  color: 'var(--muted)',
  background: 'transparent',
  fontSize: '12px',
});
globalStyle('.st-studio-shell .st-workspace-presets button:hover:not(:disabled)', {
  background: 'color-mix(in srgb, var(--paper) 70%, transparent)',
});
globalStyle('.st-studio-shell .st-workspace-presets button[aria-pressed="true"]', {
  borderColor: 'transparent',
  borderBlockEnd: '2px solid var(--surface-selected-border)',
  borderRadius: '0',
  color: 'var(--ink)',
  fontWeight: '650',
});
globalStyle('.st-studio-shell .st-workspace-panel-menu summary,\n.st-studio-shell .st-workspace-move-menu > summary', {
  minBlockSize: '34px',
  padding: '6px 10px',
  borderColor: 'transparent',
  color: 'var(--muted)',
  background: 'transparent',
  fontSize: '11px',
});
globalStyle('.st-studio-shell .st-workspace-save', {
  minBlockSize: '34px',
  borderColor: 'var(--st-folio-edge)',
  borderRadius: '3px',
  color: 'var(--muted)',
  background: 'transparent',
  fontSize: '11px',
});
globalStyle('.st-studio-shell .st-workspace-layout', { minBlockSize: '0', gap: '0', background: 'var(--st-canvas)' });
globalStyle('.st-studio-shell .st-workspace-resizable-panel,\n.st-studio-shell .st-workspace-split', {
  minInlineSize: '0',
  minBlockSize: '0',
});
globalStyle('.st-studio-shell .st-workspace-panel', { border: '0', background: 'transparent' });
globalStyle('.st-studio-shell .st-workspace-panel-heading', {
  minBlockSize: '38px',
  padding: '6px clamp(14px, 2vw, 26px)',
  border: '0',
  background: 'transparent',
});
globalStyle('.st-studio-shell .st-workspace-panel-heading h2', {
  color: 'var(--muted)',
  fontSize: '10px',
  fontWeight: '550',
  letterSpacing: '.06em',
});
globalStyle('.st-studio-shell .st-workspace-frame-actions', { display: 'none' });
globalStyle('.st-studio-shell .st-workspace[data-layout-editing="true"] .st-workspace-frame-actions', { display: 'flex' });
globalStyle('.st-studio-shell .st-workspace-panel-body', { minBlockSize: '0', border: '0', background: 'transparent' });
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="outline"] .st-workspace-panel-body', {
  paddingInline: 'clamp(14px, 1.8vw, 24px)',
  borderInlineEnd: '1px solid var(--st-folio-edge)',
  background: 'color-mix(in srgb, var(--st-canvas) 94%, var(--paper))',
});
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="editor"] .st-workspace-panel-heading', { display: 'none' });
globalStyle(
  '.st-studio-shell .st-workspace[data-layout-editing="true"] .st-workspace-panel[data-workspace-panel="editor"] .st-workspace-panel-heading',
  { display: 'flex' },
);
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="editor"] .st-workspace-panel-body', {
  background: 'var(--st-folio)',
});
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="editor"] .pg-editor-column', {
  minBlockSize: '100%',
  padding: 'clamp(4px, 0.4vw, 6px) clamp(24px, 5vw, 76px) 60px',
  background: 'var(--st-folio)',
});
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="editor"] .pg-editor', {
  container: 'manuscript / inline-size',
  width: 'min(100%, 68rem)',
  marginInline: 'auto',
  padding: '0',
  border: '0',
  background: 'transparent',
  boxShadow: 'none',
});
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="editor"] .pg-editor-heading', {
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '12px',
  marginBlockEnd: '6px',
  paddingBlockEnd: '7px',
  borderBlockEnd: '1px solid var(--st-folio-edge)',
});
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="editor"] .pg-editor-heading h2', {
  marginBlock: '0',
  font: '500 clamp(1.35rem, 2cqi, 1.65rem)/1.25 var(--manuscript-serif, serif)',
  letterSpacing: '.015em',
  textWrap: 'balance',
});
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="editor"] .pg-editor-heading .eyebrow', {
  margin: '0 0 2px',
  color: 'var(--muted)',
  fontSize: '10px',
});
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="editor"] .pg-save-state', {
  position: 'relative',
  flex: '0 0 auto',
  color: 'var(--muted)',
  fontSize: '11px',
});
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="editor"] .pg-save-state summary', {
  minBlockSize: '32px',
  display: 'flex',
  alignItems: 'center',
  paddingInline: '8px',
  border: '1px solid var(--st-folio-edge)',
  borderRadius: '4px',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
});
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="editor"] .pg-save-state[open]', {
  flex: '1 1 100%',
  order: '2',
  justifyItems: 'stretch',
  textAlign: 'start',
});
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="editor"] .pg-save-state[open] summary', { justifySelf: 'end' });
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="editor"] .pg-save-state[data-state="saved"] summary', {
  color: 'var(--success)',
});
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="editor"] .pg-save-state[data-state="uncertain"] summary', {
  color: 'var(--error-text)',
});
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="editor"] .pg-save-state-detail', {
  position: 'static',
  minInlineSize: '0',
  maxInlineSize: '100%',
  maxBlockSize: 'min(40dvh, 20rem)',
  overflow: 'auto',
  padding: '8px 12px',
  border: '1px solid var(--st-folio-edge)',
  borderRadius: '4px',
  background: 'var(--paper)',
  boxShadow: '0 4px 16px rgb(0 0 0 / 10%)',
});
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="editor"] .pg-save-state-detail p', {
  margin: '3px 0',
  fontSize: '11px',
  lineHeight: '1.4',
});
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="editor"] .pg-editor-actions', {
  gap: '4px',
  marginBlock: '0 2px',
  paddingBlock: '0',
});
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="editor"] .pg-editor-actions button', {
  minBlockSize: '32px',
  paddingInline: '9px',
  borderColor: 'transparent',
  borderRadius: '3px',
  color: 'var(--muted)',
  background: 'transparent',
  fontSize: '11px',
});
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="editor"] .pg-editor-actions button:hover:not(:disabled)', {
  color: 'var(--ink)',
  background: 'var(--surface-hover)',
});
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="editor"] .pg-editor-actions > details > summary', {
  minBlockSize: '32px',
  display: 'flex',
  alignItems: 'center',
  paddingInline: '8px',
  color: 'var(--muted)',
  fontSize: '11px',
  cursor: 'pointer',
});
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="editor"] .pg-editor-actions > details[open] > div', {
  position: 'absolute',
  zIndex: '8',
  top: '100%',
  insetInlineStart: '0',
  minInlineSize: '15rem',
  padding: '8px',
  border: '1px solid var(--st-folio-edge)',
  borderRadius: '4px',
  background: 'var(--paper)',
  boxShadow: '0 4px 16px rgb(0 0 0 / 10%)',
});
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="editor"] .pg-editor-actions > details', { position: 'relative' });
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="editor"] #pg-manuscript-label', {
  position: 'absolute',
  width: '1px',
  height: '1px',
  margin: '-1px',
  padding: '0',
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: '0',
});
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="editor"] .manuscript-column', {
  minBlockSize: 'min(64dvh, 52rem)',
  padding: '16px clamp(8px, 2vw, 25px)',
  border: '0',
  background: 'transparent',
});
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="editor"] .cm-editor', { background: 'transparent' });
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="editor"] .cm-content', {
  maxInlineSize: 'min(100%, var(--reader-max-width, 960px))',
  marginInline: 'auto',
  paddingBlock: '1rem 5rem',
  lineHeight: 'var(--editor-line-height, 1.85)',
  textWrap: 'pretty',
});
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="outline"] .pg-library', { padding: '0 0 28px' });
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="outline"] .pg-library > section', {
  padding: '14px 0 18px',
  border: '0',
  borderBlockEnd: '1px solid var(--st-folio-edge)',
  borderRadius: '0',
  background: 'transparent',
  boxShadow: 'none',
});
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="outline"] .pg-library h2', {
  marginBlock: '0 10px',
  font: '500 15px/1.5 var(--manuscript-serif, serif)',
});
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="outline"] .pg-document-list', {
  display: 'grid',
  gap: '3px',
  margin: '10px 0',
  padding: '0',
  listStyle: 'none',
});
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="outline"] .pg-document-list button', {
  minBlockSize: '40px',
  padding: '7px 9px',
  border: '0',
  borderInlineStart: '2px solid transparent',
  borderRadius: '0',
  color: 'var(--ink)',
  background: 'transparent',
  textAlign: 'start',
});
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="outline"] .pg-document-list button.is-selected', {
  borderInlineStartColor: 'var(--accent-strong)',
  background: 'var(--st-rail-selected)',
});
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="outline"] .pg-document-list button small', {
  display: 'block',
  marginBlockStart: '1px',
  color: 'var(--muted)',
  fontSize: '10px',
});
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="outline"] .pg-document-list', {
  display: 'grid',
  gap: '4px',
  marginBlock: '14px 22px',
});
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="outline"] .pg-outline-item', { minWidth: '0' });
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="outline"] .pg-outline-row', {
  display: 'grid',
  gridTemplateColumns: '24px minmax(0, 1fr) auto 28px',
  alignItems: 'stretch',
  gap: '3px',
});
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="outline"] .pg-outline-row.is-heading', {
  gridTemplateColumns: '24px minmax(0, 1fr)',
});
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="outline"] .pg-outline-zoom', {
  minHeight: '34px',
  padding: '4px 6px',
  color: 'var(--muted)',
  fontSize: '10px',
});
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="outline"] .pg-outline-search', {
  display: 'block',
  marginBlockStart: '10px',
  color: 'var(--muted)',
  fontSize: '11px',
});
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="outline"] #pg-outline-search', {
  width: '100%',
  minHeight: '34px',
  marginBlockStart: '4px',
});
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="outline"] .pg-outline-breadcrumb', {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '3px',
  marginBlock: '8px',
  color: 'var(--muted)',
  fontSize: '11px',
});
globalStyle(
  '.st-studio-shell .st-workspace-panel[data-workspace-panel="outline"] .pg-outline-row > .pg-outline-toggle,\n.st-studio-shell .st-workspace-panel[data-workspace-panel="outline"] .pg-outline-row > .pg-outline-spacer',
  {
    display: 'grid',
    width: '24px',
    minHeight: '34px',
    placeItems: 'center',
    padding: '0',
    border: '0',
    borderRadius: '0',
    color: 'var(--muted)',
    background: 'transparent',
    fontSize: '15px',
  },
);
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="outline"] .pg-outline-document', {
  minWidth: '0',
  minHeight: '34px',
  gap: '0',
  padding: '5px 8px',
  border: '0',
  borderInlineStart: '2px solid transparent',
  borderRadius: '0',
  color: 'var(--ink)',
  background: 'transparent',
  textAlign: 'start',
  fontSize: '12px',
  fontWeight: '500',
});
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="outline"] .pg-outline-document:hover:not(:disabled)', {
  background: 'var(--surface-hover)',
});
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="outline"] .pg-outline-document.is-selected', {
  borderInlineStartColor: 'var(--accent-strong)',
  color: 'var(--ink)',
  background: 'var(--st-rail-selected)',
  fontWeight: '650',
});
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="outline"] .pg-outline-document small', {
  margin: '1px 0 0',
  color: 'var(--muted)',
  fontSize: '9px',
  fontWeight: '400',
});
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="outline"] .pg-document-children', {
  display: 'grid',
  gap: '2px',
  margin: '2px 0 2px 11px',
  padding: '0 0 0 8px',
  borderInlineStart: '1px solid var(--st-folio-edge)',
  listStyle: 'none',
});
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="outline"] .pg-outline-drag', {
  minInlineSize: '28px',
  paddingInline: '2px',
  cursor: 'grab',
  color: 'var(--muted)',
  touchAction: 'none',
  userSelect: 'none',
});
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="outline"] .pg-outline-drag:active', { cursor: 'grabbing' });
globalStyle('.st-studio-shell .st-workspace-panel[data-workspace-panel="outline"] .pg-outline-rename', {
  width: '100%',
  minWidth: '0',
  minHeight: '34px',
  padding: '5px 8px',
  font: 'inherit',
});
globalStyle(
  '.st-studio-shell .st-workspace-panel[data-workspace-panel="outline"] .pg-outline-item[data-drop-target="true"] > .pg-outline-row',
  { outline: '2px solid var(--surface-selected-border)', outlineOffset: '1px', borderRadius: '3px' },
);
globalStyle('.st-studio-shell .st-desktop-status', {
  position: 'absolute',
  insetInline: 'clamp(12px, 2vw, 28px)',
  bottom: '12px',
  zIndex: '40',
  width: 'auto',
  height: 'auto',
  maxHeight: 'min(35dvh, 18rem)',
  padding: '0',
  border: '0',
  background: 'transparent',
});
globalStyle('.st-studio-shell .st-desktop-status:empty', { display: 'none' });
globalStyle('.st-studio-shell .application-status > summary', {
  justifyContent: 'flex-start',
  gap: '14px',
  paddingInline: 'clamp(18px, 3vw, 44px)',
  fontSize: '10px',
});
globalStyle('.st-studio-shell .st-workspace-storage-state,\n.st-studio-shell .st-workspace-message', {
  minBlockSize: '0',
  margin: '0',
  padding: '0',
});
globalStyle('.st-studio-shell .st-workspace-warning', { margin: '0' });
globalStyle('.st-studio-shell .st-workspace-resize-handle', { background: 'transparent' });
globalStyle('.st-studio-shell .st-workspace-resize-handle::after', {
  background: 'var(--st-folio-edge)',
  transition: 'background-color 140ms ease',
});
globalStyle('.st-studio-shell .st-workspace-resize-handle:hover::after', { background: 'var(--accent-strong)' });
globalStyle('.st-studio-shell .st-workspace-resize-handle:focus-visible', { outline: '3px solid var(--focus-ring)', outlineOffset: '2px' });
globalStyle('.st-studio-shell .st-workspace-resize-handle:focus-visible::after', { background: 'var(--focus-ring)' });
globalStyle('.st-studio-shell .st-workspace-split-horizontal', { gap: '0' });
globalStyle('.st-studio-shell :is(.pg-library, .pg-knowledge) form', { marginBlockStart: '12px' });
globalStyle('.st-studio-shell .pg-library details > summary,\n.st-studio-shell .pg-knowledge details > summary', {
  minBlockSize: '36px',
  color: 'var(--muted)',
  fontSize: '11px',
});
globalStyle('.st-studio-shell .pg-knowledge section', { borderRadius: '0', boxShadow: 'none' });
globalStyle('.st-studio-shell .pg-knowledge > section', {
  padding: '12px 14px 16px',
  border: '0',
  borderTop: '1px solid var(--st-folio-edge)',
  background: 'transparent',
});
globalStyle('.st-studio-shell .pg-knowledge > section:first-child', { borderTop: '0' });
globalStyle('.st-studio-shell .pg-knowledge > section > h2', { margin: '0 0 10px', font: '500 15px/1.5 var(--manuscript-serif, serif)' });
globalStyle('.st-studio-shell .native-changeset-select', {
  padding: '0.7rem 0.8rem',
  border: '0',
  borderBottom: '1px solid var(--st-folio-edge)',
  borderInlineStart: '2px solid transparent',
  borderRadius: '0',
  background: 'transparent',
});
globalStyle('.st-studio-shell .native-changeset-select[aria-pressed="true"]', {
  borderInlineStartColor: 'var(--surface-selected-border)',
  background: 'var(--st-rail-selected)',
});
globalStyle('.st-studio-shell .native-changeset-card', { border: '0', borderTop: '2px solid var(--accent-strong)', borderRadius: '0' });
globalStyle('.st-studio-shell .native-review-facts', { background: 'transparent' });
globalStyle('.st-studio-shell .native-review-diff-overview > div', {
  borderRadius: '0',
  borderInlineStart: '2px solid var(--st-folio-edge)',
  background: 'var(--st-rail-selected)',
});
globalStyle('.st-studio-shell .native-review-diff-overview > div:last-child', { borderInlineStartColor: 'var(--success)' });
globalStyle('.st-studio-shell .pg-revisions', { marginBlock: '24px', paddingBlock: '10px', borderTop: '1px solid var(--st-folio-edge)' });
globalStyle('.pg-workspace .pg-revision-difference', { marginBlock: '12px', borderBlock: '1px solid var(--st-folio-edge)' });
globalStyle('.pg-workspace .pg-revision-difference > summary', {
  minHeight: '40px',
  display: 'flex',
  alignItems: 'center',
  color: 'var(--accent-strong)',
  cursor: 'pointer',
});
globalStyle('.pg-workspace .pg-revision-diff-metadata,\n.pg-workspace .pg-revision-diff-hunk', {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: '12px',
  paddingBlock: '10px',
});
globalStyle('.pg-workspace .pg-revision-diff-metadata dd', { margin: '0', overflowWrap: 'anywhere' });
globalStyle('.pg-workspace .pg-revision-diff-hunk > div', { minWidth: '0', padding: '12px', background: 'var(--st-rail-selected)' });
globalStyle('.pg-workspace .pg-revision-diff-preview h4', {
  margin: '0 0 8px',
  color: 'var(--muted)',
  font: '600 11px/1.4 var(--manuscript-serif, serif)',
});
globalStyle('.pg-workspace .pg-revision-diff-preview pre', {
  margin: '0',
  overflowWrap: 'anywhere',
  whiteSpace: 'pre-wrap',
  font: '14px/1.7 var(--manuscript-serif, serif)',
});
globalStyle('.pg-workspace .pg-revision-diff-metadata,\n  .pg-workspace .pg-revision-diff-hunk', {
  '@media': { '(max-width: 640px)': { gridTemplateColumns: 'minmax(0, 1fr)' } },
});
globalStyle('.st-studio-breadcrumb', { '@container': { 'st-main (inline-size < 62rem)': { maxInlineSize: '35vw' } } });
globalStyle('.st-studio-masthead-actions', { '@container': { 'st-main (inline-size < 62rem)': { gap: '5px' } } });
globalStyle('.st-studio-main', { '@media': { '(max-width: 900px)': { gridTemplateRows: 'auto minmax(0, 1fr) 30px' } } });
globalStyle('.st-studio-topbar', { '@media': { '(max-width: 900px)': { flexWrap: 'wrap', paddingBlock: '8px' } } });
globalStyle('.st-studio-identity', { '@media': { '(max-width: 900px)': { flex: '1 1 100%' } } });
globalStyle('.st-studio-breadcrumb', { '@media': { '(max-width: 900px)': { maxInlineSize: 'calc(100vw - 160px)' } } });
globalStyle('.st-studio-masthead-actions', { '@media': { '(max-width: 900px)': { flex: '1 1 100%', flexWrap: 'wrap' } } });
globalStyle('.st-studio-console-link', { '@media': { '(max-width: 900px)': { flex: '0 0 auto', marginInlineStart: 'auto' } } });
globalStyle('.st-studio-shell .st-workspace-desktop-controls', { '@media': { '(max-width: 760px)': { alignItems: 'flex-start' } } });
globalStyle('.st-studio-shell .st-workspace-toolbar', { '@media': { '(max-width: 760px)': { flexWrap: 'wrap' } } });
globalStyle('.st-studio-shell .st-workspace-layout', { '@media': { '(max-width: 760px)': { overflow: 'auto' } } });
globalStyle('.st-studio-shell .st-workspace-split-horizontal', { '@media': { '(max-width: 760px)': { minInlineSize: '720px' } } });
globalStyle('.st-studio-shell .st-workspace-resize-handle::after', {
  '@media': { '(prefers-reduced-motion: reduce)': { transition: 'none' } },
});
