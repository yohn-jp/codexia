import { scopedGlobalStyle as globalStyle } from '../styles/scoped-global-style.css';

globalStyle('.st-workspace', {
  display: 'flex',
  width: '100%',
  minWidth: '0',
  minHeight: '0',
  flex: '1 1 auto',
  flexDirection: 'column',
  overflow: 'hidden',
  color: 'var(--ink)',
  background: 'var(--paper)',
  font: 'inherit',
});
globalStyle('.st-workspace button,\n.st-workspace select', {
  minHeight: '2.35rem',
  border: '1px solid var(--line)',
  borderRadius: '0.35rem',
  color: 'var(--ink)',
  background: 'var(--paper)',
  font: 'inherit',
});
globalStyle('.st-workspace button', { padding: '0.35rem 0.65rem' });
globalStyle('.st-workspace button:hover:not(:disabled)', { background: 'var(--surface-hover)' });
globalStyle('.st-workspace button:disabled', { opacity: '0.55' });
globalStyle('.st-workspace :is(button, select, summary, [tabindex="0"]):focus-visible', {
  outline: '3px solid var(--focus-ring)',
  outlineOffset: '2px',
  zIndex: '2',
});
globalStyle('.st-workspace-toolbar,\n.st-workspace-presets,\n.st-workspace-move-controls', {
  display: 'flex',
  minWidth: '0',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: '0.45rem',
});
globalStyle('.st-workspace-toolbar', {
  position: 'relative',
  zIndex: '4',
  flex: '0 0 auto',
  padding: '0.45rem 0.6rem',
  borderBottom: '1px solid var(--line)',
  background: 'var(--toolbar-bg)',
});
globalStyle('.st-workspace-presets button[aria-pressed="true"]', { borderColor: 'var(--accent-strong)', color: 'var(--accent-strong)' });
globalStyle('.st-workspace-panel-menu', { position: 'relative', zIndex: '3' });
globalStyle('.st-workspace-panel-menu summary', {
  minHeight: '2.35rem',
  padding: '0.45rem 0.7rem',
  border: '1px solid var(--line)',
  borderRadius: '0.35rem',
  cursor: 'pointer',
  background: 'var(--paper)',
});
globalStyle('.st-workspace-panel-menu-list', {
  position: 'absolute',
  top: 'calc(100% + 0.25rem)',
  left: '0',
  display: 'grid',
  minWidth: 'min(22rem, 88vw)',
  maxHeight: '65vh',
  gap: '0.35rem',
  padding: '0.55rem',
  overflow: 'auto',
  border: '1px solid var(--line)',
  borderRadius: '0.45rem',
  background: 'var(--paper)',
  boxShadow: '0 0.5rem 1.5rem rgb(0 0 0 / 16%)',
});
globalStyle('.st-workspace-panel-menu-search', { display: 'grid', gap: '0.25rem', fontSize: '0.8rem', color: 'var(--muted)' });
globalStyle('.st-workspace-panel-menu-search input', {
  width: '100%',
  minWidth: '0',
  minHeight: '2.5rem',
  padding: '0.4rem 0.5rem',
  border: '1px solid var(--input-border)',
  borderRadius: '0.3rem',
  color: 'var(--ink)',
  background: 'var(--paper)',
});
globalStyle('.st-workspace-panel-menu-item', { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' });
globalStyle('.st-workspace-panel-menu-item span', { minWidth: '0', overflowWrap: 'anywhere' });
globalStyle('.st-workspace-save', { marginLeft: 'auto', fontWeight: '700 !important' });
globalStyle('.st-workspace-move-controls', {
  flex: '0 0 auto',
  padding: '0.45rem 0.6rem',
  borderBottom: '1px solid var(--line)',
  background: 'var(--surface-subtle)',
});
globalStyle('.st-workspace-move-controls label', {
  display: 'flex',
  minWidth: '8rem',
  alignItems: 'center',
  gap: '0.35rem',
  color: 'var(--muted)',
  fontSize: '0.76rem',
});
globalStyle('.st-workspace-move-controls select', { minWidth: '5rem', maxWidth: '13rem', padding: '0.3rem' });
globalStyle('.st-workspace-move-controls button', { fontWeight: '650' });
globalStyle('.st-workspace-storage-state,\n.st-workspace-message,\n.st-workspace-warning', {
  flex: '0 0 auto',
  margin: '0',
  padding: '0.25rem 0.7rem',
  color: 'var(--muted)',
  fontSize: '0.76rem',
});
globalStyle('.st-workspace-warning', { color: 'var(--error-text)', background: 'var(--error-bg)' });
globalStyle('.st-workspace-message', { color: 'var(--accent-strong)' });
globalStyle('.st-workspace-layout,\n.st-workspace-split,\n.st-workspace-resizable-panel,\n.st-workspace-stack,\n.st-workspace-tab-panel', {
  width: '100%',
  height: '100%',
  minWidth: '0',
  minHeight: '0',
});
globalStyle('.st-workspace-layout', { flex: '1 1 auto', overflow: 'hidden' });
globalStyle('.st-workspace-split', { display: 'flex', overflow: 'hidden', background: 'var(--paper)' });
globalStyle('.st-workspace-split-child', { display: 'contents' });
globalStyle('.st-workspace-resizable-panel', { overflow: 'hidden' });
globalStyle('.st-workspace-resize-handle', {
  position: 'relative',
  zIndex: '1',
  flex: '0 0 auto',
  touchAction: 'none',
  background: 'var(--line)',
});
globalStyle('.st-workspace-resize-horizontal', { width: '0.55rem', cursor: 'col-resize' });
globalStyle('.st-workspace-resize-vertical', { height: '0.55rem', cursor: 'row-resize' });
globalStyle('.st-workspace-resize-handle:hover,\n.st-workspace-resize-handle[data-resize-handle-active]', { background: 'var(--accent)' });
globalStyle('.st-workspace-panel', {
  display: 'flex',
  width: '100%',
  height: '100%',
  minWidth: '0',
  minHeight: '0',
  flexDirection: 'column',
  overflow: 'hidden',
  background: 'var(--paper)',
});
globalStyle('.st-workspace-panel:focus', { outline: '2px solid var(--focus-ring)', outlineOffset: '-2px' });
globalStyle('.st-workspace-panel-heading', {
  position: 'relative',
  zIndex: '1',
  display: 'flex',
  minHeight: '2.5rem',
  flex: '0 0 auto',
  alignItems: 'center',
  gap: '0.4rem',
  padding: '0.2rem 0.45rem',
  borderBottom: '1px solid var(--line)',
  background: 'var(--toolbar-bg)',
});
globalStyle('.st-workspace-panel-heading h2', {
  minWidth: '0',
  flex: '1 1 auto',
  margin: '0',
  overflow: 'hidden',
  fontSize: '0.86rem',
  fontWeight: '650',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});
globalStyle('.st-workspace-drag-grip', {
  flex: '0 0 auto',
  padding: '0.3rem 0.45rem',
  border: '1px solid var(--line)',
  borderRadius: '0.3rem',
  color: 'var(--muted)',
  cursor: 'grab',
  userSelect: 'none',
});
globalStyle('.st-workspace-drag-grip:active', { cursor: 'grabbing' });
globalStyle('.st-workspace-drop-zones', { display: 'flex', flex: '0 0 auto', gap: '0.15rem' });
globalStyle('.st-workspace-drop-zone', {
  display: 'grid',
  width: '1.7rem',
  height: '1.7rem',
  placeItems: 'center',
  border: '1px dashed var(--line)',
  borderRadius: '0.25rem',
  color: 'var(--muted)',
  fontSize: '0.72rem',
});
globalStyle('.st-workspace-drop-zone:hover', { borderColor: 'var(--accent)', background: 'var(--surface-selected)' });
globalStyle('.st-workspace-hide', { minWidth: '2.2rem', paddingInline: '0.45rem !important' });
globalStyle('.st-workspace-panel-body', {
  minWidth: '0',
  minHeight: '0',
  flex: '1 1 auto',
  overflow: 'auto',
  overscrollBehavior: 'contain',
});
globalStyle('.st-workspace-unavailable', { margin: '1rem', color: 'var(--muted)' });
globalStyle('.st-workspace-stack', { display: 'flex', flexDirection: 'column', overflow: 'hidden' });
globalStyle('.st-workspace-tabs', {
  display: 'flex',
  minWidth: '0',
  flex: '0 0 auto',
  gap: '0.2rem',
  padding: '0.3rem 0.4rem 0',
  overflowX: 'auto',
  borderBottom: '1px solid var(--line)',
  background: 'var(--toolbar-bg)',
});
globalStyle('.st-workspace-tab', { flex: '0 0 auto', whiteSpace: 'nowrap' });
globalStyle('.st-workspace-tab[aria-selected="true"]', {
  borderBottom: '3px solid var(--accent-strong)',
  color: 'var(--accent-strong)',
  fontWeight: '700',
});
globalStyle('.st-workspace-tab-panel', { flex: '1 1 auto', overflow: 'hidden' });
globalStyle('.st-workspace-toolbar', { '@media': { '(max-width: 42rem)': { gap: '0.3rem', padding: '0.4rem' } } });
globalStyle('.st-workspace-move-controls', { '@media': { '(max-width: 42rem)': { alignItems: 'stretch' } } });
globalStyle('.st-workspace-move-controls label', {
  '@media': {
    '(max-width: 42rem)': {
      minWidth: 'calc(50% - 0.3rem)',
      flex: '1 1 calc(50% - 0.3rem)',
      flexDirection: 'column',
      alignItems: 'stretch',
    },
  },
});
globalStyle('.st-workspace-move-controls select', {
  '@media': { '(max-width: 42rem)': { width: '100%', maxWidth: 'none', minHeight: '2.75rem' } },
});
globalStyle('.st-workspace-move-controls > button', { '@media': { '(max-width: 42rem)': { flex: '1 1 100%', minHeight: '2.75rem' } } });
globalStyle('.st-workspace-drop-zones', { '@media': { '(max-width: 42rem)': { display: 'none' } } });
globalStyle('.st-workspace', { position: 'relative' });
globalStyle('.st-workspace-frame-actions', { display: 'flex', alignItems: 'center', gap: '3px' });
globalStyle('.st-workspace-frame-actions button', { minWidth: '26px', minHeight: '26px', padding: '2px 5px', fontSize: '12px' });
globalStyle('.st-workspace-float-button,.st-workspace-maximize', {
  borderColor: 'var(--line)',
  background: 'transparent',
  color: 'var(--muted)',
});
globalStyle('.st-workspace-move-menu', { flex: '0 0 auto', position: 'relative', zIndex: '3', borderBottom: '1px solid var(--line)' });
globalStyle('.st-workspace-move-menu>summary', {
  cursor: 'pointer',
  userSelect: 'none',
  minHeight: '30px',
  padding: '5px 13px',
  color: 'var(--muted)',
  background: 'var(--toolbar-bg)',
  fontSize: '12px',
});
globalStyle('.st-workspace-move-menu:not([open]) .st-workspace-move-controls', { display: 'none' });
globalStyle('.st-workspace-float', {
  position: 'absolute',
  zIndex: '8',
  display: 'flex',
  flexDirection: 'column',
  minWidth: '180px',
  minHeight: '150px',
  maxWidth: 'calc(100% - 8px)',
  maxHeight: 'calc(100% - 8px)',
  border: '1px solid var(--line)',
  borderRadius: '8px',
  background: 'var(--paper)',
  boxShadow: '0 20px 50px rgb(0 0 0 / 24%)',
  overflow: 'hidden',
  resize: 'both',
});
globalStyle('.st-workspace-float-handle', {
  display: 'flex',
  alignItems: 'center',
  flex: '0 0 38px',
  gap: '5px',
  padding: '5px 9px',
  borderBottom: '1px solid var(--line)',
  color: 'var(--ink)',
  background: 'var(--toolbar-bg)',
  cursor: 'grab',
  touchAction: 'none',
  userSelect: 'none',
});
globalStyle('.st-workspace-float-handle:active', { cursor: 'grabbing' });
globalStyle('.st-workspace-float-mark,.st-workspace-float-title', { pointerEvents: 'none' });
globalStyle('.st-workspace-float-mark', { color: 'var(--muted)', padding: '0 4px' });
globalStyle('.st-workspace-float-title', {
  minWidth: '0',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  flex: '1',
  fontSize: '12px',
  fontWeight: '650',
});
globalStyle('.st-workspace-float-handle button', {
  flex: '0 0 auto',
  minHeight: '27px',
  padding: '3px 7px',
  borderColor: 'var(--line)',
  color: 'var(--ink)',
  background: 'var(--paper)',
  fontSize: '11px',
});
globalStyle('.st-workspace-float-content', { minWidth: '0', minHeight: '0', overflow: 'auto', flex: '1' });
globalStyle('.st-workspace-float:focus-within', { zIndex: '9' });
globalStyle('.st-workspace-float.is-maximized', {
  position: 'fixed',
  inset: '145px 14px 42px 70px !important',
  width: 'auto !important',
  height: 'auto !important',
  maxWidth: 'none',
  maxHeight: 'none',
  resize: 'none',
  zIndex: '35',
});
globalStyle('.st-workspace[data-maximized-panel] .st-workspace-panel.is-maximized', {
  position: 'fixed',
  inset: '145px 14px 42px 70px',
  width: 'auto',
  height: 'auto',
  maxWidth: 'none',
  maxHeight: 'none',
  zIndex: '30',
  border: '1px solid var(--line)',
  boxShadow: '0 20px 50px rgb(0 0 0 / 18%)',
});
globalStyle('.st-workspace-float.is-maximized', { '@media': { '(max-width:760px)': { inset: '110px 7px 35px 50px !important' } } });
globalStyle('.st-workspace[data-maximized-panel] [data-workspace-panel]', { '@media': { '(max-width:760px)': { maxWidth: '100vw' } } });
