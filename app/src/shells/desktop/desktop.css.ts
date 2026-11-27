import type { CSSProperties } from '@vanilla-extract/css';
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
globalStyle('.st-desktop-switch:focus-visible', {
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
