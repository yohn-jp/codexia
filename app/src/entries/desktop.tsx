import '../../styles.css';
import { createRoot } from 'react-dom/client';
import { installNativeSelectCspCompatibility } from '../browser/nativeSelect';
import { PersistenceEntry } from '../persistence/PersistenceEntry';
import { applyThemeMode, loadThemeMode } from '../theme';

const root = document.getElementById('root');
if (!root) throw new Error('Missing React root');
applyThemeMode(loadThemeMode());
installNativeSelectCspCompatibility(document);
const reactRoot = createRoot(root);
if (window.location.pathname === '/console' || window.location.pathname.startsWith('/console/')) {
  void import('../console/ConsoleEntry').then(
    ({ ConsoleEntry }) => reactRoot.render(<ConsoleEntry />),
    () => reactRoot.render(<p role="alert">管理コンソールを読み込めません。ページを再読み込みしてください。</p>),
  );
} else {
  reactRoot.render(<PersistenceEntry mode="desktop" />);
}
