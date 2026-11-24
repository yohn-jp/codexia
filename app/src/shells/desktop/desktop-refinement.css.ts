import { globalStyle } from '@vanilla-extract/css';

globalStyle('.st-desktop-shell.st-studio-shell .st-workspace-desktop-controls', {
  minBlockSize: 'calc(2.75rem + 5px)',
  position: 'relative',
  zIndex: '4',
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  alignItems: 'center',
  gap: 'clamp(0.4rem, 1vw, 0.9rem)',
  paddingInline: 'clamp(0.75rem, 2vw, 1.75rem)',
  paddingBlockStart: '5px',
  overflow: 'visible',
});
globalStyle('.st-desktop-shell.st-studio-shell .st-workspace-toolbar', {
  minWidth: '0',
  minHeight: '2.75rem',
  flex: '1 1 auto',
  gap: 'clamp(0.25rem, 0.8vw, 0.75rem)',
  padding: '0',
  overflow: 'visible',
  border: '0',
});
globalStyle('.st-desktop-shell.st-studio-shell .st-workspace-presets', { minWidth: '0', gap: 'clamp(0.15rem, 0.45vw, 0.5rem)' });
globalStyle(
  '.st-desktop-shell.st-studio-shell .st-workspace-presets button,\n.st-desktop-shell.st-studio-shell .st-workspace-panel-menu summary,\n.st-desktop-shell.st-studio-shell .st-workspace-move-menu > summary,\n.st-desktop-shell.st-studio-shell .st-workspace-save',
  {
    minWidth: '2.75rem',
    minHeight: '2.75rem',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    paddingInline: 'clamp(0.45rem, 0.9vw, 0.8rem)',
  },
);
globalStyle('.st-desktop-shell.st-studio-shell .st-workspace-move-menu', { justifySelf: 'end', flex: '0 0 auto', border: '0' });
globalStyle('.st-desktop-shell.st-studio-shell .st-workspace-move-menu[open]', {
  display: 'grid',
  gridColumn: '1 / -1',
  gridTemplateColumns: 'minmax(0, 1fr)',
  justifySelf: 'stretch',
  gap: '0.5rem',
  margin: '0',
});
globalStyle('.st-desktop-shell.st-studio-shell .st-workspace-move-menu > summary', {
  cursor: 'pointer',
  border: '1px solid transparent',
  borderRadius: '0.25rem',
  color: 'var(--muted)',
  background: 'transparent',
  fontSize: 'inherit',
  whiteSpace: 'nowrap',
});
globalStyle('.st-desktop-shell.st-studio-shell .st-workspace-move-menu[open] > summary', {
  borderColor: 'var(--line)',
  color: 'var(--ink)',
  background: 'var(--paper)',
  justifySelf: 'end',
});
globalStyle('.st-desktop-shell.st-studio-shell .st-workspace-move-menu[open] > .st-workspace-move-controls', {
  position: 'static',
  display: 'grid',
  justifySelf: 'end',
  width: 'min(42rem, 100%)',
  maxHeight: 'min(70dvh, 28rem)',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  alignItems: 'end',
  gap: '0.75rem',
  padding: '1rem',
  overflow: 'auto',
  border: '1px solid var(--line)',
  borderRadius: '0.5rem',
  background: 'var(--paper)',
});
globalStyle('.st-desktop-shell.st-studio-shell .st-workspace-move-controls label', {
  minWidth: '0',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'stretch',
  gap: '0.35rem',
  fontSize: 'inherit',
});
globalStyle('.st-desktop-shell.st-studio-shell .st-workspace-move-controls select', {
  width: '100%',
  minWidth: '0',
  maxWidth: 'none',
  minHeight: '2.75rem',
});
globalStyle('.st-desktop-shell.st-studio-shell .st-workspace-move-controls > button', {
  minHeight: '2.75rem',
  gridColumn: '1 / -1',
  justifySelf: 'end',
  minWidth: '7rem',
});
globalStyle('.st-desktop-shell.st-studio-shell .st-workspace-panel[data-workspace-panel="editor"]', {
  containerName: 'editor-panel',
  containerType: 'inline-size',
});
globalStyle('.st-desktop-shell.st-studio-shell .st-workspace-panel[data-workspace-panel="editor"] .pg-editor-column', {
  '@container': { 'editor-panel (max-width: 760px)': { paddingInline: 'clamp(0.5rem, 1.6cqi, 0.75rem)' } },
});
globalStyle('.st-desktop-shell.st-studio-shell .st-workspace-panel[data-workspace-panel="editor"] .manuscript-column', {
  '@container': { 'editor-panel (max-width: 760px)': { paddingInline: 'clamp(0.25rem, 1cqi, 0.5rem)' } },
});
globalStyle('.st-desktop-shell.st-studio-shell .st-workspace-desktop-controls', {
  '@container': { 'st-main (max-width: 760px)': { gap: '0.35rem', paddingInline: '0.75rem' } },
});
globalStyle('.st-desktop-shell.st-studio-shell .st-workspace-toolbar', {
  '@container': { 'st-main (max-width: 760px)': { flexWrap: 'wrap', gap: '0.25rem' } },
});
globalStyle('.st-desktop-shell.st-studio-shell .st-workspace-presets', {
  '@container': { 'st-main (max-width: 760px)': { flex: '1 1 auto' } },
});
globalStyle('.st-desktop-shell.st-studio-shell .st-workspace-desktop-controls', {
  '@container': { 'st-main (max-width: 540px)': { gridTemplateColumns: 'minmax(0, 1fr)' } },
});
globalStyle('.st-desktop-shell.st-studio-shell .st-workspace-move-menu[open] > .st-workspace-move-controls', {
  '@container': { 'st-main (max-width: 540px)': { gridTemplateColumns: 'minmax(0, 1fr)' } },
});
globalStyle('.st-desktop-shell.st-studio-shell .st-workspace-move-controls > button', {
  '@container': { 'st-main (max-width: 540px)': { gridColumn: 'auto', justifySelf: 'stretch' } },
});
