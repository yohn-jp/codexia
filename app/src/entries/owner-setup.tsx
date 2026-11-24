import '../styles.css';
import '../console/console.css';
import { createRoot } from 'react-dom/client';
import { ConsoleSetup } from '../console/ConsoleSetup';
import { applyThemeMode, loadThemeMode } from '../theme';

const root = document.getElementById('root');
if (!root) throw new Error('Missing React root');
applyThemeMode(loadThemeMode());
createRoot(root).render(
  <main className="codexia-console" aria-labelledby="console-title">
    <div className="codexia-console__wrap">
      <ConsoleSetup consoleUrl="/console" />
    </div>
  </main>,
);
