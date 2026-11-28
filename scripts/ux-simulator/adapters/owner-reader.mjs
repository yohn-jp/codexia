import { catalogLocation, records, sourceAt, sourceRef, transition } from './owner-source.mjs';

const launcher = 'app/src/launcher.tsx';
const shell = 'app/src/contributions/PublicModuleView.tsx';
const theme = 'app/src/components/ThemeControl.tsx';
const publishing = 'modules/publishing/src/browser.tsx';
const server = 'packages/api/src/server.ts';

function publicControl(source) {
  if (!source.exists(theme)) return null;
  const themeSource = source.read(theme);
  const binding = themeSource.match(/onChange\s*=\s*\{\s*(?:\(event\)|event)\s*=>\s*onChange\(event\.currentTarget\.value as ThemeMode\)\s*\}/u)?.[0];
  const themeHandler = binding && sourceAt(source, theme, binding);
  const themeLabel = themeSource.match(/aria-label=["']([^"']+)["']/u)?.[1];
  const sceneHandler = sourceAt(source, shell, 'const body = await publicShareSceneGet(projectId, token, sceneId, options);');
  const label = sourceAt(source, publishing, '読み取り専用の共有です。期限:');
  const readerBinding = sourceAt(source, shell, 'onChange={onThemeChange}');
  const launcherText = source.read(launcher);
  const launcherBindingText = launcherText.match(/onThemeChange=\{\s*(?:\(\s*next\s*\)|next)\s*=>\s*\{/u)?.[0];
  const launcherBinding = launcherBindingText && sourceAt(source, launcher, launcherBindingText);
  if (!themeHandler || !sceneHandler || !label || !readerBinding || !launcherBinding) return null;
  return {
    id: 'PUB-01.A', platform: 'reader', source: sourceRef(sceneHandler), label: themeLabel,
    role: 'control', handler: [themeHandler.symbol, sceneHandler.symbol].join(' · '), region: 'public-content',
  };
}

export function projectReader(source) {
  const launcherText = source.exists(launcher) ? source.read(launcher) : '';
  const appRouteText = launcherText.match(/const isReader\s*=\s*window\.location\.pathname\.startsWith\((['"])\/r\/\1\);/u)?.[0];
  const appRoute = appRouteText && sourceAt(source, launcher, appRouteText);
  const component = sourceAt(source, shell, 'export function PublicModuleView(');
  const apiRoute = sourceAt(source, server, 'function isPublicReaderPath(pathname: string): boolean {');
  const shareMount = sourceAt(source, publishing, 'async mountPublic(viewId: string, element: HTMLElement, _request: Request, source?: PublicShareReaderSource): Promise<() => void> {');
  const publicReaderScreen = appRoute && component && apiRoute && shareMount ? {
    id: 'PUB-01', platform: 'reader', source: sourceRef(component), route: '/r/:module/:project/:slug',
    regions: [
      { id: 'public-reader-header', role: 'navigation', label: '公開読書ビューと外観', source: sourceRef(sourceAt(source, shell, '<header className="public-module-header">')) },
      { id: 'public-content', role: 'content', label: 'share capabilityで公開された内容', source: sourceRef(sourceAt(source, publishing, 'function ShareReaderView({ source }: { source: PublicShareReaderSource })')) },
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
      event: 'public metadata response', screen: 'PUB-01', condition: 'publicShareGet failure from loadIndex()', location: sourceAt(source, publishing, "if (alive) setError('共有リンクは無効か、期限切れです。');"),
    }),
    transition({
      id: 'public-theme-local-change', platform: 'reader', from: 'PUB-01/content', to: 'PUB-01/content',
      event: 'ThemeControl.onChange', screen: 'PUB-01', control: control?.id, condition: 'setThemeMode(next)', location: control && sourceAt(source, launcher, 'setThemeMode(next);'),
    }),
  );
  const gaps = records(
    !apiRoute && { id: 'PUB-01', platform: 'reader', status: 'unextracted', reason: 'The public reader API route validator could not be located in the canonical server source.', source: sourceRef(catalogLocation(source, 'PUB-01')) },
    apiRoute && !shareMount && { id: 'PUB-01', platform: 'reader', status: 'unextracted', reason: 'The publishing module public mount could not be located; no reader behavior is inferred.', source: sourceRef(catalogLocation(source, 'PUB-01')) },
  );
  return { screens: records(publicReaderScreen), controls: records(control), transitions, gaps };
}
