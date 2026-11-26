import type {
  BrowserModuleContext,
  BrowserModuleDefinition,
  PublicShareReaderIndex,
  PublicShareReaderScene,
  PublicShareReaderSource,
} from '@codexia/contracts';
import { createElement, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { publicReaderOrigin, publicReaderUrl } from './share-url.js';

interface SceneItem {
  id: string;
  title: string;
}
interface ChapterItem {
  id: string;
  title: string;
  scenes: SceneItem[];
}
interface VolumeItem {
  id: string;
  title: string;
  chapters: ChapterItem[];
}
interface ProjectTree {
  title: string;
  volumes: VolumeItem[];
  rootScenes?: SceneItem[];
  rootSceneCount?: number;
}
interface Episode extends Record<string, unknown> {
  id: string;
  number: number;
  title: string;
  scope: 'volume' | 'chapter';
  scopeId: string;
  publishedAt?: string | null;
  sceneIds?: string[] | null;
}
interface ShareInfo {
  id: string;
  scope: { kind: 'project' | 'volume' | 'chapter' | 'scene'; id: string } | string;
  label: string;
  tokenPrefix?: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  active: boolean;
}

const DEFAULT_COVER = 'meta/scriptorium/modules/publishing/assets/cover.jpg';

function buttonStyle(danger = false): React.CSSProperties {
  return {
    border: '1px solid #a0a0a0',
    borderRadius: 5,
    padding: '0.4rem 0.7rem',
    background: danger ? '#7d1d2b' : '#f5f5f5',
    color: danger ? 'white' : 'inherit',
    cursor: 'pointer',
  };
}

function fieldStyle(): React.CSSProperties {
  return { border: '1px solid #999', borderRadius: 4, padding: '0.35rem 0.45rem', maxWidth: '100%' };
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ borderTop: '1px solid #aaa', padding: '1rem 0', display: 'grid', gap: 12 }}>
      <h3 style={{ margin: 0 }}>{title}</h3>
      {children}
    </section>
  );
}

