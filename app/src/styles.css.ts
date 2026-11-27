import './theme.css';
import './shell-theme.css';
import type { CSSProperties } from '@vanilla-extract/css';
import { scopedGlobalStyle as globalStyle } from './styles/scoped-global-style.css';

globalStyle(':root', {
  fontFamily: 'var(--manuscript-sans)',
  lineHeight: '1.5',
  color: 'var(--ink)',
  background: 'var(--page-bg)',
  fontSynthesis: 'none',
  textRendering: 'optimizeLegibility',
});
globalStyle('*', { boxSizing: 'border-box' });
globalStyle('html, body, #root', { minWidth: '320px', minHeight: '100%', margin: '0' });
globalStyle('#root', { display: 'flow-root' });
globalStyle('body', { minHeight: '100vh', color: 'var(--ink)', background: 'var(--page-bg)' });
globalStyle('button, input, textarea', { font: 'inherit' });
globalStyle('button', {
  minHeight: '2.75rem',
  padding: '0.55rem 0.9rem',
  border: '1px solid var(--input-border)',
  borderRadius: '0.4rem',
  color: 'var(--button-foreground)',
  background: 'var(--accent)',
  cursor: 'pointer',
});
globalStyle('button:hover:not(:disabled)', { background: 'var(--accent-strong)' });
globalStyle('button:disabled', { opacity: '0.55', cursor: 'not-allowed' });
globalStyle(
  'button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible, summary:focus-visible, a:focus-visible',
  { outline: '3px solid var(--focus-ring)', outlineOffset: '2px' },
);
globalStyle('input, textarea', {
  minWidth: '0',
  border: '1px solid var(--input-border)',
  borderRadius: '0.35rem',
  color: 'var(--ink)',
  background: 'var(--paper)',
});
globalStyle('input:not([type="radio"]):not([type="checkbox"])', { width: '100%', minHeight: '2.75rem', padding: '0.55rem 0.7rem' });
globalStyle('input:is([type="radio"], [type="checkbox"])', {
  width: '1.1rem',
  minWidth: '1.1rem',
  height: '1.1rem',
  minHeight: '1.1rem',
  padding: '0',
  flex: '0 0 auto',
  accentColor: 'var(--accent-strong)',
});
globalStyle('textarea', { padding: '0.9rem' });
globalStyle('select', {
  minWidth: '0',
  minHeight: '2.75rem',
  padding: '0.45rem 0.65rem',
  border: '1px solid var(--input-border)',
  borderRadius: '0.35rem',
  color: 'var(--ink)',
  background: 'var(--paper)',
  font: 'inherit',
});
globalStyle('.quiet-button', { borderColor: 'var(--input-border)', color: 'var(--accent-strong)', background: 'transparent' });
globalStyle('.quiet-button:hover:not(:disabled)', { color: 'var(--button-foreground)' });
globalStyle('.loading', { margin: '3rem auto', color: 'var(--muted)', textAlign: 'center' });
globalStyle('.eyebrow', { margin: '0', color: 'var(--muted)', fontSize: '0.84rem', overflowWrap: 'anywhere' });
globalStyle('.status', { minHeight: '1.5rem', margin: '0.25rem 0', color: 'var(--muted)', lineHeight: '1.5' });
globalStyle('.status[data-kind="error"]', { color: 'var(--error)' });
globalStyle('.status[data-kind="success"]', { color: 'var(--success)' });
globalStyle('.login-panel', {
  width: 'min(29rem, calc(100% - 2rem))',
  margin: '12vh auto',
  padding: '2rem',
  border: '1px solid var(--line)',
  borderRadius: '0.8rem',
  background: 'var(--paper)',
  boxShadow: '0 1rem 3rem var(--focus-shadow)',
});
globalStyle('.login-panel h1', { margin: '0.35rem 0', fontSize: '2rem' });
globalStyle('.login-panel form, .project-form', { display: 'grid', gap: '0.7rem' });
globalStyle('.login-panel form', { marginTop: '1.5rem' });
globalStyle('.public-module-shell', { minHeight: '100vh', color: 'var(--ink)', background: 'var(--paper)' });
globalStyle('.public-module-header', {
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '1rem',
  padding: '0.8rem 1rem',
  borderBottom: '1px solid var(--line)',
  color: 'var(--muted)',
  fontSize: '0.85rem',
});
globalStyle('.public-module-header > span:first-child', { color: 'var(--accent-strong)', fontWeight: '750' });
globalStyle('.public-module-status', {
  width: 'min(52rem, calc(100% - 2rem))',
  margin: '2rem auto',
  color: 'var(--muted)',
  textAlign: 'center',
});
globalStyle('.public-module-status[data-kind="error"]', { color: 'var(--error)' });
globalStyle('.workspace', { minHeight: '100vh' });
globalStyle('.topbar', {
  position: 'sticky',
  zIndex: '3',
  top: '0',
  display: 'flex',
  alignItems: 'center',
  gap: '1rem',
  minHeight: '3.8rem',
  padding: '0.5rem 1rem',
  borderBottom: '1px solid var(--line)',
  background: 'var(--paper)',
});
globalStyle('.brand', { color: 'var(--accent-strong)', fontSize: '1.2rem', fontWeight: '750', textDecoration: 'none' });
globalStyle('.theme-control', {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.4rem',
  color: 'var(--muted)',
  fontSize: '0.8rem',
  whiteSpace: 'nowrap',
});
globalStyle('.theme-control select', {
  maxInlineSize: '100%',
  minHeight: '2.75rem',
  padding: '0.35rem 0.5rem',
  borderColor: 'var(--input-border)',
  borderRadius: '0.35rem',
  color: 'var(--ink)',
  background: 'var(--paper)',
});
globalStyle('.theme-error', {
  position: 'absolute',
  top: '100%',
  right: '1rem',
  zIndex: '4',
  padding: '0.35rem 0.55rem',
  border: '1px solid var(--error-border)',
  borderRadius: '0.35rem',
  color: 'var(--error-text)',
  background: 'var(--error-bg)',
  fontSize: '0.75rem',
});
globalStyle('.topbar-status', {
  flex: '1',
  minWidth: '0',
  overflow: 'hidden',
  color: 'var(--muted)',
  fontSize: '0.87rem',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});
