import { type CSSProperties } from '@vanilla-extract/css';
import { scopedGlobalStyle as globalStyle } from '../../styles/scoped-global-style.css';

globalStyle('.st-desktop-shell', { display: 'flex', width: '100%', minWidth: '0', height: '100vh' });
globalStyle('.st-desktop-shell', {
  height: '100dvh',
  minHeight: '0',
  flexDirection: 'column',
  overflow: 'hidden',
  color: 'var(--ink)',
  background: 'var(--page-bg)',
});
globalStyle('.st-desktop-chrome', {
  position: 'relative',
  zIndex: '2',
  flex: '0 0 auto',
  borderBottom: '1px solid var(--line)',
  background: 'var(--paper)',
});
globalStyle('.st-desktop-header-slot', { minWidth: '0' });
globalStyle('.st-desktop-controls', {
  display: 'flex',
  minWidth: '0',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.8rem',
  padding: '0 0.8rem',
  borderTop: '1px solid var(--line)',
  background: 'var(--toolbar-bg)',
});
globalStyle('.st-desktop-workbench-label', { minWidth: '0', color: 'var(--muted)', fontSize: '0.8rem' });
globalStyle('.st-desktop-panel-tab', {
  minHeight: '2.45rem',
  padding: '0.45rem 0.8rem',
  border: '0',
  borderRadius: '0',
  color: 'var(--muted)',
  background: 'transparent',
  fontSize: '0.84rem',
  fontWeight: '650',
  whiteSpace: 'nowrap',
});
globalStyle('.st-desktop-panel-tab:hover', { color: 'var(--ink)', background: 'var(--surface-hover)' });
globalStyle('.st-desktop-panel-tab[data-state="active"]', {
  borderBottom: '2px solid var(--accent)',
  color: 'var(--accent-strong)',
  background: 'transparent',
});
globalStyle('.st-desktop-panel-tab:focus-visible,\n.st-desktop-switch:focus-visible,\n.st-desktop-resize-handle:focus-visible', {
  position: 'relative',
  zIndex: '1',
  outline: '3px solid var(--focus-ring)',
  outlineOffset: '2px',
});
globalStyle('.st-desktop-switch', {
  minHeight: '2.2rem',
  flex: '0 0 auto',
  padding: '0.35rem 0.7rem',
  borderColor: 'var(--line)',
  borderRadius: '0.4rem',
  color: 'var(--accent-strong)',
  background: 'var(--paper)',
  fontSize: '0.82rem',
  fontWeight: '650',
});
globalStyle('.st-desktop-switch:hover:not(:disabled)', { color: 'var(--button-foreground)', background: 'var(--accent-strong)' });
globalStyle('.st-desktop-status', {
  position: 'fixed',
  zIndex: '30',
  right: 'max(1rem, env(safe-area-inset-right, 0px))',
  bottom: 'max(1rem, env(safe-area-inset-bottom, 0px))',
  width: 'min(27rem, calc(100vw - 2.5rem))',
  maxHeight: 'min(45vh, 18rem)',
  padding: '0.8rem 1rem',
  overflow: 'auto',
  border: '1px solid var(--line)',
  borderRadius: '0.7rem',
  background: 'var(--paper)',
  boxShadow: '0 0.75rem 2rem rgb(0 0 0 / 16%)',
  fontSize: '0.84rem',
});
globalStyle('.st-desktop-switch-error', {
  flex: '0 0 auto',
  margin: '0',
  padding: '0.55rem 0.85rem',
  borderBottom: '1px solid var(--error-border)',
  color: 'var(--error-text)',
  background: 'var(--error-bg)',
  fontSize: '0.84rem',
});
globalStyle('.st-desktop-workbench', { minWidth: '0', minHeight: '0', flex: '1 1 auto', overflow: 'hidden', background: 'var(--paper)' });
globalStyle('.st-desktop-navigation-panel,\n.st-desktop-editor-panel', { minWidth: '0', minHeight: '0', overflow: 'hidden' });
globalStyle('.st-desktop-navigation', {
  display: 'flex',
  width: '100%',
  height: '100%',
  minWidth: '0',
  minHeight: '0',
  flexDirection: 'column',
  background: 'var(--sidebar-bg)',
});
globalStyle('.st-desktop-panel-tabs', {
  display: 'flex',
  minWidth: '0',
  flex: '0 0 auto',
  alignItems: 'center',
  gap: '0.1rem',
  padding: '0.35rem 0.45rem 0',
  overflowX: 'auto',
  borderBottom: '1px solid var(--line)',
  background: 'var(--toolbar-bg)',
});
globalStyle('.st-desktop-panel-tab', { paddingInline: '0.65rem', fontSize: '0.78rem' });
globalStyle('.st-desktop-tab-content', {
  minWidth: '0',
  minHeight: '0',
  flex: '1 1 auto',
  overflow: 'auto',
  overscrollBehavior: 'contain',
});
globalStyle('.st-desktop-tab-content[data-state="inactive"]', { display: 'none' });
globalStyle('.st-desktop-slot', { minWidth: '0', minHeight: '100%', padding: '0.85rem', overflowWrap: 'anywhere' });
globalStyle('.st-desktop-library-slot', { background: 'var(--sidebar-bg)' });
globalStyle('.st-desktop-tools-slot', { background: 'var(--page-bg)' });
globalStyle('.st-desktop-editor-slot', {
  width: '100%',
  height: '100%',
  minWidth: '0',
  minHeight: '0',
  overflow: 'auto',
  overscrollBehavior: 'contain',
  outline: 'none',
  background: 'var(--page-bg)',
});
globalStyle('.st-desktop-resize-handle', {
  position: 'relative',
  zIndex: '1',
  display: 'flex',
  width: '0.65rem',
  minWidth: '0.65rem',
  flex: '0 0 0.65rem',
  alignItems: 'stretch',
  justifyContent: 'center',
  cursor: 'col-resize',
  touchAction: 'none',
  background: 'var(--paper-dark)',
});
globalStyle('.st-desktop-resize-handle:hover,\n.st-desktop-resize-handle[data-resize-handle-active]', {
  background: 'var(--surface-selected)',
});
globalStyle('.st-desktop-resize-line', { width: '1px', height: '100%', background: 'var(--line)' });
globalStyle('.st-desktop-visually-hidden', {
  position: 'absolute',
  width: '1px',
  height: '1px',
  padding: '0',
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  clipPath: 'inset(50%)',
});
globalStyle('.st-desktop-controls', { '@media': { '(max-width: 680px)': { gap: '0.35rem', paddingInline: '0.4rem' } } });
globalStyle('.st-desktop-panel-tab', { '@media': { '(max-width: 680px)': { paddingInline: '0.45rem', fontSize: '0.74rem' } } });
globalStyle('.st-desktop-switch', { '@media': { '(max-width: 680px)': { paddingInline: '0.45rem', fontSize: '0.73rem' } } });
globalStyle('.st-desktop-status', { '@media': { '(max-width: 680px)': { maxHeight: '6rem', paddingInline: '0.55rem' } } });
globalStyle('.st-desktop-shell *,\n  .st-desktop-shell *::before,\n  .st-desktop-shell *::after', {
  '@media': {
    '(prefers-reduced-motion: reduce)': {
      scrollBehavior: 'auto !important' as unknown as CSSProperties['scrollBehavior'],
      animationDuration: '0.01ms !important',
      transitionDuration: '0.01ms !important',
    },
  },
});