function usePublishingContext(context: BrowserModuleContext) {
  const [tree, setTree] = useState<ProjectTree | null>(null);
  const [treeError, setTreeError] = useState('');
  useEffect(() => {
    let alive = true;
    void invoke(context, 'publishing.project.tree', {})
      .then(value => {
        if (alive) setTree(value as unknown as ProjectTree);
      })
      .catch(error => {
        if (alive) setTreeError(messageOf(error));
      });
    return () => {
      alive = false;
    };
  }, [context]);
  return { tree, treeError };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function invoke(context: BrowserModuleContext, actionId: string, input: unknown): Promise<Record<string, unknown>> {
  const result = await context.invoke(actionId, input);
  if (!result.ok) throw new Error(result.error.message);
  return result.data as Record<string, unknown>;
}

function scopeCount(tree: ProjectTree | null, scope: 'all' | 'volume' | 'chapter', id?: string): number {
  if (!tree) return 0;
  if (scope === 'all')
    return tree.volumes.reduce(
      (sum, volume) => sum + volume.chapters.reduce((n, chapter) => n + chapter.scenes.length, 0),
      tree.rootSceneCount ?? 0,
    );
  if (scope === 'volume')
    return tree.volumes.find(item => item.id === id)?.chapters.reduce((n, chapter) => n + chapter.scenes.length, 0) ?? 0;
  return tree.volumes.flatMap(volume => volume.chapters).find(item => item.id === id)?.scenes.length ?? 0;
}

function scopeLabel(tree: ProjectTree | null, scope: 'all' | 'volume' | 'chapter', volumeId: string, chapterId: string): string {
  if (!tree) return '作品を確認中';
  if (scope === 'all') return `${tree.title}／全文`;
  const volume = tree.volumes.find(item => item.id === volumeId);
  if (scope === 'volume') return `${tree.title}／${volume?.title ?? '巻未選択'}`;
  const chapter = volume?.chapters.find(item => item.id === chapterId);
  return `${tree.title}／${volume?.title ?? '巻未選択'}／${chapter?.title ?? '章未選択'}`;
}

function ScopeFields({
  tree,
  scope,
  setScope,
  volumeId,
  setVolumeId,
  chapterId,
  setChapterId,
  disabled,
  radioName,
}: {
  tree: ProjectTree | null;
  scope: 'all' | 'volume' | 'chapter';
  setScope: (value: 'all' | 'volume' | 'chapter') => void;
  volumeId: string;
  setVolumeId: (value: string) => void;
  chapterId: string;
  setChapterId: (value: string) => void;
  disabled: boolean;
  radioName: string;
}) {
  const volume = tree?.volumes.find(item => item.id === volumeId);
  const chapters = volume?.chapters ?? [];
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {tree && <p style={{ margin: 0 }}>作品 {tree.title}</p>}
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend>範囲</legend>
        {(['all', 'volume', 'chapter'] as const).map(value => (
          <label
            key={value}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              minHeight: 44,
              marginRight: 12,
              paddingInline: 4,
              cursor: 'pointer',
            }}
          >
            <input type="radio" name={radioName} checked={scope === value} onChange={() => setScope(value)} disabled={disabled} />
            {value === 'all' ? '全文' : value === 'volume' ? '巻' : '章'}
          </label>
        ))}
      </fieldset>
      {scope !== 'all' && (
        <label style={{ display: 'grid', gap: 4 }}>
          巻
          <select
            style={fieldStyle()}
            value={volumeId}
            onChange={event => setVolumeId(event.target.value)}
            disabled={disabled || !tree?.volumes.length}
          >
            {(tree?.volumes ?? []).map(item => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
      )}
      {scope === 'chapter' && (
        <label style={{ display: 'grid', gap: 4 }}>
          章
          <select
            style={fieldStyle()}
            value={chapterId}
            onChange={event => setChapterId(event.target.value)}
            disabled={disabled || !chapters.length}
          >
            {chapters.map(item => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
      )}
      <p style={{ margin: 0 }} role="status">
        書き出す範囲：{scopeLabel(tree, scope, volumeId, chapterId)}。生成時点で保存済みの本文が対象です。未保存の入力と
        {scope === 'all' ? '作者用ノート' : '選択範囲外の章・作者用ノート'}は含まれません。
      </p>
    </div>
  );
}

function useScopeIds(tree: ProjectTree | null) {
  const [volumeId, setVolumeId] = useState('');
  const [chapterId, setChapterId] = useState('');
  useEffect(() => {
    if (!tree?.volumes.length) return;
    setVolumeId(prior => (tree.volumes.some(item => item.id === prior) ? prior : tree.volumes[0]!.id));
  }, [tree]);
  const volume = tree?.volumes.find(item => item.id === volumeId);
  useEffect(() => {
    const chapters = volume?.chapters ?? [];
    setChapterId(prior => (chapters.some(item => item.id === prior) ? prior : (chapters[0]?.id ?? '')));
  }, [volume]);
  return { volumeId, setVolumeId, chapterId, setChapterId };
}

function downloadBase64(filename: string, contentBase64: string, mediaType: string) {
  const bytes = Uint8Array.from(atob(contentBase64), character => character.charCodeAt(0));
  const blob = new Blob([bytes], { type: mediaType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function ExportPanels({
  contributionId,
  context,
  tree,
  treeError,
}: {
  contributionId: string;
  context: BrowserModuleContext;
  tree: ProjectTree | null;
  treeError: string;
}) {
  const scopeState = useScopeIds(tree);
  const [scope, setScope] = useState<'all' | 'volume' | 'chapter'>('all');
  const verticalScopeState = useScopeIds(tree);
  const [verticalScope, setVerticalScope] = useState<'all' | 'volume' | 'chapter'>('all');
  const [preset, setPreset] = useState('bunko');
  const [preview, setPreview] = useState<string | null>(null);
  const [mode, setMode] = useState<'raw' | 'plain' | 'kakuyomu' | 'narou'>('raw');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const exportInput = useMemo(
    () => ({
      scope,
      ...(scope === 'volume' ? { id: scopeState.volumeId } : scope === 'chapter' ? { id: scopeState.chapterId } : {}),
    }),
    [scope, scopeState.volumeId, scopeState.chapterId],
  );
  const empty = !scopeCount(tree, scope, scope === 'volume' ? scopeState.volumeId : scopeState.chapterId);
  const verticalInput = {
    scope: verticalScope,
    ...(verticalScope === 'volume'
      ? { id: verticalScopeState.volumeId }
      : verticalScope === 'chapter'
        ? { id: verticalScopeState.chapterId }
        : {}),
  };
  const verticalEmpty = !scopeCount(
    tree,
    verticalScope,
    verticalScope === 'volume' ? verticalScopeState.volumeId : verticalScopeState.chapterId,
  );
  async function exportFile(actionId: string, input: Record<string, unknown>, confirmMessage: string) {
    if (!window.confirm(confirmMessage)) return;
    setBusy(actionId);
    setError('');
    setStatus('');
    try {
      const data = await invoke(context, actionId, input);
      downloadBase64(String(data.filename), String(data.contentBase64), String(data.mediaType));
      setStatus('ダウンロードを開始しました');
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy('');
    }
  }

  const sharedScope = (radioName: string) => (
    <ScopeFields tree={tree} scope={scope} setScope={setScope} {...scopeState} disabled={Boolean(busy)} radioName={radioName} />
  );

  return (
    <>
      {contributionId === 'publishing.export.plaintext' && (
        <Panel title="書き出し">
          <p style={{ margin: 0 }}>
            選択した範囲の保存済み本文をテキストファイルに書き出します。読者への受け渡しはファイルを取得した後に行います。
          </p>
          {sharedScope('publishing-plaintext-scope')}
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend>原稿記法</legend>
            {(
              [
                ['raw', 'そのまま'],
                ['plain', '除去（ルビ・傍点）'],
                ['kakuyomu', 'カクヨム向け'],
                ['narou', 'なろう向け'],
              ] as const
            ).map(([value, label]) => (
              <label key={value} style={{ marginRight: 12 }}>
                <input type="radio" name="publishing-plaintext-markup" checked={mode === value} onChange={() => setMode(value)} />
                {label}
              </label>
            ))}
          </fieldset>
          <button
            type="button"
            style={buttonStyle()}
            disabled={Boolean(busy) || empty}
            onClick={() =>
              void exportFile(
                'publishing.export.plaintext',
                {
                  ...exportInput,
                  stripMarkup: mode === 'plain',
                  ...(mode === 'kakuyomu' || mode === 'narou' ? { dialect: mode } : {}),
                },
                '選択した範囲を書き出します。本文をダウンロードしてよいですか？',
              )
            }
          >
            {busy ? '書き出し中…' : 'テキストをダウンロード'}
          </button>
        </Panel>
      )}

      {contributionId === 'publishing.export.epub' && <EpubPanel context={context} tree={tree} treeError={treeError} />}

      {contributionId === 'publishing.export.vertical-print' && (
        <Panel title="縦書き PDF">
          <p style={{ margin: 0 }}>
            選択した範囲の保存済み本文を縦書きで確認できます。PDF ファイルの作成はブラウザーの印刷画面で行います。
          </p>
          <ScopeFields
            tree={tree}
            scope={verticalScope}
            setScope={setVerticalScope}
            {...verticalScopeState}
            disabled={Boolean(busy)}
            radioName="publishing-vertical-scope"
          />
          <label>
            組版
            <select style={fieldStyle()} value={preset} onChange={event => setPreset(event.target.value)}>
              {(['bunko', 'standard', 'wide'] as const).map(item => (
                <option key={item} value={item}>
                  {item === 'bunko' ? '文庫判' : item === 'standard' ? '標準' : 'ゆったり'}
                </option>
              ))}
            </select>
          </label>
          <button type="button" style={buttonStyle()} disabled={Boolean(busy) || verticalEmpty} onClick={() => void makePreview(false)}>
            プレビュー
          </button>
          <button type="button" style={buttonStyle()} disabled={Boolean(busy) || verticalEmpty} onClick={() => void makePreview(true)}>
            印刷 / PDF
          </button>
          {preview !== null && (
            <article
              aria-label="縦書き印刷プレビュー"
              style={{
                writingMode: 'vertical-rl',
                whiteSpace: 'pre-wrap',
                overflowX: 'auto',
                maxHeight: '70vh',
                padding: 16,
                fontFamily: 'serif',
                fontSize: '14px',
                lineHeight: preset === 'bunko' ? 2 : 1.8,
              }}
            >
              {preview || '対象範囲に本文がありません'}
            </article>
          )}
          <Status error={error || treeError} status={status} />
        </Panel>
      )}
    </>
  );

  async function makePreview(print: boolean) {
    setBusy('publishing.export.vertical-print');
    setError('');
    setStatus('');
    try {
      if (print && !window.confirm('選択した範囲を印刷します。印刷ダイアログを開きますか？')) return;
      const data = await invoke(context, 'publishing.export.vertical-print', verticalInput);
      const text = String(data.text ?? '');
      setPreview(text);
      setStatus(text ? (print ? '印刷ダイアログを開きます' : 'プレビューを表示しました') : '対象範囲に本文がありません');
      if (print && text) {
        requestAnimationFrame(() => {
          const printStyle = document.createElement('style');
          printStyle.dataset.publishingPrint = 'true';
          printStyle.textContent =
            "@media print { body * { visibility: hidden !important; } [aria-label='縦書き印刷プレビュー'], [aria-label='縦書き印刷プレビュー'] * { visibility: visible !important; } [aria-label='縦書き印刷プレビュー'] { position: absolute; inset: 0; max-height: none !important; overflow: visible !important; } }";
          document.head.append(printStyle);
          document.body.classList.add('publishing-vertical-printing');
          const cleanup = () => {
            document.body.classList.remove('publishing-vertical-printing');
            printStyle.remove();
            window.removeEventListener('afterprint', cleanup);
          };
          window.addEventListener('afterprint', cleanup);
          window.print();
          window.setTimeout(cleanup, 1000);
        });
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy('');
    }
  }
}

function EpubPanel({ context, tree, treeError }: { context: BrowserModuleContext; tree: ProjectTree | null; treeError: string }) {
  const { volumeId, setVolumeId, chapterId, setChapterId } = useScopeIds(tree);
  const [scope, setScope] = useState<'all' | 'volume' | 'chapter'>('all');
  const [cover, setCover] = useState(false);
  const [coverPath, setCoverPath] = useState(DEFAULT_COVER);
  const [appendix, setAppendix] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const id = scope === 'volume' ? volumeId : scope === 'chapter' ? chapterId : undefined;
  const empty = !scopeCount(tree, scope, id);
  async function download() {
    if (!window.confirm('選択した範囲から EPUB3 ファイルを作成してダウンロードします。続けますか？')) return;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const data = await invoke(context, 'publishing.export.epub', {
        scope,
        ...(id ? { id } : {}),
        ...(cover ? { coverPath: coverPath.trim() || DEFAULT_COVER } : {}),
        includeBibleAppendix: appendix,
      });
      downloadBase64(String(data.filename), String(data.contentBase64), String(data.mediaType));
      setStatus('ダウンロードを開始しました');
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel title="EPUB 書き出し">
      <p style={{ margin: 0 }}>
        選択した範囲の保存済み本文を、目次・ルビ・傍点を含む EPUB3
        ファイルに書き出します。読者への受け渡しはファイルを取得した後に行います。
      </p>
      <ScopeFields
        tree={tree}
        scope={scope}
        setScope={setScope}
        volumeId={volumeId}
        setVolumeId={setVolumeId}
        chapterId={chapterId}
        setChapterId={setChapterId}
        disabled={busy}
        radioName="publishing-epub-scope"
      />
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minHeight: 44 }}>
        <input type="checkbox" checked={cover} onChange={event => setCover(event.target.checked)} />
        表紙を含める
      </label>
      {cover && (
        <label style={{ display: 'grid', gap: 4 }}>
          表紙パス
          <input style={fieldStyle()} value={coverPath} onChange={event => setCoverPath(event.target.value)} spellCheck={false} />
          <small>プロジェクトルート相対です。ファイルが無ければ表紙なしで出力します。</small>
        </label>
      )}
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minHeight: 44 }}>
        <input type="checkbox" checked={appendix} onChange={event => setAppendix(event.target.checked)} />
        図鑑付録（登場人物・設定・場所）を含める
      </label>
      {appendix && (
        <p role="status" style={{ margin: 0 }}>
          図鑑付録を含める設定です。本文とは別に付録の内容も確認してから渡してください。
        </p>
      )}
      <button type="button" style={buttonStyle()} disabled={busy || empty} onClick={() => void download()}>
        {busy ? '書き出し中…' : 'EPUB をダウンロード'}
      </button>
      <Status error={error || treeError} status={status} />
    </Panel>
  );
}

function EpisodeMapPanel({ context, tree }: { context: BrowserModuleContext; tree: ProjectTree | null }) {
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const selectedEpisode = episodes.find(episode => episode.id === selected) ?? null;
  useEffect(() => {
    let alive = true;
    void invoke(context, 'publishing.episodes.read', {})
      .then(data => {
        if (!alive) return;
        const loaded = Array.isArray(data.episodes) ? (data.episodes as Episode[]) : [];
        setEpisodes(loaded);
        setSelected(loaded[0]?.id ?? '');
      })
      .catch(cause => {
        if (alive) setError(messageOf(cause));
      });
    return () => {
      alive = false;
    };
  }, [context]);

  function patchSelected(patch: Partial<Episode>) {
    setEpisodes(items => items.map(item => (item.id === selected ? { ...item, ...patch } : item)));
    setStatus('');
  }
  function addEpisode() {
    const defaultChapter = tree?.volumes[0]?.chapters[0];
    if (!defaultChapter) return;
    const episode = {
      id: 'pe-' + crypto.randomUUID().slice(0, 8),
      number: Math.max(0, ...episodes.map(item => item.number)) + 1,
      title: '',
      scope: 'chapter' as const,
      scopeId: defaultChapter.id,
    };
    setEpisodes(items => [...items, episode]);
    setSelected(episode.id);
  }
  async function save() {
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const data = await invoke(context, 'publishing.episodes.propose', { episodes });
      if (Array.isArray(data.episodes)) setEpisodes(data.episodes as Episode[]);
      setStatus('変更をレビューに追加しました。作者が承認して適用すると反映されます。');
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }
  const availableVolumes = tree?.volumes ?? [];
  const selectedVolume =
    selectedEpisode?.scope === 'volume'
      ? selectedEpisode.scopeId
      : (availableVolumes.find(volume => volume.chapters.some(chapter => chapter.id === selectedEpisode?.scopeId))?.id ?? '');
  const selectedChapters = availableVolumes.find(volume => volume.id === selectedVolume)?.chapters ?? [];
  return (
    <Panel title="公開回マッピング">
      <p style={{ margin: 0 }}>投稿サイトの話数と巻・章の対応を保存します。公開日は原稿メタデータとして保持されます。</p>
      <div style={{ display: 'flex', gap: 16, alignItems: 'start' }}>
        <div>
          <ul style={{ listStyle: 'none', padding: 0, maxHeight: 240, overflow: 'auto' }}>
            {episodes.length ? (
              episodes.map(episode => (
                <li key={episode.id}>
                  <button
                    type="button"
                    style={buttonStyle()}
                    aria-pressed={episode.id === selected}
                    onClick={() => setSelected(episode.id)}
                  >
                    第{episode.number}話{episode.title ? ' · ' + episode.title : ''}
                  </button>
                </li>
              ))
            ) : (
              <li>まだありません</li>
            )}
          </ul>
          <button
            type="button"
            style={buttonStyle()}
            disabled={busy || !tree?.volumes.some(volume => volume.chapters.length)}
            onClick={addEpisode}
          >
            追加
          </button>
          <button
            type="button"
            style={buttonStyle(true)}
            disabled={busy || !selected}
            onClick={() => {
              const next = episodes.filter(episode => episode.id !== selected);
              setEpisodes(next);
              setSelected(next[0]?.id ?? '');
            }}
          >
            削除
          </button>
        </div>
        {selectedEpisode && (
          <div style={{ display: 'grid', gap: 8, flex: 1 }}>
            <label>
              話数{' '}
              <input
                style={fieldStyle()}
                type="number"
                min={1}
                value={selectedEpisode.number}
                onChange={event => patchSelected({ number: Math.max(1, Number(event.target.value) || 1) })}
              />
            </label>
            <label>
              タイトル{' '}
              <input style={fieldStyle()} value={selectedEpisode.title} onChange={event => patchSelected({ title: event.target.value })} />
            </label>
            <label>
              公開日{' '}
              <input
                style={fieldStyle()}
                type="date"
                value={selectedEpisode.publishedAt?.slice(0, 10) ?? ''}
                onChange={event => patchSelected({ publishedAt: event.target.value || null })}
              />
            </label>
            <label>
              範囲
              <select
                style={fieldStyle()}
                value={selectedEpisode.scope}
                onChange={event => {
                  const nextScope = event.target.value as 'volume' | 'chapter';
                  const nextVolume = availableVolumes[0];
                  patchSelected({
                    scope: nextScope,
                    scopeId: nextScope === 'volume' ? (nextVolume?.id ?? '') : (nextVolume?.chapters[0]?.id ?? ''),
                  });
                }}
              >
                <option value="volume">巻</option>
                <option value="chapter">章</option>
              </select>
            </label>
            {selectedEpisode.scope === 'volume' ? (
              <label>
                巻{' '}
                <select
                  style={fieldStyle()}
                  value={selectedEpisode.scopeId}
                  onChange={event => patchSelected({ scopeId: event.target.value })}
                >
                  {availableVolumes.map(volume => (
                    <option key={volume.id} value={volume.id}>
                      {volume.title}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <>
                <label>
                  巻{' '}
                  <select
                    style={fieldStyle()}
                    value={selectedVolume}
                    onChange={event => {
                      const volume = availableVolumes.find(item => item.id === event.target.value);
                      patchSelected({ scopeId: volume?.chapters[0]?.id ?? '' });
                    }}
                  >
                    {availableVolumes.map(volume => (
                      <option key={volume.id} value={volume.id}>
                        {volume.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  章{' '}
                  <select
                    style={fieldStyle()}
                    value={selectedEpisode.scopeId}
                    onChange={event => patchSelected({ scopeId: event.target.value })}
                  >
                    {selectedChapters.map(chapter => (
                      <option key={chapter.id} value={chapter.id}>
                        {chapter.title}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
            {selectedEpisode.scope === 'chapter' && (
              <fieldset>
                <legend>シーン注釈</legend>
                {(selectedChapters.find(chapter => chapter.id === selectedEpisode.scopeId)?.scenes ?? []).map(scene => {
                  const current = selectedEpisode.sceneIds ?? [];
                  return (
                    <label key={scene.id} style={{ display: 'block' }}>
                      <input
                        type="checkbox"
                        checked={current.includes(scene.id)}
                        onChange={() => {
                          const next = current.includes(scene.id) ? current.filter(id => id !== scene.id) : [...current, scene.id];
                          patchSelected({ sceneIds: next.length ? next : null });
                        }}
                      />
                      {scene.title}
                    </label>
                  );
                })}
              </fieldset>
            )}
          </div>
        )}
      </div>
      <button type="button" style={buttonStyle()} disabled={busy} onClick={() => void save()}>
        {busy ? '保存中…' : 'レビューに保存'}
      </button>
      <Status error={error} status={status} />
    </Panel>
  );
}

function ShareLinksPanel({ context, tree }: { context: BrowserModuleContext; tree: ProjectTree | null }) {
  const [shares, setShares] = useState<ShareInfo[]>([]);
  const [kind, setKind] = useState<'volume' | 'chapter' | 'scene'>('chapter');
  const [scopeId, setScopeId] = useState('');
  const [label, setLabel] = useState('');
  const [hours, setHours] = useState('24');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [revealed, setRevealed] = useState<{ url: string; proposalId: string; target: string } | null>(null);
  const readerOrigin = publicReaderOrigin({ currentOrigin: window.location.origin });
  const targets = useMemo(() => {
    const volumes = tree?.volumes ?? [];
    return {
      volume: volumes.map(({ id, title }) => ({ id, title })),
      chapter: volumes.flatMap(volume =>
        volume.chapters.map(chapter => ({
          id: chapter.id,
          title: volume.title + ' / ' + chapter.title,
        })),
      ),
      scene: [
        ...(tree?.rootScenes ?? []).map(scene => ({ id: scene.id, title: '作品直下 / ' + scene.title })),
        ...volumes.flatMap(volume =>
          volume.chapters.flatMap(chapter =>
            chapter.scenes.map(scene => ({
              id: scene.id,
              title: volume.title + ' / ' + chapter.title + ' / ' + scene.title,
            })),
          ),
        ),
      ],
    };
  }, [tree]);
  const options = targets[kind];

  const reload = useCallback(async () => {
    const data = await invoke(context, 'publishing.shares.list', {});
    setShares(Array.isArray(data.shares) ? (data.shares as ShareInfo[]) : []);
  }, [context]);
  useEffect(() => {
    void reload().catch(cause => setError(messageOf(cause)));
  }, [reload]);
  useEffect(() => {
    if (options.some(item => item.id === scopeId)) return;
    setScopeId(options[0]?.id ?? '');
  }, [options, scopeId]);

  async function create() {
    const target = options.find(item => item.id === scopeId);
    if (!target) {
      setError('共有範囲を選択してください');
      return;
    }
    if (!readerOrigin) {
      setError('公開読者サイトのHTTPS URLが未設定のため、配布用リンクを作成できません。');
      return;
    }
    setBusy(true);
    setError('');
    setStatus('');
    setRevealed(null);
    try {
      const data = await invoke(context, 'publishing.shares.create', { kind, id: scopeId, label, expiresInHours: Number(hours) });
      const token = String(data.token);
      const url = publicReaderUrl(readerOrigin, context.snapshot.projectId, token);
      setRevealed({ url, proposalId: String(data.proposalId), target: target.title });
      setStatus('リンク発行の提案を作成しました。');
      setLabel('');
      await reload().catch(cause => setError(messageOf(cause)));
    } catch (cause) {
      setError('リンク発行の結果を確認できません。レビューと共有リンク一覧で対象を確認してください。 ' + messageOf(cause));
    } finally {
      setBusy(false);
    }
  }
  async function revoke(id: string) {
    if (!window.confirm('この共有リンクを失効する変更をレビューに追加しますか？')) return;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      await invoke(context, 'publishing.shares.revoke', { id });
      setStatus('リンク失効の提案を作成しました。承認して適用すると、以後のリンク経由の閲覧が止まります。');
      await reload();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel title="読み取り専用共有リンク">
      <p style={{ margin: 0 }}>
        読者は有効期限まで、選択した範囲の保存済み本文を閲覧できます。公開中に原稿を保存すると、読者がアクセスしたときの本文も変わります。
      </p>
      <p style={{ margin: 0 }}>リンクが失効すると、以後のリンク経由の閲覧が止まります。読者がすでに保存したコピーは手元に残ります。</p>
      {!readerOrigin && <p role="status">公開読者サイトのHTTPS URLが未設定のため、配布用リンクを作成できません。</p>}
      {revealed && (
        <div style={{ border: '1px solid #547a40', padding: 10, overflowWrap: 'anywhere' }}>
          <p>
            <strong>発行提案中：{revealed.target}</strong>
          </p>
          <p>
            提案作成時点では読者はまだ開けません。「レビュー」作業面で提案 {revealed.proposalId}{' '}
            を承認・適用し、共有リンク一覧が「公開済み」になったことを確認してから渡してください。
          </p>
          <p>URLは今回だけ表示されます。閉じる前に控えてください。</p>
          <code>{revealed.url}</code>
          <button type="button" style={buttonStyle()} onClick={() => setRevealed(null)}>
            閉じる
          </button>
        </div>
      )}
      <form
        onSubmit={event => {
          event.preventDefault();
          void create();
        }}
        style={{ display: 'grid', gap: 8 }}
      >
        {tree && <p style={{ margin: 0 }}>作品 {tree.title}</p>}
        <label>
          範囲
          <select style={fieldStyle()} value={kind} onChange={event => setKind(event.target.value as typeof kind)}>
            <option value="volume">巻</option>
            <option value="chapter">章</option>
            <option value="scene">節</option>
          </select>
        </label>
        <label>
          対象
          <select style={fieldStyle()} value={scopeId} onChange={event => setScopeId(event.target.value)} disabled={!options.length}>
            {options.map(item => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          表示名 <input style={fieldStyle()} value={label} onChange={event => setLabel(event.target.value)} maxLength={120} />
        </label>
        <label>
          提案作成からの有効時間（時間）{' '}
          <input style={fieldStyle()} type="number" min={1} max={87600} value={hours} onChange={event => setHours(event.target.value)} />
        </label>
        <p role="status" style={{ margin: 0 }}>
          発行予定：{tree?.title ?? '作品を確認中'}／{options.find(item => item.id === scopeId)?.title ?? '範囲未選択'}
          。有効時間は提案作成時点から{hours || '未設定'}
          時間です。承認・適用するまで読者は開けません。公開後は作品に保存した本文の更新が閲覧に反映されます。作者用ノートと選択範囲外の本文は公開されません。
        </p>
        <button type="submit" style={buttonStyle()} disabled={busy || !readerOrigin || !options.some(item => item.id === scopeId)}>
          {busy ? '準備中…' : 'リンク発行の提案を作成'}
        </button>
      </form>
      <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 8 }}>
        {shares.map(share => {
          const scope = share.scope;
          const title =
            typeof scope === 'string'
              ? (Object.values(targets)
                  .flat()
                  .find(item => item.id === scope)?.title ?? scope)
              : scope.kind === 'project'
                ? (tree?.title ?? scope.id)
                : (targets[scope.kind].find(item => item.id === scope.id)?.title ?? scope.id);
          const state = share.revokedAt ? '失効済み' : share.active ? '公開済み' : '期限切れ';
          return (
            <li key={share.id} style={{ border: '1px solid #aaa', padding: 8, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span>
                <strong>{share.label || title}</strong>
                <br />
                {title}
                <br />
                {share.tokenPrefix ? share.tokenPrefix + '…' : share.id.slice(0, 8)} · {new Date(share.expiresAt).toLocaleString('ja-JP')}
                <br />
                <span>{state}</span>
              </span>
              {!share.revokedAt && (
                <button type="button" style={buttonStyle(true)} disabled={busy} onClick={() => void revoke(share.id)}>
                  失効の提案
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <Status error={error} status={status} />
    </Panel>
  );
}

function Status({ error, status }: { error: string; status: string }) {
  return (
    <>
      {error && (
        <p role="alert" style={{ color: '#a41426', margin: 0 }}>
          {error}
        </p>
      )}
      {status && (
        <p role="status" style={{ margin: 0 }}>
          {status}
        </p>
      )}
    </>
  );
}

function SettingsView({ contributionId, context }: { contributionId: string; context: BrowserModuleContext }) {
  const { tree, treeError } = usePublishingContext(context);
  return (
    <div style={{ display: 'grid', gap: 12, maxWidth: 960 }}>
      {treeError && <Status error={treeError} status="" />}
      {contributionId.startsWith('publishing.export.') && (
        <ExportPanels contributionId={contributionId} context={context} tree={tree} treeError={treeError} />
      )}
      {contributionId === 'publishing.episode-map' && <EpisodeMapPanel context={context} tree={tree} />}
      {contributionId === 'publishing.share-links' && <ShareLinksPanel context={context} tree={tree} />}
    </div>
  );
}

function ShareReaderView({ source }: { source: PublicShareReaderSource }) {
  const [metadata, setMetadata] = useState<PublicShareReaderIndex | null>(null);
  const [scene, setScene] = useState<PublicShareReaderScene | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    const robots = document.createElement('meta');
    robots.name = 'robots';
    robots.content = 'noindex, nofollow';
    document.head.appendChild(robots);
    const referrer = document.createElement('meta');
    referrer.name = 'referrer';
    referrer.content = 'no-referrer';
    document.head.appendChild(referrer);
    return () => {
      robots.remove();
      referrer.remove();
    };
  }, []);
  useEffect(() => {
    let alive = true;
    void source
      .loadIndex()
      .then(data => {
        if (alive) setMetadata(data);
      })
      .catch(() => {
        if (alive) setError('共有リンクは無効か、期限切れです。');
      });
    return () => {
      alive = false;
    };
  }, [source]);
  async function openScene(id: string) {
    setBusy(true);
    setError('');
    try {
      setScene(await source.loadScene(id));
    } catch {
      if (alive.current) setError('このシーンは共有範囲にありません。');
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const tree = metadata?.tree ?? [];
  const rootScenes = metadata?.rootScenes ?? [];
  return (
    <main style={{ maxWidth: 760, margin: '2rem auto', padding: '0 1rem', lineHeight: 1.8 }}>
      <h1>{String(metadata?.label ?? '共有された原稿')}</h1>
      <p>読み取り専用の共有です。期限: {metadata?.expiresAt ? new Date(String(metadata.expiresAt)).toLocaleString('ja-JP') : ''}</p>
      {rootScenes.length > 0 && (
        <section aria-label="作品直下のシーン">
          <h2>作品直下</h2>
          <ul>
            {rootScenes.map(item => (
              <li key={item.id}>
                <button type="button" style={buttonStyle()} disabled={busy} onClick={() => void openScene(item.id)}>
                  {item.title}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {tree.map(volume => (
        <section key={volume.volume.title}>
          <h2>{volume.volume.title}</h2>
          {volume.chapters.map(chapter => (
            <div key={chapter.chapter.title}>
              <h3>{chapter.chapter.title}</h3>
              <ul>
                {chapter.scenes.map(item => (
                  <li key={item.id}>
                    <button type="button" style={buttonStyle()} disabled={busy} onClick={() => void openScene(item.id)}>
                      {item.title}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ))}
      {scene && (
        <article style={{ whiteSpace: 'pre-wrap', borderTop: '1px solid #aaa', paddingTop: 16 }}>
          <h2>{scene.title}</h2>
          {scene.body}
        </article>
      )}
      <Status error={error} status="" />
    </main>
  );
}

function MountView({ contributionId, context }: { contributionId: string; context: BrowserModuleContext }) {
  return <SettingsView contributionId={contributionId} context={context} />;
}

export const browserModule: BrowserModuleDefinition = {
  async mount(contributionId: string, element: HTMLElement, context: BrowserModuleContext): Promise<() => void> {
    const root = createRoot(element);
    root.render(createElement(MountView, { contributionId, context }));
    return () => root.unmount();
  },
  async mountPublic(viewId: string, element: HTMLElement, _request: Request, source?: PublicShareReaderSource): Promise<() => void> {
    if (viewId !== 'share') throw new Error('Unknown public publishing view');
    if (!source) throw new Error('Invalid publication share route');
    const root = createRoot(element);
    root.render(createElement(ShareReaderView, { source }));
    return () => root.unmount();
  },
};