globalStyle('.topbar-status[data-kind="error"]', { color: 'var(--error)' });
globalStyle('.topbar-status[data-kind="success"]', { color: 'var(--success)' });
globalStyle('.workspace-grid', {
  display: 'grid',
  gridTemplateColumns: 'minmax(15rem, 19rem) minmax(0, 1fr)',
  minHeight: 'calc(100vh - 3.8rem)',
});
globalStyle('.sidebar', { minWidth: '0', padding: '1rem', borderRight: '1px solid var(--line)', background: 'var(--sidebar-bg)' });
globalStyle('.sidebar h2, .tree h2, .recovery-panel h2', { margin: '0 0 0.8rem', fontSize: '1rem' });
globalStyle('.project-form', { paddingBottom: '1.1rem', borderBottom: '1px solid var(--line)' });
globalStyle('.project-form label, .manuscript-column label', { fontSize: '0.88rem', fontWeight: '650' });
globalStyle('.project-list-section', { padding: '1rem 0', borderBottom: '1px solid var(--line)' });
globalStyle('.project-management', { display: 'grid', gap: '0.65rem', padding: '1rem 0', borderBottom: '1px solid var(--line)' });
globalStyle('.project-management h2', { margin: '0', fontSize: '1rem' });
globalStyle('.project-facts', { display: 'grid', gap: '0.5rem', margin: '0' });
globalStyle('.project-facts div', { minWidth: '0' });
globalStyle('.project-facts dt', { color: 'var(--muted)', fontSize: '0.75rem' });
globalStyle('.project-facts dd', { margin: '0.1rem 0 0', fontSize: '0.82rem', overflowWrap: 'anywhere' });
globalStyle('.project-facts code', { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.78rem' });
globalStyle('.project-management-help', { margin: '0', color: 'var(--muted)', fontSize: '0.78rem', lineHeight: '1.5' });
globalStyle('.project-management-actions', { display: 'grid', gap: '0.4rem' });
globalStyle('.continue-panel', { display: 'grid', gap: '0.55rem', padding: '1rem 0', borderBottom: '1px solid var(--line)' });
globalStyle('.continue-panel h2', { margin: '0', fontSize: '1rem' });
globalStyle('.continue-list', { display: 'grid', gap: '0.75rem', margin: '0', padding: '0', listStyle: 'none' });
globalStyle('.continue-list li', { display: 'grid', gap: '0.3rem', minWidth: '0' });
globalStyle('.continue-list strong', { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
globalStyle('.continue-list small, .continue-error', { margin: '0', color: 'var(--muted)', fontSize: '0.78rem', lineHeight: '1.45' });
globalStyle('.continue-list button', { justifySelf: 'start' });
globalStyle('.continue-error', { color: 'var(--error)' });
globalStyle('.danger-button', { borderColor: 'var(--danger-border)', color: 'var(--danger-foreground)', background: 'var(--danger-bg)' });
globalStyle('.danger-button:hover:not(:disabled)', { background: 'var(--danger-hover)' });
globalStyle('.plain-list, .scene-list, .proposal-list, .recovery-list', { padding: '0', margin: '0', listStyle: 'none' });
globalStyle('.plain-list li + li, .scene-list li + li', { marginTop: '0.18rem' });
globalStyle('.project-button, .scene-button', {
  display: 'block',
  width: '100%',
  minHeight: '2.6rem',
  padding: '0.45rem 0.55rem',
  overflow: 'hidden',
  borderColor: 'transparent',
  color: 'var(--ink)',
  background: 'transparent',
  textAlign: 'left',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});
globalStyle('.project-button[aria-current="true"], .scene-button[aria-current="true"]', {
  borderColor: 'var(--surface-selected-border)',
  color: 'var(--accent-strong)',
  background: 'var(--surface-selected)',
  fontWeight: '700',
});
globalStyle('.project-button:hover:not(:disabled), .scene-button:hover:not(:disabled)', {
  color: 'var(--accent-strong)',
  background: 'var(--surface-hover)',
});
globalStyle('.muted-list-item', { padding: '0.5rem', color: 'var(--muted)', fontSize: '0.86rem' });
globalStyle('.tree', { paddingTop: '1rem' });
globalStyle('.tree-volume', { margin: '0.9rem 0' });
globalStyle('.tree-volume h3', { margin: '0.5rem 0', fontSize: '0.95rem' });
globalStyle('.tree details', { margin: '0.45rem 0' });
globalStyle('.tree summary', { minHeight: '2rem', padding: '0.35rem 0', cursor: 'pointer', fontSize: '0.9rem', fontWeight: '650' });
globalStyle('.scene-list', { paddingLeft: '0.4rem' });
globalStyle('.scene-button', { paddingLeft: '0.65rem', fontSize: '0.86rem' });
globalStyle('.writing-area', { minWidth: '0', padding: '1.25rem clamp(1rem, 3vw, 2.5rem) 3rem' });
globalStyle('.empty-state', { maxWidth: '42rem', margin: '15vh auto', color: 'var(--muted)', textAlign: 'center' });
globalStyle('.empty-state h1', { color: 'var(--ink)' });
globalStyle('.recovery-panel', { marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid var(--line)' });
globalStyle('.recovery-panel p', { color: 'var(--muted)', fontSize: '0.85rem', lineHeight: '1.5' });
globalStyle('.recovery-list', { display: 'grid', gap: '0.55rem' });
globalStyle('.recovery-list li', {
  display: 'grid',
  gap: '0.15rem',
  padding: '0.6rem',
  border: '1px solid var(--line)',
  borderRadius: '0.45rem',
  background: 'var(--paper)',
  overflowWrap: 'anywhere',
});
globalStyle('.recovery-list span, .recovery-list small', { color: 'var(--muted)', fontSize: '0.76rem' });
globalStyle('.editor', { maxWidth: '100rem', margin: '0 auto' });
globalStyle('.editor-header', {
  display: 'flex',
  alignItems: 'flex-end',
  justifyContent: 'space-between',
  gap: '1rem',
  paddingBottom: '0.8rem',
  borderBottom: '1px solid var(--line)',
});
globalStyle('.scene-heading', { minWidth: '0' });
globalStyle('.editor-header h1', { margin: '0.2rem 0 0', fontSize: 'clamp(1.35rem, 2vw, 1.8rem)' });
globalStyle('.editor-actions', { display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: '0.4rem' });
globalStyle('.durability-row', { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.35rem', marginTop: '0.55rem' });
globalStyle('.durability-badge', {
  padding: '0.22rem 0.48rem',
  border: '1px solid var(--line)',
  borderRadius: '999px',
  color: 'var(--muted)',
  background: 'var(--badge-bg)',
  fontSize: '0.74rem',
});
globalStyle('.durability-badge.is-current', {
  borderColor: 'var(--badge-selected-border)',
  color: 'var(--accent-strong)',
  background: 'var(--badge-selected-bg)',
  fontWeight: '700',
});
globalStyle('.pending-count', { marginLeft: '0.3rem', color: 'var(--muted)', fontSize: '0.78rem' });
globalStyle('.durability-message', { minHeight: '1.4rem', margin: '0.65rem 0', color: 'var(--muted)', fontSize: '0.84rem' });
globalStyle('.typography-toolbar', {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '0.4rem',
  margin: '0 0 0.8rem',
  padding: '0.5rem',
  border: '1px solid var(--line)',
  borderRadius: '0.55rem',
  background: 'var(--toolbar-bg)',
});
globalStyle('.toolbar-group', { display: 'inline-flex', alignItems: 'center', gap: '0.4rem' });
globalStyle('.toolbar-group output', { minWidth: '3rem', color: 'var(--muted)', textAlign: 'center', fontSize: '0.85rem' });
globalStyle('.editor-columns', {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1.2fr) minmax(18rem, 0.8fr)',
  gap: '1rem',
  minHeight: '55vh',
});
globalStyle('.manuscript-column, .preview-column', {
  minWidth: '0',
  padding: '1rem',
  border: '1px solid var(--line)',
  borderRadius: '0.55rem',
  background: 'var(--paper)',
});
globalStyle('.manuscript-column', { display: 'flex', flexDirection: 'column', gap: '0.6rem' });
globalStyle('.manuscript-input', {
  flex: '1',
  width: '100%',
  minHeight: '55vh',
  overflow: 'hidden',
  border: '1px solid var(--input-border)',
  borderRadius: '0.35rem',
  background: 'var(--paper)',
});
globalStyle('.cm-editor', {
  minHeight: '100%',
  color: 'var(--ink)',
  background: 'transparent',
  fontFamily: 'var(--editor-font-family, var(--manuscript-serif))',
  fontSize: 'var(--editor-font-size, 16px)',
});
globalStyle('.cm-editor.cm-focused', { outline: '3px solid var(--focus-ring)', outlineOffset: '2px' });
globalStyle('.cm-editor .cm-activeLine, .cm-editor .cm-activeLineGutter', { background: 'var(--surface-subtle)' });
globalStyle('.cm-scroller', {
  minHeight: '55vh',
  fontFamily: 'inherit',
  lineHeight: 'var(--editor-line-height, 1.8)',
  letterSpacing: 'var(--editor-letter-spacing, 0.02em)',
});
globalStyle('.cm-content', { minHeight: '55vh', padding: '0.9rem', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' });
globalStyle('.cm-line', { padding: '0' });
globalStyle('.cm-placeholder', { color: 'var(--placeholder)', fontStyle: 'italic' });
globalStyle('.editor-hint', { margin: '0', color: 'var(--muted)', fontSize: '0.8rem', lineHeight: '1.5' });
globalStyle('.preview-column h2, .history-panel h2, .proposal-review h2', { margin: '0 0 0.65rem', fontSize: '1rem' });
globalStyle('.manuscript-preview, .reading-view', {
  minHeight: '55vh',
  maxHeight: '75vh',
  overflow: 'auto',
  padding: '1rem',
  border: '1px solid var(--reader-border)',
  background: 'var(--paper)',
  fontFamily: 'var(--reader-font-family, var(--manuscript-serif))',
  fontSize: 'var(--reader-font-size, 1rem)',
  lineHeight: 'var(--reader-line-height, 1.8)',
  letterSpacing: 'var(--reader-letter-spacing, 0.02em)',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
});
globalStyle('.manuscript-preview.is-vertical, .reading-view.is-vertical', { writingMode: 'vertical-rl', textOrientation: 'mixed' });
globalStyle('.ruby-line', { minHeight: '1em', margin: '0 0 0.55em' });
globalStyle('ruby', { rubyPosition: 'over' });
globalStyle('rt', { color: 'var(--ruby-muted)', fontSize: '0.55em' });
globalStyle('.reading-view', { maxWidth: 'var(--reader-max-width, 70rem)', margin: '1rem auto', padding: 'clamp(1.2rem, 5vw, 3.5rem)' });
globalStyle('.manuscript-preview', {
  maxWidth: 'var(--reader-max-width, 70rem)',
  fontFamily: 'var(--reader-font-family, var(--manuscript-serif))',
});
globalStyle('.manuscript-preview.is-vertical', { maxHeight: 'var(--reader-max-width, 70rem)' });
globalStyle('.pg-editor > .scene-reading', { minWidth: '0' });
globalStyle('.reading-pager', { position: 'relative', width: '100%', minHeight: 'inherit' });
globalStyle('.reading-pager-content', { minHeight: 'inherit' });
globalStyle('.reading-pager-content.is-vertical', { writingMode: 'vertical-rl', textOrientation: 'mixed' });
globalStyle('.reading-page-count, .reading-page-control, .reading-tap-zone', { display: 'none' });
globalStyle('.reading-page-control', {
  minWidth: '2.75rem',
  minHeight: '2.75rem',
  padding: '0.3rem',
  border: '1px solid var(--input-border)',
  borderRadius: '999px',
  color: 'var(--accent-strong)',
  background: 'var(--paper)',
  fontSize: '1.5rem',
  lineHeight: '1',
  opacity: '0.82',
});
globalStyle('.manuscript-history header', { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem' });
globalStyle('.manuscript-history header h2', { margin: '0' });
globalStyle('.manuscript-history header p', { margin: '0.35rem 0 0.8rem', color: 'var(--muted)', fontSize: '0.82rem' });
globalStyle('.manuscript-history-layout', {
  display: 'grid',
  gridTemplateColumns: 'minmax(12rem, 0.35fr) minmax(0, 1fr)',
  gap: '0.8rem',
  maxHeight: '34rem',
});
globalStyle('.manuscript-history-layout > ol', { maxHeight: '34rem', overflow: 'auto', margin: '0', padding: '0', listStyle: 'none' });
globalStyle('.manuscript-history-layout > ol button', {
  display: 'grid',
  width: '100%',
  gap: '0.25rem',
  padding: '0.65rem',
  textAlign: 'left',
});
globalStyle('.manuscript-history-layout > ol button[aria-current="true"]', {
  borderColor: 'var(--accent)',
  background: 'var(--badge-selected-bg)',
});
globalStyle('.manuscript-history-layout > ol span', { color: 'var(--muted)', fontSize: '0.76rem' });
globalStyle('.manuscript-history-detail', { minWidth: '0', maxHeight: '34rem', overflow: 'auto' });
globalStyle('.history-detail-heading', {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  flexWrap: 'wrap',
  gap: '0.5rem',
});
globalStyle('.history-detail-heading p', { margin: '0.3rem 0', color: 'var(--muted)' });
globalStyle('.manuscript-history-detail pre', { maxHeight: '24rem', overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' });
globalStyle('.diff-line', { display: 'block' });
globalStyle('.diff-line.is-add', { background: 'var(--diff-add)' });
globalStyle('.diff-line.is-remove', { color: 'var(--diff-remove-text)', background: 'var(--diff-remove)', textDecoration: 'line-through' });
// React portals the print document directly to body so print styles must cross the #root boundary.
globalStyle(
  'body > .pg-print-document,\nbody > .pg-print-document::before,\nbody > .pg-print-document::after,\nbody > .pg-print-document *,\nbody > .pg-print-document *::before,\nbody > .pg-print-document *::after',
  { boxSizing: 'border-box' },
);
globalStyle('body > .pg-print-document.print-view', {
  maxWidth: 'var(--reader-max-width, 960px)',
  margin: '0 auto',
  fontFamily: 'var(--reader-font-family, var(--manuscript-serif))',
  fontSize: 'var(--reader-font-size, 12pt)',
  lineHeight: 'var(--reader-line-height, 1.8)',
  letterSpacing: 'var(--reader-letter-spacing, 0)',
});
globalStyle('body > .pg-print-document.print-view.is-vertical', { maxHeight: 'var(--reader-max-width, 960px)' });
globalStyle('body > .pg-print-document.print-view', { display: 'none' });
globalStyle('.conflict', {
  margin: '0.8rem 0 1rem',
  padding: '1rem',
  border: '1px solid var(--error-border)',
  borderRadius: '0.5rem',
  background: 'var(--error-bg)',
});
globalStyle('.conflict h2', { margin: '0', color: 'var(--error-text)', fontSize: '1.05rem' });
globalStyle('.conflict p', { lineHeight: '1.55' });
globalStyle('.conflict details', { margin: '0.7rem 0' });
globalStyle('.conflict pre, .proposal-card pre', {
  maxHeight: '24rem',
  overflow: 'auto',
  padding: '0.8rem',
  border: '1px solid var(--line)',
  background: 'var(--paper)',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
});
globalStyle('.conflict-actions, .proposal-actions', { display: 'flex', flexWrap: 'wrap', gap: '0.5rem' });
globalStyle('.scratch-panel', {
  marginTop: '0.6rem',
  border: '1px solid var(--line)',
  borderRadius: '0.45rem',
  background: 'var(--scratch-bg)',
});
globalStyle('.scratch-panel summary', { minHeight: '2.7rem', padding: '0.7rem', color: 'var(--muted)', cursor: 'pointer' });
globalStyle('.scratch-panel textarea', {
  width: 'calc(100% - 1.2rem)',
  minHeight: '5.5rem',
  margin: '0 0.6rem 0.6rem',
  resize: 'vertical',
  fontSize: '0.92rem',
});
globalStyle('.scratch-attachment-picker', {
  display: 'grid',
  gap: '0.35rem',
  margin: '0.4rem 0.6rem',
  color: 'var(--muted)',
  fontSize: '0.84rem',
});
globalStyle('.scratch-recovery-list', { display: 'grid', gap: '0.4rem', margin: '0.5rem 0.6rem', padding: '0', listStyle: 'none' });
globalStyle('.scratch-recovery-list li', {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '0.35rem',
  justifyContent: 'space-between',
  padding: '0.45rem',
  border: '1px solid var(--line)',
  borderRadius: '0.35rem',
  fontSize: '0.78rem',
  overflowWrap: 'anywhere',
});
globalStyle('.scratch-recovery-list li span', { flex: '1 1 12rem' });
globalStyle('.history-panel, .proposal-review, .contribution-host', {
  margin: '1rem 0',
  padding: '1rem',
  border: '1px solid var(--line)',
  borderRadius: '0.55rem',
  background: 'var(--paper)',
});
globalStyle('.history-panel ol', { paddingLeft: '1.5rem' });
globalStyle('.history-panel li + li', { marginTop: '0.7rem' });
globalStyle('.history-panel li strong, .history-panel li span', { display: 'block' });
globalStyle('.history-panel li span', { marginTop: '0.15rem', color: 'var(--muted)', fontSize: '0.82rem' });
globalStyle('.proposal-review > p', { color: 'var(--muted)', fontSize: '0.86rem' });
globalStyle('.proposal-list', { display: 'grid', gap: '0.75rem' });
globalStyle('.proposal-card', {
  padding: '0.9rem',
  border: '1px solid var(--line)',
  borderRadius: '0.5rem',
  background: 'var(--proposal-bg)',
});
globalStyle('.proposal-card header', { display: 'flex', justifyContent: 'space-between', gap: '0.6rem' });
globalStyle('.proposal-card header span, .proposal-operation p', { color: 'var(--muted)', fontSize: '0.8rem' });
globalStyle('.proposal-operation', { padding: '0.6rem 0', borderTop: '1px solid var(--line)' });
globalStyle('.proposal-operation h3', { margin: '0.2rem 0', fontSize: '0.95rem' });
globalStyle('.proposal-operation ul', { paddingLeft: '1.3rem', overflowWrap: 'anywhere' });
globalStyle('.native-review-toolbar', { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.65rem', margin: '0.6rem 0' });
globalStyle('.native-changeset-list', {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 15rem), 1fr))',
  gap: '0.55rem',
  padding: '0',
  listStyle: 'none',
});
globalStyle('.native-changeset-select', {
  display: 'grid',
  width: '100%',
  minHeight: '2.75rem',
  gap: '0.25rem',
  padding: '0.65rem',
  border: '1px solid var(--line)',
  borderRadius: '0.45rem',
  color: 'inherit',
  textAlign: 'left',
  background: 'var(--paper)',
  overflowWrap: 'anywhere',
});
globalStyle('.native-changeset-select[aria-pressed="true"]', { outline: '2px solid var(--accent)', outlineOffset: '1px' });
globalStyle('.native-changeset-select small', { color: 'var(--muted)' });
globalStyle('.native-changeset-card h3', { margin: '1rem 0 0.35rem', fontSize: '0.92rem' });
globalStyle('.native-changeset-card h4', { margin: '0.3rem 0', fontSize: '0.85rem' });
globalStyle('.native-changeset-card pre', {
  maxHeight: '20rem',
  overflow: 'auto',
  padding: '0.7rem',
  border: '1px solid var(--line)',
  borderRadius: '0.3rem',
  background: 'var(--paper)',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  fontSize: '0.78rem',
});
globalStyle('.native-changeset-card .proposal-actions', { alignItems: 'flex-start' });
globalStyle('.proposal-dock', { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '0.75rem' });
globalStyle('.contribution-host > h2', { margin: '0 0 0.7rem', fontSize: '1rem' });
globalStyle('.contribution-card', {
  minWidth: '0',
  padding: '0.75rem',
  border: '1px solid var(--line)',
  borderRadius: '0.45rem',
  background: 'var(--proposal-bg)',
});
globalStyle('.contribution-card h3', { margin: '0 0 0.55rem', fontSize: '0.92rem' });
globalStyle('.is-zen', {
  position: 'fixed',
  zIndex: '10',
  inset: '0',
  maxWidth: 'none',
  overflow: 'auto',
  padding: '1rem clamp(1rem, 8vw, 8rem)',
  background: 'var(--page-bg)',
});
globalStyle(
  '.is-zen .editor-header, .is-zen .durability-message, .is-zen .conflict, .is-zen .preview-column, .is-zen .editor-hint, .is-zen .scratch-panel',
  { display: 'none' },
);
globalStyle('.is-zen .editor-columns', { display: 'block', minHeight: '80vh' });
globalStyle('.is-zen .manuscript-column', { minHeight: '88vh', padding: '1.5rem' });
globalStyle('.is-zen #manuscript', { minHeight: '72vh', border: '0', background: 'transparent' });
globalStyle('.is-zen::after', {
  position: 'fixed',
  right: '1rem',
  bottom: '0.8rem',
  color: 'var(--muted)',
  content: '"Esc で集中を終了"',
  fontSize: '0.78rem',
  pointerEvents: 'none',
});
globalStyle('.is-zen.is-typewriter-dim .cm-line', { transition: 'opacity 120ms ease' });
globalStyle('.is-zen.is-typewriter-dim .cm-line:not(.cm-activeLine)', { opacity: '0.22' });
globalStyle('.workspace-grid', { '@media': { '(max-width: 960px)': { gridTemplateColumns: 'minmax(13rem, 16rem) minmax(0, 1fr)' } } });
globalStyle('.editor-columns', { '@media': { '(max-width: 960px)': { gridTemplateColumns: '1fr' } } });
globalStyle('.manuscript-input, .cm-scroller, .cm-content, .manuscript-preview', {
  '@media': { '(max-width: 960px)': { minHeight: '38vh' } },
});
globalStyle('.topbar', { '@media': { '(max-width: 640px)': { alignItems: 'flex-start', flexWrap: 'wrap' } } });
globalStyle('.topbar-status', { '@media': { '(max-width: 640px)': { order: '3', flexBasis: '100%' } } });
globalStyle('.theme-control', { '@media': { '(max-width: 640px)': { marginLeft: 'auto' } } });
globalStyle('.workspace-grid', { '@media': { '(max-width: 640px)': { gridTemplateColumns: '1fr' } } });
globalStyle('.sidebar', { '@media': { '(max-width: 640px)': { borderRight: '0', borderBottom: '1px solid var(--line)' } } });
globalStyle('.tree', { '@media': { '(max-width: 640px)': { maxHeight: '17rem', overflow: 'auto' } } });
globalStyle('.writing-area', { '@media': { '(max-width: 640px)': { padding: '1rem 0.65rem 2rem' } } });
globalStyle('.editor-header', { '@media': { '(max-width: 640px)': { alignItems: 'flex-start', flexDirection: 'column' } } });
globalStyle('.editor-actions', { '@media': { '(max-width: 640px)': { justifyContent: 'flex-start' } } });
globalStyle('.manuscript-column, .preview-column', { '@media': { '(max-width: 640px)': { padding: '0.7rem' } } });
globalStyle('.manuscript-input, .cm-scroller, .cm-content', { '@media': { '(max-width: 640px)': { minHeight: '48vh' } } });
globalStyle('.typography-toolbar', { '@media': { '(max-width: 640px)': { gap: '0.3rem' } } });
globalStyle('.typography-toolbar > button', { '@media': { '(max-width: 640px)': { minHeight: '2.75rem' } } });
globalStyle('.proposal-dock', { '@media': { '(max-width: 640px)': { gridTemplateColumns: '1fr' } } });
globalStyle('*, *::before, *::after', {
  '@media': { '(prefers-reduced-motion: reduce)': { scrollBehavior: 'auto !important' as unknown as CSSProperties['scrollBehavior'] } },
});
globalStyle('body, .workspace, .writing-area', { '@media': { print: { background: 'white' } } });
globalStyle(
  '.topbar, .sidebar, .editor-header, .typography-toolbar, .durability-message, .status, .conflict, .editor-hint, .scratch-panel, .proposal-review, .contribution-host, .history-panel, .preview-column',
  { '@media': { print: { display: 'none !important' } } },
);
globalStyle('.workspace-grid', { '@media': { print: { display: 'block', minHeight: '0' } } });
globalStyle('.writing-area', { '@media': { print: { padding: '0' } } });
globalStyle('.editor, .editor-columns, .manuscript-column', {
  '@media': { print: { display: 'block', maxWidth: 'none', minHeight: '0', padding: '0', border: '0', boxShadow: 'none' } },
});
globalStyle('.manuscript-input', { '@media': { print: { display: 'none' } } });
globalStyle('body > .pg-print-document.print-view', {
  '@media': {
    print: {
      display: 'block !important',
      minHeight: '0',
      overflow: 'visible',
      padding: '0',
      border: '0',
      color: 'black',
      background: 'white',
      whiteSpace: 'pre-wrap',
    },
  },
});
globalStyle('body > .pg-print-document.print-view.is-vertical', { '@media': { print: { writingMode: 'vertical-rl' } } });
globalStyle('html:has(> body > .pg-print-document),\n  body:has(> .pg-print-document)', {
  '@media': { print: { height: 'auto', minHeight: '0', maxHeight: 'none', overflow: 'visible' } },
});
globalStyle('body:has(> .pg-print-document)', { '@media': { print: { position: 'static', transform: 'none', background: 'white' } } });
globalStyle('body:has(> .pg-print-document) > #root', { '@media': { print: { display: 'none !important' } } });
globalStyle('body > .pg-print-document', { '@media': { print: { maxWidth: 'none', overflowWrap: 'anywhere' } } });
globalStyle('.reading-view', {
  '@media': {
    '(max-width: 760px)': {
      width: '100%',
      maxWidth: 'none',
      minHeight: '60vh',
      maxHeight: '70vh',
      margin: '0.5rem auto',
      padding: '0.6rem',
      overflow: 'hidden',
    },
  },
});
globalStyle('.reading-pager', {
  '@media': { '(max-width: 760px)': { height: '60vh', minHeight: '22rem', overflow: 'hidden', touchAction: 'pan-y' } },
});
globalStyle('.reading-pager-content.is-horizontal', {
  '@media': {
    '(max-width: 760px)': { height: '100%', columnWidth: 'var(--reading-page-width, 100%)', columnGap: '0', columnFill: 'auto' },
  },
});
globalStyle('.reading-pager-content.is-horizontal > div', {
  '@media': {
    '(max-width: 760px)': {
      width: 'var(--reading-page-width, 100%)',
      height: '100%',
      maxWidth: 'none',
      boxSizing: 'border-box',
      padding: '1rem 1.4rem',
      overflowWrap: 'anywhere',
    },
  },
});
globalStyle('.reading-pager-content.is-vertical', {
  '@media': { '(max-width: 760px)': { width: 'max-content', height: '100%', overflow: 'visible' } },
});
globalStyle('.reading-pager-content.is-vertical > div', {
  '@media': { '(max-width: 760px)': { maxHeight: 'none', height: '100%', width: 'max-content', padding: '0.8rem 1rem' } },
});
globalStyle('.reading-page-count', {
  '@media': {
    '(max-width: 760px)': {
      position: 'absolute',
      right: '0.7rem',
      bottom: '0.45rem',
      zIndex: '2',
      display: 'block',
      margin: '0',
      padding: '0.15rem 0.45rem',
      borderRadius: '999px',
      color: 'var(--muted)',
      background: 'var(--paper)',
      fontSize: '0.72rem',
    },
  },
});
globalStyle('.reading-page-control', {
  '@media': { '(max-width: 760px)': { position: 'absolute', top: '50%', zIndex: '3', display: 'block', transform: 'translateY(-50%)' } },
});
globalStyle('.reading-page-control:disabled', { '@media': { '(max-width: 760px)': { visibility: 'hidden' } } });
globalStyle('.reading-page-control.is-previous', { '@media': { '(max-width: 760px)': { left: '0.2rem' } } });
globalStyle('.reading-page-control.is-next', { '@media': { '(max-width: 760px)': { right: '0.2rem' } } });
globalStyle('.reading-pager.is-chrome-hidden .reading-page-count, .reading-pager.is-chrome-hidden .reading-page-control', {
  '@media': { '(max-width: 760px)': { display: 'none' } },
});
globalStyle('.manuscript-history-layout', { '@media': { '(max-width: 760px)': { gridTemplateColumns: '1fr', maxHeight: 'none' } } });
globalStyle('.manuscript-history-layout > ol', { '@media': { '(max-width: 760px)': { maxHeight: '12rem' } } });
globalStyle('.pg-entry', { minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 'clamp(1rem, 4vw, 4rem)' });
globalStyle('.pg-login', {
  width: 'min(100%, 30rem)',
  display: 'grid',
  gap: '0.8rem',
  padding: 'clamp(1.2rem, 4vw, 2rem)',
  border: '1px solid var(--line)',
  borderRadius: '0.8rem',
  background: 'var(--paper)',
  boxShadow: '0 1rem 3rem var(--focus-shadow)',
});
globalStyle('.pg-login h1', { margin: '0' });
globalStyle('.pg-login p', { margin: '0.2rem 0', color: 'var(--muted)' });
globalStyle('.pg-login a, .pg-header a', { color: 'var(--accent-strong)' });
globalStyle('.pg-workspace', { minHeight: '100vh', padding: '1rem', color: 'var(--ink)' });
globalStyle('.pg-header', {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '1rem',
  maxWidth: '1800px',
  margin: '0 auto 1rem',
  padding: '0.6rem 0.8rem 1rem',
  borderBottom: '1px solid var(--line)',
});
globalStyle('.pg-header h1', { margin: '0', fontSize: '1.35rem' });
globalStyle('.pg-header nav', { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.8rem' });
globalStyle('.pg-header nav button', { minHeight: '2.4rem' });
globalStyle('.pg-layout', {
  maxWidth: '1800px',
  margin: '0 auto',
  display: 'grid',
  gridTemplateColumns: 'minmax(14rem, 18rem) minmax(20rem, 1fr) minmax(17rem, 21rem)',
  alignItems: 'start',
  gap: '1rem',
});
globalStyle('.pg-library, .pg-knowledge, .pg-editor-column', { minWidth: '0' });
globalStyle('.pg-library, .pg-knowledge', { display: 'grid', gap: '1rem' });
globalStyle('.pg-library section, .pg-knowledge section, .pg-editor, .pg-empty, .pg-conflict, .pg-revisions', {
  padding: '1rem',
  border: '1px solid var(--line)',
  borderRadius: '0.65rem',
  background: 'var(--paper)',
});
globalStyle('.pg-library h2, .pg-knowledge h2, .pg-editor h2', { margin: '0 0 0.8rem', fontSize: '1.05rem' });
globalStyle('.pg-library form, .pg-knowledge form', { display: 'grid', gap: '0.45rem', marginTop: '0.9rem' });
globalStyle('.pg-library select, .pg-knowledge select', {
  width: '100%',
  minHeight: '2.65rem',
  padding: '0.4rem',
  border: '1px solid var(--input-border)',
  borderRadius: '0.35rem',
  color: 'var(--ink)',
  background: 'var(--paper)',
});
globalStyle('.pg-document-list, .pg-knowledge-list, :is(.pg-evidence-list, .pg-node-evidence-list)', {
  display: 'grid',
  gap: '0.55rem',
  margin: '0.7rem 0',
  padding: '0',
  listStyle: 'none',
});
globalStyle('.pg-document-list li, .pg-knowledge-list li, :is(.pg-evidence-list, .pg-node-evidence-list) li', { minWidth: '0' });
globalStyle(
  '.pg-document-list button, .pg-knowledge-list > li > button:first-child, :is(.pg-evidence-list, .pg-node-evidence-list) > li > button:first-child',
  {
    width: '100%',
    display: 'grid',
    justifyItems: 'start',
    gap: '0.2rem',
    textAlign: 'left',
    color: 'var(--ink)',
    background: 'var(--surface-subtle)',
    borderColor: 'var(--input-border)',
  },
);
globalStyle(
  '.pg-document-list button.is-selected, .pg-knowledge-list button.is-selected, :is(.pg-evidence-list, .pg-node-evidence-list) button.is-selected',
  { background: 'var(--surface-selected)', borderColor: 'var(--surface-selected-border)' },
);
globalStyle('.pg-document-list small, .pg-knowledge-list small, :is(.pg-evidence-list, .pg-node-evidence-list) small', {
  color: 'var(--muted)',
});
globalStyle('.pg-editor-column', { display: 'grid', gap: '0.8rem' });
globalStyle('.pg-editor', { display: 'grid', gap: '0.8rem' });
globalStyle('.pg-editor-heading', { display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: '0.8rem' });
globalStyle('.pg-editor-heading h2', { margin: '0', fontSize: '1.35rem', overflowWrap: 'anywhere' });
globalStyle('.pg-editor-heading .eyebrow', { margin: '0 0 0.3rem' });
globalStyle('.pg-save-state', {
  display: 'grid',
  justifyItems: 'end',
  gap: '0.25rem',
  color: 'var(--muted)',
  fontSize: '0.82rem',
  textAlign: 'right',
});
globalStyle('.pg-editor-actions', { display: 'flex', flexWrap: 'wrap', gap: '0.5rem' });
globalStyle('.pg-editor-actions button', { minHeight: '2.45rem' });
globalStyle('.pg-editor .manuscript-input', {
  minHeight: '60vh',
  border: '1px solid var(--line)',
  borderRadius: '0.35rem',
  background: 'var(--paper)',
});
globalStyle('.pg-editor .cm-editor, .pg-editor .cm-scroller, .pg-editor .cm-content', { minHeight: '60vh' });
globalStyle('.pg-editor-hint', { margin: '0', color: 'var(--muted)', fontSize: '0.85rem' });
globalStyle('.pg-alert', {
  padding: '0.65rem 0.8rem',
  border: '1px solid var(--error-border)',
  borderRadius: '0.35rem',
  color: 'var(--error-text)',
  background: 'var(--error-bg)',
});
globalStyle('.pg-notice', {
  padding: '0.65rem 0.8rem',
  border: '1px solid var(--line)',
  borderRadius: '0.35rem',
  background: 'var(--paper)',
});
globalStyle('.pg-empty', { minHeight: '15rem', display: 'grid', alignContent: 'center', gap: '0.5rem' });
globalStyle('.pg-empty h2, .pg-empty p', { margin: '0' });
globalStyle('.pg-empty p', { color: 'var(--muted)' });
globalStyle('.pg-conflict-comparison', { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem' });
globalStyle('.pg-conflict-comparison > div', { minWidth: '0' });
globalStyle('.pg-conflict pre, .pg-revisions pre', {
  maxHeight: '18rem',
  overflow: 'auto',
  padding: '0.7rem',
  border: '1px solid var(--line)',
  borderRadius: '0.35rem',
  background: 'var(--surface-subtle)',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
});
globalStyle('.pg-conflict button, .pg-revisions button', { margin: '0 0.5rem 0.5rem 0' });
globalStyle('.pg-revision-confirmation', {
  maxInlineSize: 'min(28rem, calc(100vw - 2rem))',
  padding: '1.25rem',
  border: '1px solid var(--line)',
  borderRadius: '0.8rem',
  color: 'var(--ink)',
  background: 'var(--paper)',
  boxShadow: '0 12px 38px var(--focus-shadow)',
});
globalStyle('.pg-revision-confirmation::backdrop', { background: 'rgb(13 17 16 / 48%)' });
globalStyle('.pg-revision-confirmation h2', { marginBlockStart: 0 });
globalStyle('.pg-revision-confirmation form', { display: 'flex', flexWrap: 'wrap', gap: '0.5rem' });
globalStyle('.pg-revisions', { marginTop: '0.8rem' });
globalStyle('.pg-revisions article + article', { borderTop: '1px solid var(--line)' });
globalStyle(':is(.pg-evidence-list, .pg-node-evidence-list) q', { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' });
globalStyle(':is(.pg-evidence-list, .pg-node-evidence-list) p', { margin: '0.35rem 0' });
globalStyle('.pg-link-actions', { display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginTop: '0.4rem' });
globalStyle('.pg-link-actions button', { minHeight: '2.3rem', padding: '0.4rem 0.6rem', fontSize: '0.82rem' });
globalStyle('.pg-loading', {
  position: 'fixed',
  inset: 'auto 1rem 1rem auto',
  zIndex: '10',
  margin: '0',
  padding: '0.5rem 0.75rem',
  border: '1px solid var(--line)',
  borderRadius: '999px',
  background: 'var(--paper)',
  boxShadow: '0 0.2rem 0.9rem var(--focus-shadow)',
});
globalStyle('.pg-desktop .pg-layout', {
  '@media': { '(max-width: 1000px)': { gridTemplateColumns: 'minmax(12rem, 15rem) minmax(0, 1fr)' } },
});
globalStyle('.pg-desktop .pg-knowledge', {
  '@media': { '(max-width: 1000px)': { gridColumn: '1 / -1', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' } },
});
globalStyle('.pg-workspace', { '@media': { '(max-width: 620px)': { padding: '0.5rem' } } });
globalStyle('.pg-header', { '@media': { '(max-width: 620px)': { padding: '0.5rem 0.4rem 0.75rem' } } });
globalStyle('.pg-header nav', { '@media': { '(max-width: 620px)': { gap: '0.45rem', fontSize: '0.86rem' } } });
globalStyle('.pg-header nav button', { '@media': { '(max-width: 620px)': { padding: '0.4rem 0.55rem' } } });
globalStyle('.pg-desktop .pg-layout', { '@media': { '(max-width: 620px)': { gridTemplateColumns: 'minmax(0, 1fr)' } } });
globalStyle('.pg-desktop .pg-knowledge', { '@media': { '(max-width: 620px)': { gridColumn: 'auto', gridTemplateColumns: '1fr' } } });
globalStyle('.pg-editor-heading h2', { '@media': { '(max-width: 620px)': { fontSize: '1.15rem' } } });
globalStyle('.pg-editor-actions', { '@media': { '(max-width: 620px)': { display: 'grid', gridTemplateColumns: '1fr 1fr' } } });
globalStyle('.pg-editor-actions button:last-child', { '@media': { '(max-width: 620px)': { gridColumn: '1 / -1' } } });
globalStyle('.pg-shell', { padding: '0' });
globalStyle('.pg-shell .pg-editor-column', { width: '100%' });
globalStyle('.pg-shell .pg-library, .pg-shell .pg-knowledge', { padding: '0.75rem' });
globalStyle('.pg-shell .pg-editor', { border: '0', borderRadius: '0' });
globalStyle('.pg-shell .pg-editor .cm-content', {
  fontFamily: 'var(--editor-font-family, var(--manuscript-serif))',
  fontSize: 'var(--editor-font-size, 1.05rem)',
  lineHeight: 'var(--editor-line-height, 1.9)',
  letterSpacing: 'var(--editor-letter-spacing, normal)',
});
