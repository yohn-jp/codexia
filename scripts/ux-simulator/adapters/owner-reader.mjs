import { records, sourceAt, sourceRef, transition } from './owner-source.mjs';

const launcher = 'app/src/launcher.tsx';
const shell = 'app/src/contributions/PublicModuleView.tsx';
const theme = 'app/src/components/ThemeControl.tsx';
const publishing = 'modules/publishing/src/browser.tsx';
const server = 'packages/api/src/server.ts';
const catalog = 'docs/design/SCREEN-CONTROL-CATALOG.md';

function publicControl(source) {
  const themeHandler = sourceAt(source, theme, 'onChange={(event) => onChange(event.currentTarget.value as ThemeMode)}');
  const sceneHandler = sourceAt(source, publishing, 'onClick={() => void openScene(item.id)}');
  const label = sourceAt(source, publishing, '読み取り専用の共有です。期限:');
  if (!themeHandler || !sceneHandler || !label) return null;
  return {
    id: 'PUB-01.A', platform: 'reader', source: sourceRef(sceneHandler), label: '公開版を読む・外観を変更する',
    role: 'control', handler: 'onChange={(event) => onChange(event.currentTarget.value as ThemeMode)} · onClick={() => void openScene(item.id)}', region: 'public-content',
  };
}

export function projectReader(source) {
  const appRoute = sourceAt(source, launcher, 'const isReader = window.location.pathname.startsWith("/r/");');
  const component = sourceAt(source, shell, 'export function PublicModuleView(');
  const apiRoute = sourceAt(source, server, 'function isPublicReaderPath(pathname: string): boolean {');
  const shareMount = sourceAt(source, publishing, 'async mountPublic(viewId: string, element: HTMLElement, request: Request): Promise<() => void> {');
  const publicReaderScreen = appRoute && component && apiRoute && shareMount ? {
    id: 'PUB-01', platform: 'reader', source: sourceRef(component), route: '/r/:module/:project/:slug',
    regions: [
      { id: 'public-reader-header', role: 'navigation', label: '公開読書ビューと外観', source: sourceRef(sourceAt(source, shell, '<header className="public-module-header">')) },
      { id: 'public-content', role: 'content', label: 'share capabilityで公開された内容', source: sourceRef(sourceAt(source, publishing, 'function ShareReaderView({ projectId, token }')) },
      { id: 'public-loading-state', role: 'status', label: '公開コンテンツ取得状態', source: sourceRef(sourceAt(source, shell, '公開コンテンツを読み込んでいます…')) },
    ],
  } : null;
  const control = publicReaderScreen && publicControl(source);
  const transitions = records(
    transition({
      id: 'public-module-mounted', platform: 'reader', from: 'PUB-01/loading', to: 'PUB-01/content',
      event: 'mountPublic("share")', screen: 'PUB-01', condition: 'definition.mountPublic exists and route is valid', location: sourceAt(source, shell, 'const cleanup = await definition.mountPublic("share", element, request);'),
    }),
    transition({
      id: 'public-scene-selected', platform: 'reader', from: 'PUB-01/content', to: 'PUB-01/scene',
      event: 'openScene(id)', screen: 'PUB-01', control: control?.id, condition: 'public scene response is ok', location: sourceAt(source, publishing, 'setScene(await response.json() as Record<string, unknown>);'),
    }),
    transition({
      id: 'public-share-expired', platform: 'reader', from: 'PUB-01/loading', to: 'PUB-01/unavailable',
      event: 'public metadata response', screen: 'PUB-01', condition: 'if (!response.ok)', location: sourceAt(source, publishing, 'if (!response.ok) throw new Error("共有リンクは無効か、期限切れです。");'),
    }),
    transition({
      id: 'public-theme-local-change', platform: 'reader', from: 'PUB-01/content', to: 'PUB-01/content',
      event: 'ThemeControl.onChange', screen: 'PUB-01', control: control?.id, condition: 'setThemeMode(next)', location: sourceAt(source, launcher, 'setThemeMode(next);'),
    }),
  );
  const gaps = records(
    !apiRoute && { id: 'PUB-01', platform: 'reader', status: 'unextracted', reason: 'The public reader API route validator could not be located in the canonical server source.', source: sourceRef(sourceAt(source, catalog, '| PUB-01 |')) },
    apiRoute && !shareMount && { id: 'PUB-01', platform: 'reader', status: 'unextracted', reason: 'The publishing module public mount could not be located; no reader behavior is inferred.', source: sourceRef(sourceAt(source, catalog, '| PUB-01 |')) },
  );
  return { screens: records(publicReaderScreen), controls: records(control), transitions, gaps };
}
