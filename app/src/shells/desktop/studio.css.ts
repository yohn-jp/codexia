import { type CSSProperties } from '@vanilla-extract/css';
import { scopedGlobalStyle as globalStyle } from '../../styles/scoped-global-style.css';

globalStyle('.st-studio-shell', {
  display: 'grid',
  gridTemplateColumns: '56px minmax(0, 1fr)',
  color: 'var(--ink)',
  background: 'var(--st-canvas)',
  fontFamily: 'inherit',
});
globalStyle('.st-studio-rail', {
  zIndex: '5',
  display: 'flex',
  minWidth: '0',
  flexDirection: 'column',
  alignItems: 'center',
  color: 'var(--st-rail-ink)',
  background: 'var(--st-rail)',
  borderRight: '1px solid var(--st-rail-edge)',
});
globalStyle('.st-studio-monogram', {
  display: 'grid',
  width: '56px',
  height: '64px',
  flex: '0 0 auto',
  placeItems: 'center',
  color: 'var(--st-rail-ink)',
  font: '650 25px Georgia, "Times New Roman", serif',
  textDecoration: 'none',
});
globalStyle('.st-studio-monogram span,\n.st-studio-wordmark span', { color: 'var(--accent)' });
globalStyle('.st-studio-rail-nav,\n.st-studio-rail-bottom', {
  display: 'flex',
  width: '100%',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '6px',
});
globalStyle('.st-studio-rail-bottom', { marginTop: 'auto', marginBottom: '12px' });
globalStyle('.st-studio-rail-item', {
  display: 'grid',
  width: '40px',
  height: '40px',
  minHeight: '40px',
  placeItems: 'center',
  padding: '0',
  border: '1px solid transparent',
  borderRadius: '6px',
  color: 'var(--st-rail-muted)',
  background: 'transparent',
  fontSize: '20px',
  lineHeight: '1',
  cursor: 'pointer',
});
globalStyle('.st-studio-rail-item:hover:not(:disabled),\n.st-studio-rail-item.is-current', {
  borderColor: 'var(--st-rail-edge)',
  color: 'var(--st-rail-ink)',
  background: 'var(--st-rail-selected)',
});
globalStyle('.st-studio-rail-item:disabled', { opacity: '0.42', cursor: 'default' });
globalStyle('.st-studio-avatar', {
  display: 'grid',
  width: '28px',
  height: '28px',
  placeItems: 'center',
  border: '1px solid var(--st-rail-edge)',
  borderRadius: '50%',
  color: 'var(--st-rail-ink)',
  background: 'var(--st-rail-selected)',
  font: '600 13px Georgia, "Times New Roman", serif',
});
globalStyle('.st-studio-main', {
  display: 'flex',
  minWidth: '0',
  minHeight: '0',
  height: '100%',
  flexDirection: 'column',
  overflow: 'hidden',
});
globalStyle('.st-studio-topbar', {
  position: 'relative',
  zIndex: '6',
  display: 'flex',
  minWidth: '0',
  minHeight: '64px',
  flex: '0 0 64px',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'clamp(8px, 1.4vw, 20px)',
  padding: '0 clamp(12px, 2vw, 28px)',
  borderBottom: '1px solid var(--line)',
  background: 'var(--paper)',
});
globalStyle('.st-studio-identity', {
  display: 'flex',
  minWidth: '0',
  flex: '1 1 auto',
  alignItems: 'center',
  gap: 'clamp(12px, 1.8vw, 24px)',
});
globalStyle('.st-studio-wordmark', {
  flex: '0 0 auto',
  color: 'var(--ink)',
  font: '650 23px Georgia, "Times New Roman", serif',
  letterSpacing: '-0.055em',
  textDecoration: 'none',
});
globalStyle('.st-studio-breadcrumb', {
  display: 'flex',
  minWidth: '0',
  maxWidth: '28rem',
  alignItems: 'center',
  gap: '8px',
  overflow: 'hidden',
  color: 'var(--muted)',
  fontSize: '13px',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});
