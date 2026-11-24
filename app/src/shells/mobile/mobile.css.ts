import { type CSSProperties, globalStyle } from '@vanilla-extract/css';

globalStyle('.mobile-shell', {
  width: '100%',
  minWidth: '320px',
  height: '100vh',
  vars: {
    '--ion-background-color': 'var(--page-bg)',
    '--ion-text-color': 'var(--ink)',
    '--ion-border-color': 'var(--line)',
    '--ion-font-family': '"Hiragino Sans", "Yu Gothic", Meiryo, sans-serif',
    '--ion-color-primary': 'var(--accent)',
    '--ion-color-primary-rgb': '112, 69, 47',
    '--ion-color-primary-contrast': 'var(--button-foreground)',
    '--ion-color-primary-contrast-rgb': '255, 254, 250',
    '--ion-color-primary-shade': 'var(--accent-strong)',
    '--ion-color-primary-tint': 'var(--surface-selected)',
    '--ion-toolbar-background': 'var(--paper)',
    '--ion-toolbar-color': 'var(--ink)',
    '--ion-tab-bar-background': 'var(--paper)',
    '--ion-tab-bar-color': 'var(--muted)',
    '--ion-tab-bar-color-selected': 'var(--accent-strong)',
  },
});
globalStyle('.mobile-shell', {
  height: '100dvh',
  color: 'var(--ink)',
  background: 'var(--page-bg)',
  fontFamily: '"Hiragino Sans", "Yu Gothic", Meiryo, sans-serif',
  colorScheme: 'light',
});
globalStyle(':root[data-zp-theme="dark"] .mobile-shell', { colorScheme: 'dark' });
globalStyle(':root[data-zp-theme="paper"] .mobile-shell', { colorScheme: 'light' });
globalStyle(':root[data-zp-theme="dark"] .mobile-shell', {
  vars: { '--ion-color-primary-rgb': '125, 175, 159', '--ion-color-primary-contrast-rgb': '8, 18, 15' },
});
globalStyle(':root[data-zp-theme="paper"] .mobile-shell', {
  vars: { '--ion-color-primary-rgb': '61, 52, 41', '--ion-color-primary-contrast-rgb': '255, 255, 255' },
});
globalStyle('.mobile-shell .mobile-shell-page', { width: '100%', minWidth: '320px', height: '100%', background: 'var(--page-bg)' });
globalStyle('.mobile-shell .mobile-shell-ion-header', {
  flex: '0 0 auto',
  paddingTop: 'env(safe-area-inset-top, 0px)',
  boxShadow: '0 1px 0 var(--line)',
});
globalStyle('.mobile-shell .mobile-shell-toolbar', {
  vars: { '--min-height': '3.25rem', '--padding-start': '0.25rem', '--padding-end': '0.35rem' },
});
globalStyle('.mobile-shell ion-title', { minWidth: '0', color: 'var(--ink)', fontSize: '1.05rem', fontWeight: '700' });
globalStyle('.mobile-shell .mobile-shell-shared-header', {
  minWidth: '0',
  maxWidth: '100%',
  padding: '0.25rem 0.65rem 0.45rem',
  borderTop: '1px solid var(--line)',
  color: 'var(--ink)',
  background: 'var(--paper)',
});
globalStyle('.mobile-shell-shared-header > *', { minWidth: '0', maxWidth: '100%' });
globalStyle('.mobile-shell-shared-header .topbar', {
  position: 'static',
  display: 'flex',
  minHeight: '2.8rem',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '0.35rem 0.55rem',
  padding: '0',
  border: '0',
  background: 'transparent',
});
globalStyle('.mobile-shell-shared-header .topbar .brand', { display: 'none' });
globalStyle('.mobile-shell-shared-header .topbar-status', { order: '5', flex: '1 1 100%', minHeight: '1.25rem' });
globalStyle('.mobile-shell-shared-header .theme-control', { marginLeft: '0' });
globalStyle('.mobile-shell-shared-header .theme-error', { position: 'static' });
globalStyle('.mobile-shell-shared-header :is(button, input, select, textarea)', { maxWidth: '100%' });
globalStyle('.mobile-shell-shared-header .quiet-button', { minHeight: '2.75rem' });
globalStyle('.mobile-shell-content', {
  color: 'var(--ink)',
  background: 'var(--page-bg)',
  overscrollBehaviorY: 'contain',
  vars: {
    '--background': 'var(--page-bg)',
    '--padding-start': '0',
    '--padding-end': '0',
    '--padding-top': '0',
    '--padding-bottom': '0.75rem',
  },
});
globalStyle('.mobile-shell-content::part(scroll)', { overscrollBehaviorY: 'contain', scrollbarGutter: 'stable' });
globalStyle('.mobile-shell-view-stack', { width: '100%', minWidth: '0' });
globalStyle('.mobile-shell-view-stack > .mobile-shell-view[hidden]', { display: 'none !important' });
globalStyle('.mobile-shell-view', {
  width: '100%',
  minWidth: '0',
  maxWidth: '100%',
  padding: '0.7rem 0.65rem 1.25rem',
  overflowWrap: 'anywhere',
});
globalStyle('.mobile-shell-page-title', { margin: '0 0 0.65rem', color: 'var(--ink)', fontSize: '1.2rem', lineHeight: '1.35' });
globalStyle('.mobile-shell-slot', { width: '100%', minWidth: '0', maxWidth: '100%' });
globalStyle('.mobile-shell-slot :is(article, aside, div, form, main, section, ul, ol)', { minWidth: '0', maxWidth: '100%' });
globalStyle('.mobile-shell-slot :is(input, select, textarea, pre, code, table, img, video, canvas)', { maxWidth: '100%' });
globalStyle('.mobile-shell-slot :is(pre, code, dd, p, li)', { overflowWrap: 'anywhere' });
globalStyle(
  '.mobile-shell-slot .reading-pager-content.is-vertical,\n.mobile-shell-slot .reading-pager-content.is-vertical > div,\n.mobile-shell-slot .manuscript-preview.is-vertical,\n.mobile-shell-slot .reading-view.is-vertical',
  { maxWidth: 'none' },
);
globalStyle('.mobile-shell-slot .writing-area', { minWidth: '0', padding: '0' });
globalStyle('.mobile-shell-slot .editor', { width: '100%', maxWidth: '100%', margin: '0' });
globalStyle('.mobile-shell-slot .editor-header', { alignItems: 'flex-start', flexDirection: 'column', gap: '0.6rem' });
globalStyle('.mobile-shell-slot .editor-actions', { width: '100%', justifyContent: 'flex-start' });
globalStyle('.mobile-shell-slot .editor-columns', { gridTemplateColumns: 'minmax(0, 1fr)', gap: '0.7rem' });
globalStyle('.mobile-shell-slot .manuscript-column,\n.mobile-shell-slot .preview-column', { padding: '0.65rem' });
globalStyle('.mobile-shell-slot .manuscript-input,\n.mobile-shell-slot .cm-scroller,\n.mobile-shell-slot .cm-content', {
  minHeight: '48vh',
});
globalStyle(
  '.mobile-shell-slot .editor-actions button,\n.mobile-shell-slot .typography-toolbar button,\n.mobile-shell-slot .mobile-keyboard button,\n.mobile-shell-slot .scene-button,\n.mobile-shell-slot .project-button',
  { minHeight: '2.75rem' },
);
globalStyle('.mobile-shell-slot .typography-toolbar', { alignItems: 'flex-start' });
globalStyle('.mobile-shell-slot .reading-view', { width: '100%', maxWidth: '100%' });
globalStyle('.mobile-shell-slot .proposal-dock', { gridTemplateColumns: 'minmax(0, 1fr)' });
globalStyle('.mobile-shell-slot .manuscript-history-layout', { gridTemplateColumns: 'minmax(0, 1fr)', maxHeight: 'none' });
globalStyle('.mobile-shell-slot .manuscript-history-layout > ol,\n.mobile-shell-slot .manuscript-history-detail', { maxHeight: '20rem' });
globalStyle('.mobile-shell-slot .proposal-actions,\n.mobile-shell-slot .conflict-actions', { flexWrap: 'wrap' });
globalStyle('.mobile-shell-review-hint', { margin: '0.75rem 0', color: 'var(--muted)', fontSize: '0.9rem', lineHeight: '1.55' });
globalStyle('.mobile-shell-primary-action', { display: 'block', width: '100%', minHeight: '2.9rem', margin: '0.5rem 0' });
globalStyle('.mobile-shell .mobile-shell-primary-action::part(native)', {
  minHeight: '2.9rem',
  borderRadius: '0.45rem',
  fontWeight: '650',
});
globalStyle('.mobile-shell-settings-card', {
  padding: '0.85rem',
  border: '1px solid var(--line)',
  borderRadius: '0.6rem',
  color: 'var(--ink)',
  background: 'var(--paper)',
});
globalStyle('.mobile-shell-settings-card h2', { margin: '0', fontSize: '1rem' });
globalStyle('.mobile-shell-settings-card p', { color: 'var(--muted)', fontSize: '0.9rem', lineHeight: '1.55' });
globalStyle('.mobile-shell-switch-error', {
  padding: '0.65rem',
  border: '1px solid var(--error-border)',
  borderRadius: '0.45rem',
  color: 'var(--error-text)',
  background: 'var(--error-bg)',
  lineHeight: '1.5',
});
globalStyle('.mobile-shell .mobile-shell-status', {
  position: 'fixed',
  zIndex: '30',
  right: 'max(0.75rem, env(safe-area-inset-right, 0px))',
  bottom: 'calc(4rem + env(safe-area-inset-bottom, 0px))',
  width: 'min(25rem, calc(100vw - 3rem))',
  maxHeight: 'min(45vh, 16rem)',
  padding: '0.75rem 0.9rem',
  overflow: 'auto',
  border: '1px solid var(--line)',
  borderRadius: '0.7rem',
  color: 'var(--ink)',
  background: 'var(--paper)',
  boxShadow: '0 0.75rem 2rem rgb(0 0 0 / 16%)',
});
globalStyle('.mobile-shell .mobile-shell-status .application-status', { display: 'grid', gap: '0.3rem' });
globalStyle('.mobile-shell .mobile-shell-status .topbar-status', { flex: 'none', overflowWrap: 'anywhere', whiteSpace: 'normal' });
globalStyle('.mobile-shell-footer', {
  flex: '0 0 auto',
  borderTop: '1px solid var(--line)',
  background: 'var(--paper)',
  paddingBottom: 'env(safe-area-inset-bottom, 0px)',
});
globalStyle('.mobile-shell-navigation', {
  display: 'grid',
  gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
  width: '100%',
  minHeight: '3.45rem',
  padding: '0.2rem 0.35rem 0.25rem',
  gap: '0.15rem',
});
globalStyle('.mobile-shell-navigation ion-button', {
  minWidth: '0',
  minHeight: '2.75rem',
  margin: '0',
  fontSize: '0.78rem',
  vars: { '--padding-start': '0.25rem', '--padding-end': '0.25rem', '--border-radius': '0.45rem' },
});
globalStyle('.mobile-shell-navigation ion-button::part(native)', {
  minWidth: '0',
  minHeight: '2.75rem',
  paddingInline: '0.25rem',
  whiteSpace: 'nowrap',
});
globalStyle('.mobile-shell-navigation ion-button[aria-current="page"]', { fontWeight: '700' });
globalStyle('.mobile-shell ion-button:focus-visible', { outline: '3px solid var(--focus-ring)', outlineOffset: '2px' });
globalStyle('.mobile-shell ion-button::part(native):focus-visible', { outline: '3px solid var(--focus-ring)', outlineOffset: '2px' });
globalStyle('.mobile-shell :is(button, a, input, select, textarea, summary, [tabindex="0"]):focus-visible', {
  outline: '3px solid var(--focus-ring)',
  outlineOffset: '2px',
});
globalStyle('.mobile-shell .mobile-shell-shared-header', { '@media': { '(min-width: 640px)': { paddingInline: '1rem' } } });
globalStyle('.mobile-shell-view', { '@media': { '(min-width: 640px)': { padding: '1rem 1.25rem 1.5rem' } } });
globalStyle('.mobile-shell-slot .editor-columns', {
  '@media': { '(min-width: 640px)': { gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 0.9fr)' } },
});
globalStyle('.mobile-shell-slot .manuscript-history-layout', {
  '@media': { '(min-width: 640px)': { gridTemplateColumns: 'minmax(12rem, 0.35fr) minmax(0, 1fr)' } },
});
globalStyle('.mobile-shell-navigation', { '@media': { '(min-width: 640px)': { maxWidth: '48rem', marginInline: 'auto', gap: '0.4rem' } } });
globalStyle('.mobile-shell-navigation ion-button', { '@media': { '(min-width: 640px)': { fontSize: '0.9rem' } } });
globalStyle('.mobile-shell *,\n  .mobile-shell *::before,\n  .mobile-shell *::after', {
  '@media': {
    '(prefers-reduced-motion: reduce)': {
      scrollBehavior: 'auto !important' as unknown as CSSProperties['scrollBehavior'],
      animationDuration: '0.01ms !important',
      animationIterationCount: '1 !important',
      transitionDuration: '0.01ms !important',
    },
  },
});
globalStyle('.mobile-shell', {
  background: 'var(--mobile-stage)',
  vars: {
    '--mobile-ink': '#273c32',
    '--mobile-muted': 'var(--muted)',
    '--mobile-paper': '#fcfbf5',
    '--mobile-stage': '#f2f2e8',
    '--mobile-line': '#e3e7dc',
    '--mobile-accent': 'var(--accent)',
    '--mobile-gold': '#a47e47',
    '--page-bg': 'var(--mobile-stage)',
    '--paper': 'var(--mobile-paper)',
    '--ink': 'var(--mobile-ink)',
    '--line': 'var(--mobile-line)',
    '--toolbar-bg': 'var(--mobile-paper)',
    '--sidebar-bg': 'var(--mobile-paper)',
    '--surface-hover': '#e9f0e7',
    '--surface-selected': '#e1ebe0',
    '--ion-color-primary': 'var(--accent)',
    '--ion-background-color': 'var(--mobile-paper)',
    '--ion-toolbar-background': 'var(--mobile-paper)',
  },
});
globalStyle('.mobile-shell .mobile-shell-page', { background: 'var(--mobile-stage)' });
globalStyle('.mobile-shell .mobile-shell-ion-header', {
  paddingTop: 'env(safe-area-inset-top,0px)',
  borderBottom: '1px solid var(--mobile-line)',
  boxShadow: 'none',
  background: 'var(--mobile-paper)',
  color: 'var(--mobile-ink)',
});
globalStyle('.mobile-shell-identity-bar', {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  minHeight: '56px',
  padding: '4px max(12px,env(safe-area-inset-left,0px))',
});
globalStyle('.mobile-shell .mobile-shell-back', {
  flex: '0 0 44px',
  width: '44px',
  height: '44px',
  minHeight: '44px',
  margin: '0',
  fontSize: '30px',
  lineHeight: '1',
  vars: { '--padding-start': '0', '--padding-end': '0', '--color': 'var(--mobile-accent)' },
});
globalStyle('.mobile-shell-identity-copy', {
  display: 'flex',
  flex: '1',
  flexDirection: 'column',
  gap: '1px',
  minWidth: '0',
  padding: '1px 0',
});
globalStyle('.mobile-shell-current-title', {
  font: '600 15px/1.4 var(--manuscript-serif)',
  color: 'var(--mobile-ink)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});
globalStyle('.mobile-shell-context', {
  fontSize: '11px',
  lineHeight: '1.35',
  color: 'var(--mobile-muted)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});
globalStyle('.mobile-shell .mobile-shell-settings-entry', {
  flex: '0 0 auto',
  minHeight: '44px',
  margin: '0',
  padding: '0 9px',
  vars: { '--padding-start': '0', '--padding-end': '0', '--color': 'var(--mobile-accent)', '--border-radius': '8px' },
});
globalStyle('.mobile-shell .mobile-shell-settings-entry::part(native)', {
  minHeight: '44px',
  display: 'flex',
  gap: '6px',
  paddingInline: '8px',
  fontSize: '12px',
  fontWeight: '600',
  whiteSpace: 'nowrap',
});
globalStyle('.mobile-shell .mobile-shell-shared-header', {
  display: 'flex',
  flexWrap: 'nowrap',
  overflowX: 'auto',
  overscrollBehaviorX: 'contain',
  borderTop: '1px solid var(--mobile-line)',
  padding: '2px max(8px,env(safe-area-inset-left,0px))',
  scrollbarWidth: 'thin',
  background: 'var(--mobile-paper)',
  minHeight: '46px',
  alignItems: 'center',
  gap: '5px',
});
globalStyle('.mobile-shell .mobile-shell-shared-header[hidden]', { display: 'none !important' });
globalStyle('.mobile-shell .mobile-shell-shared-header::-webkit-scrollbar', { display: 'none' });
globalStyle('.mobile-shell .mobile-shell-shared-header .topbar', {
  flex: '1 0 auto',
  display: 'flex',
  flexWrap: 'nowrap',
  gap: '6px',
  minHeight: '33px',
  padding: '0',
  alignItems: 'center',
});
globalStyle('.mobile-shell .mobile-shell-shared-header .topbar .brand', { display: 'none' });
globalStyle('.mobile-shell .mobile-shell-shared-header .theme-control', { fontSize: '10px', margin: '0', flex: '0 0 auto' });
globalStyle('.mobile-shell .mobile-shell-shared-header .theme-control select', {
  width: '76px',
  minHeight: '44px',
  padding: '3px 6px',
  fontSize: '11px',
});
globalStyle('.mobile-shell .mobile-shell-shared-header .topbar button', {
  minHeight: '32px',
  padding: '4px 8px',
  fontSize: '11px',
  borderRadius: '5px',
});
globalStyle('.mobile-shell .mobile-shell-shared-header .topbar-status', { order: 'unset', flex: '0 1 25vw', fontSize: '10px' });
globalStyle('.mobile-shell .mobile-shell-shared-header:not([data-active-view="settings"])', {
  minHeight: '46px',
  paddingTop: '2px',
  paddingBottom: '2px',
  borderTop: '0',
  overflowX: 'auto',
  alignItems: 'center',
});
globalStyle('.mobile-shell .mobile-shell-shared-header:not([data-active-view="settings"]) > h1', {
  flex: '0 0 auto',
  margin: '0',
  color: 'var(--mobile-muted)',
  font: '500 10px/1.2 var(--manuscript-sans)',
  letterSpacing: '.02em',
  whiteSpace: 'nowrap',
});
globalStyle('.mobile-shell .mobile-shell-shared-header:not([data-active-view="settings"]) > button', {
  flex: '0 0 auto',
  minWidth: '44px',
  minHeight: '44px',
  margin: '0',
  padding: '5px 8px',
  fontSize: '11px',
  whiteSpace: 'nowrap',
});
globalStyle('.mobile-shell .mobile-shell-shared-header:not([data-active-view="settings"]) .theme-control', {
  flex: '0 0 auto',
  gap: '3px',
  fontSize: '9px',
  whiteSpace: 'nowrap',
});
globalStyle('.mobile-shell .mobile-shell-content', { vars: { '--background': 'var(--mobile-stage)', '--padding-bottom': '0' } });
globalStyle('.mobile-shell-content::part(scroll)', { scrollbarGutter: 'auto' });
globalStyle('.mobile-shell .mobile-shell-workspace-view', { height: '100%', minHeight: '0', background: 'var(--mobile-stage)' });
globalStyle('.mobile-shell .st-workspace', { height: '100%', background: 'transparent' });
globalStyle('.mobile-shell .mobile-shell-workspace-view .pg-editor', {
  gap: '7px',
  padding: '8px 10px 12px',
  border: '0',
  borderRadius: '0',
  background: 'transparent',
  boxShadow: 'none',
});
globalStyle('.mobile-shell .mobile-shell-workspace-view .pg-editor-heading', { gap: '4px' });
globalStyle('.mobile-shell .mobile-shell-workspace-view .pg-editor-heading > div:first-child > .eyebrow', { display: 'none' });
globalStyle('.mobile-shell .mobile-shell-workspace-view .pg-editor-heading h2', { margin: '0', fontSize: '17px', lineHeight: '1.35' });
globalStyle('.mobile-shell .mobile-shell-workspace-view .pg-save-state', {
  display: 'flex',
  flexWrap: 'wrap',
  justifyItems: 'start',
  gap: '2px 10px',
  textAlign: 'left',
  fontSize: '10px',
  lineHeight: '1.35',
});
globalStyle('.mobile-shell .mobile-shell-workspace-view .pg-editor-actions', {
  display: 'flex',
  flexWrap: 'nowrap',
  gap: '6px',
  margin: '0',
  padding: '0 1px 4px',
  overflowX: 'auto',
  overscrollBehaviorX: 'contain',
  scrollbarWidth: 'thin',
});
globalStyle('.mobile-shell .mobile-shell-workspace-view .pg-editor-actions > *', { flex: '0 0 auto', whiteSpace: 'nowrap' });
globalStyle('.mobile-shell .mobile-shell-workspace-view .pg-editor-actions button', {
  minWidth: '44px',
  minHeight: '44px',
  padding: '7px 11px',
  fontSize: '12px',
  lineHeight: '1.3',
});
globalStyle('.mobile-shell .mobile-shell-workspace-view .pg-editor-actions[aria-label="原稿の表示と書式"] > label', {
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'center',
  gap: '2px',
  fontSize: '10px',
  lineHeight: '1.15',
});
globalStyle('.mobile-shell .mobile-shell-workspace-view .pg-editor-actions[aria-label="原稿の表示と書式"] select', {
  width: '128px',
  minHeight: '44px',
  padding: '5px 7px',
  fontSize: '12px',
});
globalStyle('.mobile-shell .mobile-shell-workspace-view .pg-editor-actions[aria-label="原稿の表示と書式"] input', {
  width: '82px',
  minHeight: '44px',
  padding: '5px 7px',
  fontSize: '14px',
});
globalStyle('.mobile-shell .mobile-shell-workspace-view .pg-editor-hint', { margin: '0', fontSize: '10px', lineHeight: '1.45' });
globalStyle('.mobile-shell .st-workspace-toolbar', {
  padding: '5px 12px',
  background: 'var(--mobile-paper)',
  borderBottom: '1px solid var(--mobile-line)',
  gap: '7px',
  flexWrap: 'nowrap',
  overflow: 'auto',
  scrollbarWidth: 'none',
});
globalStyle('.mobile-shell .st-workspace-toolbar::-webkit-scrollbar', { display: 'none' });
globalStyle('.mobile-shell .st-workspace-presets', { flexWrap: 'nowrap', gap: '4px' });
globalStyle('.mobile-shell .st-workspace-presets button', {
  border: '0',
  borderRadius: '5px',
  padding: '5px 9px',
  minHeight: '32px',
  color: 'var(--mobile-muted)',
  fontSize: '11px',
  background: 'transparent',
});
globalStyle('.mobile-shell .st-workspace-presets button[aria-pressed="true"]', { background: '#e7ede1', color: 'var(--mobile-accent)' });
globalStyle('.mobile-shell .st-workspace-panel-menu summary', {
  minHeight: '32px',
  background: 'transparent',
  border: '0',
  color: 'var(--mobile-muted)',
  fontSize: '11px',
});
globalStyle('.mobile-shell .st-workspace-save', {
  minHeight: '32px',
  padding: '5px 10px',
  background: 'var(--mobile-accent)',
  color: 'var(--button-foreground)',
  fontSize: '11px',
});
globalStyle('.mobile-shell .st-workspace-move-controls', { display: 'none' });
globalStyle('.mobile-shell .st-workspace-storage-state,.mobile-shell .st-workspace-message', { fontSize: '10px', padding: '4px 14px' });
globalStyle('.mobile-shell .st-workspace-mobile-tabs', {
  flexWrap: 'wrap',
  gap: '5px',
  padding: '8px 12px',
  overflow: 'visible',
  scrollbarWidth: 'none',
  background: 'var(--mobile-stage)',
});
globalStyle('.mobile-shell .st-workspace-mobile-tabs button', {
  minHeight: '32px',
  flex: '0 0 auto',
  padding: '5px 10px',
  border: '1px solid var(--mobile-line)',
  borderRadius: '999px',
  background: 'var(--mobile-paper)',
  color: 'var(--mobile-muted)',
  fontSize: '11px',
  fontWeight: '500',
});
globalStyle('.mobile-shell .st-workspace-mobile-tabs button[aria-selected="true"]', {
  background: 'var(--mobile-accent)',
  borderColor: 'var(--mobile-accent)',
  color: 'var(--button-foreground)',
});
globalStyle('.mobile-shell .st-workspace-mobile-pane', { background: 'var(--mobile-stage)', overflow: 'auto' });
globalStyle('.mobile-shell .st-workspace-panel', { border: '0', background: 'transparent', overflow: 'visible' });
globalStyle('.mobile-shell .st-workspace-panel-heading', { display: 'none' });
globalStyle('.mobile-shell .st-workspace-panel-body', { background: 'transparent', overflow: 'visible' });
globalStyle('.mobile-shell .st-workspace-panel-body :is(.sidebar,.writing-area)', {
  padding: '12px 16px 26px',
  border: '0',
  background: 'transparent',
});
globalStyle('.mobile-shell .st-workspace-panel-body .sidebar', {
  background: 'var(--mobile-paper)',
  border: '1px solid var(--mobile-line)',
  borderRadius: '12px',
});
globalStyle('.mobile-shell .st-workspace-panel-body .editor', { maxWidth: '900px', margin: '0 auto' });
globalStyle('.mobile-shell .mobile-shell-workspace-view .st-workspace-mobile-tabs', {
  display: 'flex',
  flexWrap: 'nowrap',
  gap: '5px',
  padding: '5px 10px',
  overflowX: 'auto',
  overscrollBehaviorX: 'contain',
  scrollbarWidth: 'thin',
  background: 'var(--mobile-stage)',
});
globalStyle('.mobile-shell .editor-header', {
  alignItems: 'flex-start',
  gap: '12px',
  flexDirection: 'column',
  padding: '16px 5px 14px',
  borderBottom: '1px solid var(--mobile-line)',
});
globalStyle('.mobile-shell .editor-header h1', {
  fontFamily: 'var(--manuscript-serif)',
  fontWeight: '600',
  fontSize: 'clamp(26px,5vw,36px)',
  color: 'var(--mobile-ink)',
  lineHeight: '1.35',
  letterSpacing: '-.025em',
});
globalStyle('.mobile-shell .editor-header .eyebrow', { fontSize: '10px', letterSpacing: '.12em', color: 'var(--mobile-muted)' });
globalStyle('.mobile-shell .editor-actions', { gap: '5px', width: '100%', justifyContent: 'flex-start', flexWrap: 'wrap' });
globalStyle('.mobile-shell .editor-actions button', {
  minHeight: '37px !important',
  padding: '7px 11px',
  fontSize: '12px',
  borderRadius: '6px',
});
globalStyle('.mobile-shell .durability-row', { gap: '5px', flexWrap: 'wrap' });
globalStyle('.mobile-shell .durability-badge', { borderRadius: '6px', fontSize: '10px', padding: '4px 6px' });
globalStyle('.mobile-shell .durability-badge.is-current', { background: '#e5ede0', color: '#285c43' });
globalStyle('.mobile-shell .durability-message', { fontSize: '11px', lineHeight: '1.65', margin: '9px 4px' });
globalStyle('.mobile-shell .typography-toolbar', {
  border: '0',
  borderBottom: '1px solid var(--mobile-line)',
  borderRadius: '0',
  padding: '8px 4px',
  background: 'transparent',
});
globalStyle('.mobile-shell .editor-columns', { display: 'flex', flexDirection: 'column', gap: '18px', marginTop: '8px' });
globalStyle('.mobile-shell .manuscript-column', {
  border: '0',
  borderRadius: '0',
  padding: 'clamp(14px,4vw,32px) clamp(14px,4vw,28px)',
  background: 'var(--mobile-paper)',
  boxShadow: '0 8px 35px #2e47320b',
});
globalStyle('.mobile-shell .manuscript-column > label', { fontSize: '10px', letterSpacing: '.1em', color: 'var(--mobile-muted)' });
globalStyle('.mobile-shell .manuscript-input', { border: '0', background: 'transparent', borderRadius: '0' });
globalStyle('.mobile-shell .cm-editor', { background: 'transparent', fontFamily: 'var(--editor-font-family,var(--manuscript-serif))' });
globalStyle('.mobile-shell .cm-scroller', {
  fontFamily: 'var(--editor-font-family,var(--manuscript-serif))',
  fontSize: 'var(--editor-font-size,16px)',
  lineHeight: 'var(--editor-line-height,1.8)',
  letterSpacing: 'var(--editor-letter-spacing,normal)',
});
globalStyle('.mobile-shell .cm-content', { padding: '16px 1px', minHeight: '36vh', lineHeight: 'var(--editor-line-height,1.8)' });
globalStyle('.mobile-shell .preview-column', {
  border: '1px solid var(--mobile-line)',
  background: 'var(--mobile-paper)',
  borderRadius: '9px',
});
globalStyle('.mobile-shell .reading-view', { background: 'var(--mobile-paper)', border: '0', borderRadius: '7px' });
globalStyle('.mobile-shell .mobile-shell-footer', {
  boxShadow: '0 -4px 15px #1e3d240b',
  borderColor: 'var(--mobile-line)',
  background: 'var(--mobile-paper)',
});
globalStyle('.mobile-shell .mobile-shell-navigation', {
  maxWidth: 'none',
  minHeight: '58px',
  display: 'grid',
  gridTemplateColumns: 'repeat(5,minmax(0,1fr))',
  gap: '0',
  padding: '3px max(10px,env(safe-area-inset-right,0px)) 1px max(10px,env(safe-area-inset-left,0px))',
});
globalStyle('.mobile-shell .mobile-shell-navigation ion-button', {
  margin: '0',
  minWidth: '0',
  minHeight: '53px',
  vars: {
    '--border-radius': '8px',
    '--color': 'var(--mobile-muted)',
    '--color-activated': 'var(--mobile-accent)',
    '--background': 'transparent',
    '--box-shadow': 'none',
  },
});
globalStyle('.mobile-shell .mobile-shell-navigation ion-button[aria-current="page"]', {
  vars: { '--color': 'var(--mobile-accent)', '--background': '#e8eee4' },
});
globalStyle('.mobile-shell .mobile-shell-nav-content', {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '1px',
  fontSize: '10px',
  lineHeight: '1.45',
});
globalStyle('.mobile-shell .mobile-shell-nav-mark', { fontSize: '20px', lineHeight: '1.1' });
globalStyle('.mobile-shell .mobile-shell-status', { bottom: 'calc(4rem + env(safe-area-inset-bottom,0px))' });
globalStyle('.mobile-shell .mobile-shell-status:empty', { display: 'none !important' });
globalStyle('.mobile-shell .mobile-shell-view', { padding: '18px 16px 28px' });
globalStyle('.mobile-shell .mobile-shell-page-title', { font: '600 24px/1.5 var(--manuscript-serif)', marginBottom: '16px' });
globalStyle(':root[data-zp-theme="dark"] .mobile-shell', {
  vars: {
    '--mobile-ink': '#e3ebdf',
    '--mobile-paper': '#18271f',
    '--mobile-stage': '#111a16',
    '--mobile-line': '#34463a',
    '--surface-hover': '#263a2e',
    '--surface-selected': '#34513c',
  },
});
globalStyle(':root[data-zp-theme="dark"] .mobile-shell .mobile-shell-page-mark', { background: '#26392b', color: '#b1dbc0' });
globalStyle(
  ':root[data-zp-theme="dark"] .mobile-shell .st-workspace-mobile-tabs button[aria-selected="true"],\n:root[data-zp-theme="dark"] .mobile-shell .st-workspace-save',
  { color: 'var(--button-foreground)' },
);
globalStyle(':root[data-zp-theme="paper"] .mobile-shell', {
  vars: { '--mobile-ink': '#38352a', '--mobile-paper': '#f7f0e2', '--mobile-stage': '#e9e0d0', '--mobile-line': '#d4c8b4' },
});
globalStyle('.mobile-shell :is(button,ion-button,a,[role="tab"],select,input):focus-visible', {
  outline: '3px solid var(--focus-ring)',
  outlineOffset: '2px',
});
globalStyle('.mobile-shell .mobile-shell-identity-bar,.mobile-shell .mobile-shell-shared-header', {
  '@media': { '(min-width:800px)': { paddingLeft: 'clamp(25px,9vw,160px)', paddingRight: 'clamp(25px,9vw,160px)' } },
});
globalStyle('.mobile-shell .mobile-shell-workspace-view,.mobile-shell .mobile-shell-view-stack', {
  '@media': { '(min-width:800px)': { maxWidth: '950px', margin: '0 auto' } },
});
globalStyle('.mobile-shell .mobile-shell-navigation', { '@media': { '(min-width:800px)': { maxWidth: '950px', margin: '0 auto' } } });
globalStyle('.mobile-shell .st-workspace-mobile-tabs', { '@media': { '(max-width:390px)': { padding: '6px 9px' } } });
globalStyle('.mobile-shell .st-workspace-mobile-tabs button', {
  '@media': { '(max-width:390px)': { padding: '4px 7px', fontSize: '10px' } },
});
globalStyle('.mobile-shell *,.mobile-shell *::before,.mobile-shell *::after', {
  '@media': {
    '(prefers-reduced-motion:reduce)': {
      transitionDuration: '.01ms !important',
      animationDuration: '.01ms !important',
      scrollBehavior: 'auto !important' as unknown as CSSProperties['scrollBehavior'],
    },
  },
});
globalStyle('.mobile-shell .st-workspace-configuration > summary', {
  minHeight: '30px',
  padding: '5px 10px',
  color: 'var(--mobile-muted)',
  fontSize: '10px',
  lineHeight: '1.3',
});
globalStyle('.mobile-shell .st-workspace-storage-state,.mobile-shell .st-workspace-message', {
  margin: '0',
  padding: '3px 10px',
  fontSize: '9px',
  lineHeight: '1.35',
});
globalStyle(
  '.mobile-shell .mobile-shell-workspace-view .st-workspace-configuration:not([open]) ~ .st-workspace-message,\n.mobile-shell .mobile-shell-workspace-view .st-workspace-configuration:not([open]) ~ .st-workspace-storage-state',
  { display: 'none !important' },
);
globalStyle('.mobile-shell .mobile-shell-workspace-view:not([data-active-view="settings"]) .st-workspace-move-menu', { display: 'none' });
globalStyle('.mobile-shell .mobile-shell-workspace-view[data-active-view="settings"] .st-workspace-move-menu', { display: 'block' });
globalStyle('.mobile-shell .mobile-shell-workspace-view[data-active-view="settings"] .st-workspace-move-controls', {
  display: 'grid',
  gridTemplateColumns: 'minmax(0,1fr)',
  gap: '8px',
  padding: '8px 12px',
});
globalStyle('.mobile-shell-writing-accessories', {
  display: 'grid',
  gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)',
  gap: '8px',
  padding: '8px max(12px,env(safe-area-inset-right,0px)) 7px max(12px,env(safe-area-inset-left,0px))',
  borderBottom: '1px solid var(--mobile-line)',
  background: 'var(--mobile-paper)',
});
globalStyle('.mobile-shell-accessories-label', {
  position: 'absolute',
  width: '1px',
  height: '1px',
  overflow: 'hidden',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
});
globalStyle('.mobile-shell .mobile-shell-accessory-button', {
  minWidth: '0',
  minHeight: '44px',
  padding: '8px 10px',
  border: '1px solid var(--mobile-line)',
  borderRadius: '11px',
  background: 'var(--mobile-stage)',
  color: 'var(--mobile-accent)',
  fontSize: '12px',
  fontWeight: '650',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '7px',
});
globalStyle('.mobile-shell .mobile-shell-accessory-button > span', { fontSize: '18px', lineHeight: '1' });
globalStyle('.mobile-shell .mobile-shell-accessory-button:disabled', { opacity: '.6' });
globalStyle('.mobile-shell .mobile-shell-accessory-button:focus-visible', { outline: '3px solid var(--focus-ring)', outlineOffset: '2px' });
globalStyle('.mobile-shell-interaction-error', {
  position: 'fixed',
  zIndex: '35',
  left: 'max(12px,env(safe-area-inset-left,0px))',
  right: 'max(12px,env(safe-area-inset-right,0px))',
  bottom: 'calc(8.5rem + env(safe-area-inset-bottom,0px))',
  margin: '0',
  padding: '12px',
  border: '1px solid var(--error-border)',
  borderRadius: '10px',
  background: 'var(--error-bg)',
  color: 'var(--error-text)',
  maxHeight: '26vh',
  overflow: 'auto',
  boxShadow: '0 6px 22px rgb(0 0 0 / 14%)',
  fontSize: '12px',
  lineHeight: '1.6',
});
globalStyle('.mobile-shell:has(.mobile-shell-writing-accessories) .mobile-shell-status', {
  bottom: 'calc(7.5rem + env(safe-area-inset-bottom,0px))',
});
globalStyle(
  '.mobile-shell.mobile-shell-keyboard-open .mobile-shell-shared-header,\n.mobile-shell.mobile-shell-keyboard-open .mobile-shell-settings-entry',
  { display: 'none !important' },
);
globalStyle('.mobile-shell.mobile-shell-keyboard-open .mobile-shell-footer', { display: 'block !important' });
globalStyle('.mobile-shell.mobile-shell-keyboard-open .mobile-shell-navigation', { display: 'none !important' });
globalStyle(
  '.mobile-shell.mobile-shell-keyboard-open .mobile-shell-workspace-view .st-workspace-configuration,\n.mobile-shell.mobile-shell-keyboard-open .mobile-shell-workspace-view .st-workspace-mobile-tabs,\n.mobile-shell.mobile-shell-keyboard-open .mobile-shell-workspace-view .st-workspace-message,\n.mobile-shell.mobile-shell-keyboard-open .mobile-shell-workspace-view .st-workspace-storage-state',
  { display: 'none !important' },
);
globalStyle('.mobile-shell.mobile-shell-keyboard-open .mobile-shell-writing-accessories', {
  paddingTop: '4px',
  paddingBottom: '4px',
  borderTop: '1px solid var(--mobile-line)',
  borderBottom: '0',
});
globalStyle('.mobile-shell.mobile-shell-keyboard-open .mobile-shell-identity-bar', {
  minHeight: '50px',
  paddingTop: '3px',
  paddingBottom: '3px',
});
globalStyle('.mobile-shell.mobile-shell-keyboard-open .mobile-shell-context', { display: 'none' });
globalStyle('.mobile-shell.mobile-shell-keyboard-open .mobile-shell-status', {
  bottom: 'calc(4rem + env(safe-area-inset-bottom,0px))',
  maxHeight: '18vh',
});
globalStyle('.mobile-shell.mobile-shell-keyboard-open .mobile-shell-interaction-error', {
  bottom: 'max(10px,env(safe-area-inset-bottom,0px))',
});
globalStyle('.mobile-shell.mobile-shell-keyboard-open .mobile-shell-content::part(scroll)', { scrollPaddingBottom: '16px' });
globalStyle('ion-modal.mobile-shell-reference-modal', {
  vars: {
    '--height': '100%',
    '--width': 'min(100%,760px)',
    '--border-radius': '22px 22px 0 0',
    '--box-shadow': '0 -14px 48px rgb(22 48 31 / 20%)',
    '--mobile-sheet-paper': '#fcfbf5',
    '--mobile-sheet-stage': '#f2f2e8',
    '--mobile-sheet-ink': '#273c32',
    '--mobile-sheet-muted': 'var(--muted)',
    '--mobile-sheet-border': '#dce5d8',
    '--mobile-sheet-accent': 'var(--accent)',
    '--background': 'var(--mobile-sheet-paper)',
  },
});
globalStyle(':root[data-zp-theme="dark"] ion-modal.mobile-shell-reference-modal', {
  vars: {
    '--mobile-sheet-paper': '#18271f',
    '--mobile-sheet-stage': '#111a16',
    '--mobile-sheet-ink': '#e3ebdf',
    '--mobile-sheet-border': '#34463a',
  },
});
globalStyle(':root[data-zp-theme="paper"] ion-modal.mobile-shell-reference-modal', {
  vars: {
    '--mobile-sheet-paper': '#f7f0e2',
    '--mobile-sheet-stage': '#e9e0d0',
    '--mobile-sheet-ink': '#38352a',
    '--mobile-sheet-border': '#d4c8b4',
  },
});
globalStyle('.mobile-shell-reference-content', {
  color: 'var(--mobile-sheet-ink)',
  vars: { '--background': 'var(--mobile-sheet-paper)', '--padding-bottom': 'env(safe-area-inset-bottom,0px)' },
});
globalStyle('.mobile-shell-reference-top', {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '16px',
  padding: '14px 20px 9px',
  borderBottom: '1px solid var(--mobile-sheet-border)',
});
globalStyle('.mobile-shell-reference-eyebrow', {
  margin: '0 0 4px',
  color: 'var(--mobile-sheet-muted)',
  font: '600 10px ui-monospace,monospace',
  letterSpacing: '1.3px',
});
globalStyle('.mobile-shell-reference-top h2', {
  margin: '0',
  font: '600 23px/1.45 "Yu Mincho","Hiragino Mincho ProN",serif',
  color: 'var(--mobile-sheet-ink)',
});
globalStyle('.mobile-shell-reference-close', {
  flex: '0 0 auto',
  minHeight: '44px',
  border: '1px solid var(--mobile-sheet-border)',
  borderRadius: '10px',
  padding: '9px 15px',
  background: 'var(--mobile-sheet-stage)',
  color: 'var(--mobile-sheet-accent)',
  fontSize: '12px',
  fontWeight: '650',
});
globalStyle('.mobile-shell-reference-switch', { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px', padding: '11px 20px 6px' });
globalStyle('.mobile-shell-reference-switch button', {
  minHeight: '44px',
  border: '1px solid var(--mobile-sheet-border)',
  borderRadius: '10px',
  padding: '9px',
  background: 'transparent',
  color: 'var(--mobile-sheet-muted)',
  fontSize: '13px',
});
globalStyle('.mobile-shell-reference-switch button[aria-selected="true"]', {
  background: 'var(--mobile-sheet-accent)',
  borderColor: 'var(--mobile-sheet-accent)',
  color: 'var(--button-foreground)',
  fontWeight: '700',
});
globalStyle('.mobile-shell-reference-pane', {
  padding: '10px 20px 22px',
  minHeight: '0',
  color: 'var(--mobile-sheet-ink)',
  font: 'inherit',
  overflowWrap: 'anywhere',
});
globalStyle('.mobile-shell-reference-pane .sidebar', {
  width: '100%',
  minWidth: '0',
  maxWidth: 'none',
  padding: '0',
  border: '0',
  background: 'transparent',
});
globalStyle('.mobile-shell-reference-pane :is(button,input,select,textarea)', { maxWidth: '100%' });
globalStyle('.mobile-shell-reference-pane :is(.scene-button,.project-button)', {
  minHeight: '44px',
  whiteSpace: 'normal',
  overflowWrap: 'anywhere',
});
globalStyle('.mobile-shell-reference-pane :is(.scene-button,.project-button)[aria-current="true"]', {
  background: 'var(--mobile-sheet-stage)',
  color: 'var(--mobile-sheet-accent)',
});
globalStyle('.mobile-shell-reference-pane :is(h2,h3)', { color: 'var(--mobile-sheet-ink)' });
globalStyle('.mobile-shell-reference-pane .pg-outline-document.is-selected', { borderColor: 'var(--surface-selected-border)' });
globalStyle('.mobile-shell-reference-pane .project-facts', { fontSize: '13px', lineHeight: '1.6' });
globalStyle('.mobile-shell-reference-pane pre', { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' });
globalStyle('.mobile-shell-reference-hint', {
  padding: '6px 20px 25px',
  margin: '0',
  color: 'var(--mobile-sheet-muted)',
  fontSize: '11px',
  lineHeight: '1.6',
});
globalStyle('.mobile-shell-reference-modal :is(button,input,select,[tabindex]):focus-visible', {
  outline: '3px solid var(--mobile-sheet-accent)',
  outlineOffset: '2px',
});
globalStyle('.mobile-shell-reference-modal *', {
  '@media': {
    '(prefers-reduced-motion:reduce)': {
      animationDuration: '.01ms !important',
      transitionDuration: '.01ms !important',
      scrollBehavior: 'auto !important' as unknown as CSSProperties['scrollBehavior'],
    },
  },
});
globalStyle('.mobile-shell-reference-durability', {
  display: 'flex',
  flexDirection: 'column',
  gap: '5px',
  marginBottom: '15px',
  padding: '13px 14px',
  borderRadius: '11px',
  border: '1px solid var(--mobile-sheet-border)',
  background: 'var(--mobile-sheet-stage)',
  color: 'var(--mobile-sheet-ink)',
});
globalStyle('.mobile-shell-reference-durability strong', { fontSize: '13px', color: 'var(--mobile-sheet-accent)' });
globalStyle('.mobile-shell-reference-durability[data-state="uncertain"] strong', { color: 'var(--error-text)' });
globalStyle('.mobile-shell-reference-durability span', { fontSize: '12px', lineHeight: '1.6' });
