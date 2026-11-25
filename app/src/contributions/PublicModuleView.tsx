import type { ModuleId, PublicShareReaderIndex, PublicShareReaderScene, PublicShareReaderSource } from '@codexia/contracts';
import { useEffect, useRef, useState } from 'react';
import { ThemeControl } from '../components/ThemeControl';
import { moduleBrowserLoaders } from '../generated/browser-modules';
import { publicShareGet, publicShareSceneGet } from '../generated/http/client';
import type { ThemeMode } from '../theme';

function publicShareSource(request: Request): PublicShareReaderSource | undefined {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  const routeIndex = segments.indexOf('r');
  if (routeIndex < 0 || segments[routeIndex + 1] !== 'publishing' || routeIndex + 4 !== segments.length) return undefined;
  const rawProjectId = segments[routeIndex + 2];
  const rawToken = segments[routeIndex + 3];
  if (!rawProjectId || !rawToken) return undefined;
  let projectId: string;
  let token: string;
  try {
    projectId = decodeURIComponent(rawProjectId);
    token = decodeURIComponent(rawToken);
  } catch {
    return undefined;
  }
  const options = {
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    headers: { accept: 'application/json' },
    signal: request.signal,
    transport: { auth: 'anonymous' },
  } as const;
  return {
    async loadIndex(): Promise<PublicShareReaderIndex> {
      const body = await publicShareGet(projectId, token, options);
      return {
        label: body.label,
        expiresAt: body.expiresAt,
        rootScenes: body.rootScenes.map(({ id, title }) => ({ id, title })),
        tree: body.tree.map(({ volume, chapters }) => ({
          volume: { title: volume.title },
          chapters: chapters.map(({ chapter, scenes }) => ({
            chapter: { title: chapter.title },
            scenes: scenes.map(({ id, title }) => ({ id, title })),
          })),
        })),
      };
    },
    async loadScene(sceneId: string): Promise<PublicShareReaderScene> {
      const body = await publicShareSceneGet(projectId, token, sceneId, options);
      return { title: body.title, body: body.body };
    },
  };
}

const MODULE_IDS = new Set<ModuleId>(['story', 'diagnostics', 'nlp', 'semantic', 'speaker', 'assistant', 'publishing', 'mcp']);

export function publicModuleIdForPath(pathname: string): ModuleId | null {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length !== 4 || parts[0] !== 'r' || !parts[2] || !parts[3]) return null;
  const rawModuleId = parts[1];
  if (!rawModuleId) return null;
  let moduleId: string;
  try {
    moduleId = decodeURIComponent(rawModuleId);
  } catch {
    return null;
  }
  return MODULE_IDS.has(moduleId as ModuleId) ? (moduleId as ModuleId) : null;
}

export function PublicModuleView({
  moduleId,
  themeMode,
  onThemeChange,
  themeError,
}: {
  moduleId: ModuleId;
  themeMode: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
  themeError: string;
}) {
  const elementRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;
    const controller = new AbortController();
    setLoading(true);
    setError('');

    void (async () => {
      const loader = moduleBrowserLoaders[moduleId];
      if (!loader) {
        setError('この公開ビューを表示するモジュールは、このデプロイに含まれていません。');
        setLoading(false);
        return;
      }
      try {
        const definition = await loader();
        if (cancelled) return;
        if (!definition.mountPublic) throw new Error('このモジュールには公開読書ビューがありません。');
        const element = elementRef.current;
        if (!element) throw new Error('公開ビューの表示先を準備できませんでした。');
        const request = new Request(window.location.href, {
          method: 'GET',
          credentials: 'omit',
          signal: controller.signal,
        });
        const source = moduleId === 'publishing' ? publicShareSource(request) : undefined;
        const cleanup = await definition.mountPublic('share', element, request, source);
        if (cancelled) cleanup?.();
        else dispose = cleanup;
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : '公開ビューを読み込めませんでした。');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      dispose?.();
    };
  }, [moduleId]);

  return (
    <main className="public-module-shell" aria-label="共有された読書ビュー">
      <header className="public-module-header">
        <span>Codexia</span>
        <span>公開読書ビュー</span>
        <ThemeControl mode={themeMode} onChange={onThemeChange} error={themeError} />
      </header>
      {loading && (
        <p className="public-module-status" role="status">
          公開コンテンツを読み込んでいます…
        </p>
      )}
      {error && (
        <p className="public-module-status" data-kind="error" role="alert">
          {error}
        </p>
      )}
      <div ref={elementRef} />
    </main>
  );
}