globalStyle('.st-studio-breadcrumb strong', {
  minWidth: '0',
  overflow: 'hidden',
  color: 'var(--ink)',
  fontWeight: '650',
  textOverflow: 'ellipsis',
});
globalStyle('.st-studio-primary-nav', { display: 'flex', minWidth: '0', flex: '0 0 auto', alignItems: 'center', gap: '3px' });
globalStyle('.st-studio-primary-nav button', {
  minHeight: '36px',
  padding: '7px 13px',
  border: '1px solid transparent',
  borderRadius: '5px',
  color: 'var(--muted)',
  background: 'transparent',
  font: 'inherit',
  fontSize: '13px',
  fontWeight: '600',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
});
globalStyle('.st-studio-primary-nav button:hover:not(:disabled)', { color: 'var(--ink)', background: 'var(--surface-subtle)' });
globalStyle('.st-studio-primary-nav button[aria-pressed="true"]', {
  borderColor: 'var(--surface-selected-border)',
  color: 'var(--accent-strong)',
  background: 'var(--surface-selected)',
});
globalStyle('.st-studio-primary-nav button:disabled', { opacity: '0.45', cursor: 'default' });
globalStyle('.st-studio-masthead-actions', { display: 'flex', minWidth: '0', flex: '0 1 auto', alignItems: 'center', gap: '10px' });
globalStyle('.st-studio-real-actions', { display: 'flex', flex: '0 0 auto', alignItems: 'center', gap: '6px' });
globalStyle('.st-studio-real-actions button', {
  minHeight: '36px',
  padding: '7px 11px',
  borderRadius: '5px',
  fontFamily: 'inherit',
  fontSize: '12px',
  fontWeight: '600',
  whiteSpace: 'nowrap',
});
globalStyle('.st-studio-real-actions .st-studio-checkpoint', {
  borderColor: 'var(--line)',
  color: 'var(--accent-strong)',
  background: 'var(--surface-subtle)',
});
globalStyle('.st-studio-real-actions .st-studio-publish', {
  borderColor: 'var(--accent-strong)',
  color: 'var(--button-foreground)',
  background: 'var(--accent-strong)',
});
globalStyle('.st-studio-real-actions button:disabled', { opacity: '0.55' });
globalStyle('.st-studio-header-slot', { display: 'flex', minWidth: '0', alignItems: 'center', gap: '6px' });
globalStyle('.st-studio-header-slot > h1', {
  position: 'absolute',
  width: '1px',
  height: '1px',
  margin: '-1px',
  padding: '0',
  overflow: 'hidden',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
});
globalStyle('.st-studio-header-slot .theme-control', { gap: '5px', fontSize: '11px' });
globalStyle('.st-studio-header-slot .theme-control select', { minHeight: '35px', fontSize: '12px' });
globalStyle('.st-studio-header-slot .quiet-button', {
  minHeight: '35px',
  padding: '6px 9px',
  border: '1px solid var(--line)',
  fontSize: '12px',
});
globalStyle('.st-studio-durability', {
  display: 'inline-flex',
  minWidth: '0',
  flex: '0 1 auto',
  alignItems: 'center',
  gap: '7px',
  padding: '7px 9px',
  border: '1px solid var(--line)',
  borderRadius: '5px',
  color: 'var(--accent-strong)',
  background: 'var(--surface-subtle)',
  fontSize: '12px',
  fontWeight: '650',
  whiteSpace: 'nowrap',
});
globalStyle('.st-studio-durability::before', {
  display: 'block',
  width: '7px',
  height: '7px',
  flex: '0 0 auto',
  borderRadius: '50%',
  background: 'currentColor',
  content: '""',
});
globalStyle('.st-studio-durability.is-saved', { color: 'var(--success)' });
globalStyle('.st-studio-durability.is-uncertain', { color: 'var(--error-text)', background: 'var(--error-bg)' });
globalStyle('.st-studio-shell .st-desktop-status', {
  right: '18px',
  bottom: '44px',
  borderColor: 'var(--line)',
  background: 'var(--paper)',
  boxShadow: '0 12px 30px rgb(0 0 0 / 14%)',
});
globalStyle('.st-studio-shell .st-workspace', {
  background: 'var(--st-canvas)',
  vars: { '--paper': 'var(--st-folio)', '--line': 'var(--st-folio-edge)', '--toolbar-bg': 'var(--st-folio)' },
});
globalStyle('.st-studio-shell .st-workspace-desktop-controls', {
  position: 'relative',
  zIndex: '4',
  display: 'flex',
  minWidth: '0',
  flex: '0 0 auto',
  alignItems: 'center',
  borderBottom: '1px solid var(--st-folio-edge)',
  background: 'var(--st-folio)',
});
globalStyle('.st-studio-shell .st-workspace-toolbar', {
  minWidth: '0',
  flex: '1 1 auto',
  flexWrap: 'wrap',
  gap: '10px',
  padding: '8px 14px',
  border: '0',
  background: 'var(--st-folio)',
});
globalStyle('.st-studio-shell .st-workspace-presets', { flexWrap: 'nowrap', gap: '3px' });
globalStyle('.st-studio-shell .st-workspace-preset-label', {
  marginRight: '5px',
  color: 'var(--muted)',
  fontSize: '12px',
  whiteSpace: 'nowrap',
});
globalStyle('.st-studio-shell .st-workspace-presets button', {
  minHeight: '34px',
  padding: '6px 10px',
  borderColor: 'transparent',
  borderRadius: '5px',
  color: 'var(--muted)',
  background: 'transparent',
  fontSize: '12px',
  fontWeight: '600',
});
globalStyle('.st-studio-shell .st-workspace-presets button[aria-pressed="true"]', {
  borderColor: 'var(--surface-selected-border)',
  color: 'var(--accent-strong)',
  background: 'var(--surface-selected)',
});
globalStyle('.st-studio-shell .st-workspace-panel-menu summary', {
  minHeight: '34px',
  padding: '6px 10px',
  color: 'var(--muted)',
  background: 'var(--paper)',
  fontSize: '12px',
});
globalStyle('.st-studio-shell .st-workspace-save', {
  minHeight: '36px',
  padding: '7px 12px',
  borderColor: 'var(--accent-strong)',
  borderRadius: '5px',
  color: 'var(--button-foreground)',
  background: 'var(--accent-strong)',
  fontSize: '12px',
});
globalStyle('.st-studio-shell .st-workspace-move-menu', {
  zIndex: '5',
  flex: '0 0 auto',
  alignSelf: 'center',
  marginRight: '14px',
  border: '0',
});
globalStyle('.st-studio-shell .st-workspace-move-menu > summary', {
  minHeight: '36px',
  padding: '7px 11px',
  border: '1px solid var(--line)',
  borderRadius: '5px',
  color: 'var(--ink)',
  background: 'var(--surface-subtle)',
  fontSize: '12px',
  fontWeight: '650',
});
globalStyle('.st-studio-shell .st-workspace-move-menu[open] > summary', {
  borderColor: 'var(--surface-selected-border)',
  color: 'var(--accent-strong)',
  background: 'var(--surface-selected)',
});
globalStyle('.st-studio-shell .st-workspace-move-controls', {
  position: 'absolute',
  top: 'calc(100% + 5px)',
  right: '0',
  display: 'grid',
  width: 'min(780px, calc(100vw - 5rem))',
  gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
  alignItems: 'end',
  gap: '10px',
  padding: '12px',
  border: '1px solid var(--line)',
  borderRadius: '7px',
  background: 'var(--paper)',
  boxShadow: '0 12px 32px rgb(0 0 0 / 17%)',
});
globalStyle('.st-studio-shell .st-workspace-move-controls label', {
  minWidth: '0',
  flexDirection: 'column',
  alignItems: 'stretch',
  color: 'var(--muted)',
  fontSize: '12px',
});
globalStyle('.st-studio-shell .st-workspace-move-controls select', { maxWidth: 'none', minHeight: '36px' });
globalStyle('.st-studio-shell .st-workspace-move-controls > button', {
  minHeight: '36px',
  color: 'var(--button-foreground)',
  background: 'var(--accent-strong)',
  fontSize: '12px',
  fontWeight: '650',
});
globalStyle('.st-studio-shell .st-workspace[data-layout-editing="true"] > .st-workspace-desktop-controls', {
  alignItems: 'stretch',
  flexWrap: 'wrap',
});
globalStyle('.st-studio-shell .st-workspace[data-layout-editing="true"] .st-workspace-move-menu', {
  position: 'static',
  flex: '1 0 100%',
  alignSelf: 'stretch',
  margin: '0 14px 8px',
});
globalStyle('.st-studio-shell .st-workspace[data-layout-editing="true"] .st-workspace-move-controls', {
  position: 'static',
  width: '100%',
  boxShadow: 'none',
});
globalStyle('.st-studio-shell .st-workspace-layout', { padding: '12px', background: 'var(--st-canvas)' });
globalStyle('.st-studio-shell .st-workspace-split', { gap: '7px', background: 'transparent' });
globalStyle('.st-studio-shell .st-workspace-panel', {
  border: '1px solid var(--st-folio-edge)',
  borderRadius: '6px',
  background: 'var(--st-folio)',
});
globalStyle('.st-studio-shell .st-workspace-panel-heading', {
  minHeight: '38px',
  padding: '4px 9px',
  borderBottom: '1px solid var(--st-folio-edge)',
  background: 'var(--surface-subtle)',
});
globalStyle('.st-studio-shell .st-workspace-panel-heading h2', { color: 'var(--ink)', fontSize: '12px', fontWeight: '650' });
globalStyle('.st-studio-shell .st-workspace-frame-actions', { gap: '4px' });
globalStyle('.st-studio-shell .st-workspace-frame-actions button', {
  minWidth: '28px',
  minHeight: '28px',
  padding: '3px 6px',
  borderRadius: '4px',
  color: 'var(--muted)',
  background: 'transparent',
});
globalStyle('.st-studio-shell .st-workspace-drag-grip', {
  padding: '4px 6px',
  borderColor: 'transparent',
  color: 'var(--muted)',
  background: 'transparent',
});
globalStyle('.st-studio-shell .st-workspace-drop-zones', { gap: '3px' });
globalStyle('.st-studio-shell .st-workspace-drop-zone', {
  width: '22px',
  height: '22px',
  borderColor: 'var(--surface-selected-border)',
  color: 'var(--accent-strong)',
  background: 'var(--surface-subtle)',
});
globalStyle('.st-studio-shell .st-workspace-resize-handle', { background: 'transparent' });
globalStyle('.st-studio-shell .st-workspace-resize-horizontal', { width: '7px' });
globalStyle('.st-studio-shell .st-workspace-resize-vertical', { height: '7px' });
globalStyle(
  '.st-studio-shell .st-workspace-resize-handle:hover,\n.st-studio-shell .st-workspace-resize-handle[data-resize-handle-active]',
  { background: 'var(--surface-selected-border)' },
);
globalStyle('.st-studio-shell .st-workspace-panel-body', { background: 'var(--st-folio)' });
globalStyle('.st-studio-shell .st-workspace-tab', { fontSize: '12px' });
globalStyle('.st-studio-shell .st-workspace-stack', { background: 'var(--st-folio)' });
globalStyle('.st-studio-shell .st-workspace-message,\n.st-studio-shell .st-workspace-storage-state', {
  minHeight: '22px',
  padding: '3px 12px',
  fontSize: '11px',
});
globalStyle('.st-studio-shell .st-workspace[data-layout-editing="true"] .st-workspace-panel-heading', {
  background: 'var(--surface-selected)',
});
globalStyle('.st-studio-shell .st-workspace :is(.sidebar, .writing-area)', { padding: '12px', border: '0', background: 'transparent' });
globalStyle('.st-studio-shell .st-workspace .editor', { maxWidth: 'none' });
globalStyle('.st-studio-shell .st-workspace .editor-header', {
  alignItems: 'center',
  margin: '0 0 16px',
  padding: '9px 3px 16px',
  borderBottom: '1px solid var(--line)',
});
globalStyle('.st-studio-shell .st-workspace .editor-header h1', {
  color: 'var(--ink)',
  font: '600 clamp(24px, 2.2vw, 32px) var(--manuscript-serif)',
  letterSpacing: '-0.035em',
});
globalStyle('.st-studio-shell .st-workspace .eyebrow', { color: 'var(--muted)', fontSize: '11px' });
globalStyle('.st-studio-shell .st-workspace .editor-columns', { gridTemplateColumns: 'minmax(0, 1fr) minmax(210px, 0.3fr)', gap: '12px' });
globalStyle('.st-studio-shell .st-workspace .manuscript-column,\n.st-studio-shell .st-workspace .preview-column', {
  borderColor: 'var(--st-folio-edge)',
  borderRadius: '5px',
  background: 'var(--st-folio)',
});
globalStyle('.st-studio-shell .st-workspace .manuscript-column', { padding: 'clamp(16px, 2vw, 30px)', boxShadow: 'none' });
globalStyle('.st-studio-shell .st-workspace .manuscript-column > label', { color: 'var(--muted)', fontSize: '11px' });
globalStyle('.st-studio-shell .st-workspace .cm-editor', { color: 'var(--ink)', background: 'var(--st-folio)' });
globalStyle('.st-studio-shell .st-workspace .cm-content', {
  padding: '18px 8px',
  fontFamily: 'var(--editor-font-family, var(--manuscript-serif))',
  fontSize: 'var(--editor-font-size, 16px)',
  lineHeight: 'var(--editor-line-height, 1.8)',
  letterSpacing: 'var(--editor-letter-spacing, normal)',
});
globalStyle('.st-studio-shell .st-workspace .typography-toolbar', { borderColor: 'var(--line)', background: 'var(--surface-subtle)' });
globalStyle('.st-studio-shell .st-workspace .durability-row', { gap: '8px' });
globalStyle('.st-studio-shell .st-workspace .durability-badge', { borderColor: 'var(--line)', background: 'var(--surface-subtle)' });
globalStyle('.st-studio-shell .st-workspace .durability-badge.is-current', { color: 'var(--success)' });
globalStyle('.st-studio-shell .st-workspace .sidebar :is(h2, h3)', { color: 'var(--ink)', fontFamily: 'var(--manuscript-serif)' });
globalStyle('.st-studio-footer', {
  display: 'flex',
  minHeight: '30px',
  flex: '0 0 30px',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '12px',
  padding: '0 14px',
  borderTop: '1px solid var(--line)',
  color: 'var(--muted)',
  background: 'var(--paper)',
  fontSize: '11px',
  whiteSpace: 'nowrap',
});
globalStyle('.st-studio-footer-dot', {
  display: 'inline-block',
  width: '6px',
  height: '6px',
  marginRight: '7px',
  borderRadius: '50%',
  background: 'var(--accent)',
});
globalStyle('.st-studio-shell :is(button, a, summary, select, [tabindex]):focus-visible', {
  outline: '3px solid var(--focus-ring)',
  outlineOffset: '2px',
});
globalStyle('.st-studio-breadcrumb', { '@media': { '(max-width: 1180px)': { display: 'none' } } });
globalStyle('.st-studio-topbar', { '@media': { '(max-width: 1180px)': { paddingInline: '12px' } } });
globalStyle('.st-studio-masthead-actions', { '@media': { '(max-width: 1180px)': { gap: '6px' } } });
globalStyle('.st-studio-shell .st-workspace .editor-columns', {
  '@media': { '(max-width: 1180px)': { gridTemplateColumns: 'minmax(0, 1fr)' } },
});
globalStyle('.st-studio-shell', { '@media': { '(max-width: 900px)': { gridTemplateColumns: '48px minmax(0, 1fr)' } } });
globalStyle('.st-studio-monogram', { '@media': { '(max-width: 900px)': { width: '48px' } } });
globalStyle('.st-studio-topbar', { '@media': { '(max-width: 900px)': { gap: '7px' } } });
globalStyle('.st-studio-wordmark', { '@media': { '(max-width: 900px)': { fontSize: '20px' } } });
globalStyle('.st-studio-primary-nav', { '@media': { '(max-width: 900px)': { gap: '0' } } });
globalStyle('.st-studio-primary-nav button', {
  '@media': { '(max-width: 900px)': { minHeight: '34px', paddingInline: '8px', fontSize: '12px' } },
});
globalStyle('.st-studio-durability', {
  '@media': {
    '(max-width: 900px)': { maxWidth: '12rem', padding: '6px 7px', fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis' },
  },
});
globalStyle('.st-studio-shell .st-workspace-desktop-controls', { '@media': { '(max-width: 900px)': { alignItems: 'stretch' } } });
globalStyle('.st-studio-shell .st-workspace-toolbar', { '@media': { '(max-width: 900px)': { gap: '5px', paddingInline: '8px' } } });
globalStyle('.st-studio-shell .st-workspace-preset-label', { '@media': { '(max-width: 900px)': { display: 'none' } } });
globalStyle('.st-studio-shell .st-workspace-move-menu', { '@media': { '(max-width: 900px)': { marginRight: '8px' } } });
globalStyle('.st-studio-footer > span:last-child', { '@media': { '(max-width: 900px)': { display: 'none' } } });
globalStyle('.st-studio-topbar', {
  '@media': { '(max-width: 680px)': { minHeight: '74px', height: 'auto', flex: '0 0 auto', flexWrap: 'wrap', paddingBlock: '7px' } },
});
globalStyle('.st-studio-identity', { '@media': { '(max-width: 680px)': { flex: '0 0 auto' } } });
globalStyle('.st-studio-primary-nav', { '@media': { '(max-width: 680px)': { order: '3', flex: '1 1 100%', justifyContent: 'center' } } });
globalStyle('.st-studio-masthead-actions', {
  '@media': { '(max-width: 680px)': { marginLeft: 'auto', flex: '1 1 100%', flexWrap: 'wrap' } },
});
globalStyle('.st-studio-header-slot', { '@media': { '(max-width: 680px)': { flexWrap: 'wrap' } } });
globalStyle('.st-studio-header-slot .theme-control', { '@media': { '(max-width: 680px)': { flex: '0 0 auto' } } });
globalStyle('.st-studio-shell .st-workspace-desktop-controls', { '@media': { '(max-width: 680px)': { flexWrap: 'wrap' } } });
globalStyle('.st-studio-shell .st-workspace-move-menu', { '@media': { '(max-width: 680px)': { margin: '0 8px 6px auto' } } });
globalStyle('.st-studio-shell .st-workspace-move-controls', {
  '@media': { '(max-width: 680px)': { width: 'calc(100vw - 64px)', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' } },
});
globalStyle('.st-studio-shell *,\n  .st-studio-shell *::before,\n  .st-studio-shell *::after', {
  '@media': {
    '(prefers-reduced-motion: reduce)': {
      animationDuration: '0.01ms !important',
      transitionDuration: '0.01ms !important',
      scrollBehavior: 'auto !important' as unknown as CSSProperties['scrollBehavior'],
    },
  },
});
