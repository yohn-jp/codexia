import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PublicModuleView, publicModuleIdForPath } from './contributions/PublicModuleView';
import { applyThemeMode, loadThemeMode, persistThemeMode, type ThemeMode } from './theme';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing React root');
const theme = loadThemeMode();
applyThemeMode(theme);

// The public reader remains a distinct read-only presentation. No Git authoring
// workspace or automatic fallback is reachable through the launcher.
const isReader = window.location.pathname.startsWith('/r/');
let remembered: string | null = null;
try {
  remembered = localStorage.getItem('scriptorium:ui-mode');
} catch {
  /* The picker works without local storage. */
}
if (!isReader && (remembered === 'desktop' || remembered === 'mobile')) {
  const search = new URLSearchParams(window.location.search);
  search.delete('store');
  window.location.replace(`/desktop${search.size ? `?${search}` : ''}${window.location.hash}`);
} else {
  createRoot(root).render(isReader ? <PublicReader initialTheme={theme} /> : <InterfaceChoice />);
}

function PublicReader({ initialTheme }: { initialTheme: ThemeMode }) {
  const [themeMode, setThemeMode] = useState(initialTheme);
  const [themeError, setThemeError] = useState('');
  const moduleId = publicModuleIdForPath(window.location.pathname);
  if (!moduleId) return <main role="alert">公開読書ビューが見つかりません。</main>;
  return (
    <PublicModuleView
      moduleId={moduleId}
      themeMode={themeMode}
      themeError={themeError}
      onThemeChange={next => {
        setThemeMode(next);
        try {
          persistThemeMode(next);
          setThemeError('');
        } catch {
          setThemeError('外観設定を保存できませんでした。');
        }
      }}
    />
  );
}

function InterfaceChoice() {
  const choose = () => {
    try {
      localStorage.setItem('scriptorium:ui-mode', 'desktop');
    } catch {
      /* Direct links remain usable. */
    }
    const search = new URLSearchParams(window.location.search);
    search.delete('store');
    window.location.assign(`/desktop${search.size ? `?${search}` : ''}${window.location.hash}`);
  };
  return (
    <section className="empty-state" aria-labelledby="interface-title">
      <p className="eyebrow">Codexia</p>
      <h1 id="interface-title">執筆画面を選ぶ</h1>
      <p>作品はPostgreSQLへ保存されます。</p>
      <p>
        <button type="button" onClick={choose}>
          Desktop — キーボードで執筆
        </button>
      </p>
    </section>
  );
}
