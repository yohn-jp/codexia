import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { BrowserJournal, ScratchPayloadReference, ScratchPayloadWrite, ScratchSnapshot } from '../storage/journal';

interface ScratchNoteRequest {
  idempotencyKey: string;
  orderKey: string;
  markdown: string;
  contentGeneration: number;
}
interface ScratchImage {
  id: string;
  name: string;
  data: string;
}
interface Scratch {
  text: string;
  images: ScratchImage[];
  generation: number;
  contentGeneration: number;
  pendingNoteRequest?: ScratchNoteRequest;
}
interface ScratchMetadata {
  format: 'codexia-scratch/v2';
  text: string;
  images: Array<{ id: string; name: string }>;
  generation: number;
  contentGeneration: number;
  pendingNoteRequest?: { idempotencyKey: string; orderKey: string; contentGeneration: number };
}
interface ProtectedScratch {
  revision: string;
  generation: number;
  imageIds: Set<string>;
  pendingNoteId?: string;
}
const empty = (): Scratch => ({ text: '', images: [], generation: 0, contentGeneration: 0 });

export interface ScratchGuard {
  protect(): Promise<void>;
  hasUnprotectedInput(): boolean;
}

function scratchMarkdown(value: Pick<Scratch, 'text' | 'images'>): string {
  return value.text + value.images.map(image => `\n\n![${image.name.replace(/[[\]\\]/gu, '')}](${image.data})`).join('');
}

function scratchMetadata(value: Scratch): string {
  const metadata: ScratchMetadata = {
    format: 'codexia-scratch/v2',
    text: value.text,
    images: value.images.map(({ id, name }) => ({ id, name })),
    generation: value.generation,
    contentGeneration: value.contentGeneration,
    ...(value.pendingNoteRequest
      ? {
          pendingNoteRequest: {
            idempotencyKey: value.pendingNoteRequest.idempotencyKey,
            orderKey: value.pendingNoteRequest.orderKey,
            contentGeneration: value.pendingNoteRequest.contentGeneration,
          },
        }
      : {}),
  };
  return JSON.stringify(metadata);
}

function restoreScratch(snapshot: ScratchSnapshot | null): { draft: Scratch; protected: ProtectedScratch } {
  if (!snapshot) return { draft: empty(), protected: { revision: '', generation: 0, imageIds: new Set() } };
  const parsed: unknown = JSON.parse(snapshot.text);
  if (!parsed || typeof parsed !== 'object') throw new Error('スクラッチの回復記録を確認できませんでした。元の記録は保持しています。');
  const candidate = parsed as Record<string, unknown>;
  const payloadById = new Map(snapshot.payloads.map(payload => [`${payload.kind}\0${payload.id}`, payload.value]));
  if (payloadById.size !== snapshot.payloads.length)
    throw new Error('スクラッチの回復記録を確認できませんでした。元の記録は保持しています。');

  if (candidate.format === 'codexia-scratch/v2') {
    if (
      typeof candidate.text !== 'string' ||
      !Array.isArray(candidate.images) ||
      !Number.isSafeInteger(candidate.generation) ||
      (candidate.generation as number) < 0 ||
      !Number.isSafeInteger(candidate.contentGeneration) ||
      (candidate.contentGeneration as number) < 0
    ) {
      throw new Error('スクラッチの回復記録を確認できませんでした。元の記録は保持しています。');
    }
    const imageIds = new Set<string>();
    const images: ScratchImage[] = [];
    for (const item of candidate.images) {
      if (
        !item ||
        typeof item !== 'object' ||
        !('id' in item) ||
        typeof item.id !== 'string' ||
        !item.id ||
        !('name' in item) ||
        typeof item.name !== 'string' ||
        imageIds.has(item.id)
      ) {
        throw new Error('スクラッチの回復記録を確認できませんでした。元の記録は保持しています。');
      }
      const data = payloadById.get(`image\0${item.id}`);
      if (typeof data !== 'string' || !data.startsWith('data:image/')) {
        throw new Error('添付画像の回復記録を確認できませんでした。元の記録は保持しています。');
      }
      imageIds.add(item.id);
      images.push({ id: item.id, name: item.name, data });
    }
    let pendingNoteRequest: ScratchNoteRequest | undefined;
    let pendingNoteId: string | undefined;
    if (candidate.pendingNoteRequest !== undefined) {
      const pending = candidate.pendingNoteRequest;
      if (
        !pending ||
        typeof pending !== 'object' ||
        !('idempotencyKey' in pending) ||
        typeof pending.idempotencyKey !== 'string' ||
        !pending.idempotencyKey ||
        !('orderKey' in pending) ||
        typeof pending.orderKey !== 'string' ||
        !pending.orderKey ||
        !('contentGeneration' in pending) ||
        !Number.isSafeInteger(pending.contentGeneration)
      ) {
        throw new Error('スクラッチの回復記録を確認できませんでした。元の記録は保持しています。');
      }
      const markdown = payloadById.get(`pending-note\0${pending.idempotencyKey}`);
      if (typeof markdown !== 'string')
        throw new Error('前回のノート保存に使った回復記録を確認できませんでした。元の記録は保持しています。');
      pendingNoteId = pending.idempotencyKey;
      pendingNoteRequest = {
        idempotencyKey: pending.idempotencyKey,
        orderKey: pending.orderKey,
        contentGeneration: pending.contentGeneration as number,
        markdown,
      };
    }
    return {
      draft: {
        text: candidate.text,
        images,
        generation: candidate.generation as number,
        contentGeneration: candidate.contentGeneration as number,
        ...(pendingNoteRequest ? { pendingNoteRequest } : {}),
      },
      protected: {
        revision: snapshot.revision,
        generation: candidate.generation as number,
        imageIds,
        ...(pendingNoteId ? { pendingNoteId } : {}),
      },
    };
  }

  const legacy = candidate as unknown as { text?: unknown; images?: unknown; generation?: unknown; pendingNoteRequest?: unknown };
  if (
    typeof legacy.text !== 'string' ||
    !Array.isArray(legacy.images) ||
    !legacy.images.every(
      item =>
        item &&
        typeof item === 'object' &&
        'name' in item &&
        typeof item.name === 'string' &&
        'data' in item &&
        typeof item.data === 'string' &&
        item.data.startsWith('data:image/'),
    ) ||
    !Number.isSafeInteger(legacy.generation) ||
    (legacy.generation as number) < 0
  ) {
    throw new Error('スクラッチの回復記録を確認できませんでした。元の記録は保持しています。');
  }
  const images = (legacy.images as Array<{ name: string; data: string }>).map(item => ({ ...item, id: crypto.randomUUID() }));
  const generation = legacy.generation as number;
  const draft: Scratch = { text: legacy.text, images, generation, contentGeneration: generation };
  if (legacy.pendingNoteRequest !== undefined) {
    const pending = legacy.pendingNoteRequest as Partial<ScratchNoteRequest> | null;
    if (
      !pending ||
      typeof pending.idempotencyKey !== 'string' ||
      !pending.idempotencyKey ||
      typeof pending.orderKey !== 'string' ||
      !pending.orderKey ||
      typeof pending.markdown !== 'string'
    ) {
      throw new Error('スクラッチの回復記録を確認できませんでした。元の記録は保持しています。');
    }
    draft.pendingNoteRequest = {
      idempotencyKey: pending.idempotencyKey,
      orderKey: pending.orderKey,
      markdown: pending.markdown,
      contentGeneration: -1,
    };
    if (pending.markdown === scratchMarkdown(draft)) draft.pendingNoteRequest.contentGeneration = draft.contentGeneration;
  }
  return { draft, protected: { revision: snapshot.revision, generation, imageIds: new Set() } };
}

/** Private scratch remains outside the manuscript until explicitly saved as a note. */
export function PersistenceScratch({
  projectId,
  documentId,
  authorScope,
  journal,
  canCreateNote,
  registerGuard,
  onSaved,
}: {
  projectId: string;
  documentId: string;
  authorScope: string;
  journal: BrowserJournal;
  canCreateNote: boolean;
  registerGuard(guard: ScratchGuard | null): void;
  onSaved(): Promise<void>;
}) {
  const [draft, setDraft] = useState<Scratch>(empty);
  const draftRef = useRef(draft);
  const [error, setError] = useState('');
  const [attachmentError, setAttachmentError] = useState('');
  const [protectedGeneration, setProtectedGeneration] = useState(-1);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const pendingRead = useRef<Promise<void>>(Promise.resolve());
  const pendingAttachments = useRef(0);
  const saveTail = useRef<Promise<void>>(Promise.resolve());
  const protectedScratch = useRef<ProtectedScratch | null>(null);
  const path = `scratch/${documentId}`;
  function publish(value: Scratch) {
    draftRef.current = value;
    setDraft(value);
  }
  function hasUnprotectedInput(): boolean {
    const current = draftRef.current;
    const known = protectedScratch.current;
    return pendingAttachments.current > 0 || Boolean(known && current.generation > known.generation);
  }
  async function protect(): Promise<void> {
    let read = pendingRead.current;
    await read;
    while (pendingRead.current !== read) {
      read = pendingRead.current;
      await read;
    }
    const current = draftRef.current;
    const known = protectedScratch.current;
    if (!known || current.generation <= known.generation) return;
    const task = saveTail.current
      .catch(() => {})
      .then(async () => {
        const base = protectedScratch.current;
        if (!base || current.generation <= base.generation) return;
        const text = scratchMetadata(current);
        const payloadsToWrite: ScratchPayloadWrite[] = [
          ...current.images
            .filter(item => !base.imageIds.has(item.id))
            .map(({ id, data }) => ({ kind: 'image' as const, id, value: data })),
          ...(current.pendingNoteRequest && current.pendingNoteRequest.idempotencyKey !== base.pendingNoteId
            ? [{ kind: 'pending-note' as const, id: current.pendingNoteRequest.idempotencyKey, value: current.pendingNoteRequest.markdown }]
            : []),
        ];
        const payloadsToDelete: ScratchPayloadReference[] =
          base.pendingNoteId && current.pendingNoteRequest?.idempotencyKey !== base.pendingNoteId
            ? [{ kind: 'pending-note', id: base.pendingNoteId }]
            : [];
        const revision = await journal.putScratch(projectId, path, text, authorScope, base.revision, payloadsToWrite, payloadsToDelete);
        if (!revision) {
          throw new Error('別タブでスクラッチが更新されました。現在の入力を保持しています。');
        }
        protectedScratch.current = {
          revision,
          generation: current.generation,
          imageIds: new Set(current.images.map(({ id }) => id)),
          ...(current.pendingNoteRequest ? { pendingNoteId: current.pendingNoteRequest.idempotencyKey } : {}),
        };
      });
    saveTail.current = task;
    try {
      await task;
      setProtectedGeneration(current.generation);
      setError('');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'スクラッチを保護できませんでした。';
      setError(message);
      throw cause;
    }
    if (pendingRead.current !== read || draftRef.current.generation !== current.generation)
      throw new Error('スクラッチに新しい入力があります。記録が完了してから再試行してください。');
  }
  const protectRef = useRef(protect);
  protectRef.current = protect;
  useEffect(() => {
    let cancelled = false;
    void journal
      .getScratch(projectId, path, authorScope)
      .then(snapshot => {
        if (cancelled) return;
        const restored = restoreScratch(snapshot);
        protectedScratch.current = restored.protected;
        publish(restored.draft);
        setProtectedGeneration(restored.draft.generation);
        setLoading(false);
      })
      .catch(cause => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'スクラッチを読み込めませんでした。');
      });
    registerGuard({ protect: () => protectRef.current(), hasUnprotectedInput });
    return () => {
      cancelled = true;
      registerGuard(null);
    };
  }, [journal, projectId, path, authorScope, registerGuard]);
  useEffect(() => {
    if (!loading && draft.generation > 0) void protectRef.current().catch(() => {});
  }, [draft.generation, loading]);
  async function attach(files: File[]) {
    if (!files.length) return;
    pendingAttachments.current += 1;
    setAttachmentError('');
    const task = pendingRead.current.then(async () => {
      let total = draftRef.current.images.reduce((sum, item) => sum + item.data.length * 0.75, 0);
      const images: Scratch['images'] = [];
      for (const file of files) {
        if (!file.type.startsWith('image/') || file.size > 3 * 1024 * 1024) throw new Error('画像は1件3MB以下で添付してください。');
        total += file.size;
        if (total > 5 * 1024 * 1024) throw new Error('添付画像の合計は5MB以下にしてください。');
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () =>
            typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('画像を読み込めませんでした。'));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        });
        images.push({ id: crypto.randomUUID(), name: file.name, data });
      }
      const current = draftRef.current;
      publish({
        ...current,
        images: [...current.images, ...images],
        generation: current.generation + 1,
        contentGeneration: current.contentGeneration + 1,
      });
    });
    // A rejected attachment does not invalidate the existing scratch draft.
    const settled = task.catch(() => {});
    pendingRead.current = settled;
    try {
      await task;
    } catch (cause) {
      if (pendingRead.current === settled) setAttachmentError(cause instanceof Error ? cause.message : '画像を読み込めませんでした。');
      return;
    } finally {
      pendingAttachments.current -= 1;
    }
    await protectRef.current().catch(() => {});
  }
  async function saveNote() {
    if (!canCreateNote) return;
    setSaving(true);
    try {
      await protect();
      let current = draftRef.current;
      let request = current.pendingNoteRequest;
      if (!request) {
        request = {
          idempotencyKey: crypto.randomUUID(),
          orderKey: String(Date.now()),
          markdown: scratchMarkdown(current),
          contentGeneration: current.contentGeneration,
        };
        current = { ...current, pendingNoteRequest: request, generation: current.generation + 1 };
        publish(current);
        await protect();
      }
      await api.createPersistenceDocument(projectId, {
        parentId: documentId as never,
        title: 'スクラッチ',
        kind: 'note',
        orderKey: request.orderKey,
        markdown: request.markdown,
        idempotencyKey: request.idempotencyKey,
      });
      await onSaved();
      const latest = draftRef.current;
      if (latest.pendingNoteRequest?.idempotencyKey === request.idempotencyKey) {
        publish({ ...latest, pendingNoteRequest: undefined, generation: latest.generation + 1 });
        try {
          await protect();
        } catch (cause) {
          const unconfirmed = draftRef.current;
          if (!unconfirmed.pendingNoteRequest)
            publish({ ...unconfirmed, pendingNoteRequest: request, generation: unconfirmed.generation + 1 });
          throw cause;
        }
      }
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'スクラッチを保存できませんでした。');
    } finally {
      setSaving(false);
    }
  }
  const pendingMatchesCurrent = Boolean(draft.pendingNoteRequest && draft.pendingNoteRequest.contentGeneration === draft.contentGeneration);
  return (
    <details className="scratch-panel">
      <summary>スクラッチ · {protectedGeneration === draft.generation ? 'Draft を保護済み' : '記録中'}</summary>
      <label htmlFor="pg-scratch">本文に含まれないメモ</label>
      <textarea
        id="pg-scratch"
        value={draft.text}
        disabled={loading || saving}
        onChange={event =>
          publish({
            ...draftRef.current,
            text: event.target.value,
            generation: draftRef.current.generation + 1,
            contentGeneration: draftRef.current.contentGeneration + 1,
          })
        }
      />
      <label>
        画像を添付
        <input
          aria-label="スクラッチ画像を添付"
          type="file"
          accept="image/*"
          multiple
          disabled={loading || saving}
          onChange={event => {
            void attach(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
      </label>
      {draft.images.map(image => (
        <img key={image.id} src={image.data} alt={image.name} width="120" />
      ))}
      <button type="button" disabled={loading || saving} onClick={() => void protect().catch(() => {})}>
        続ける
      </button>
      {draft.pendingNoteRequest && !pendingMatchesCurrent && (
        <p role="status">前回送信した内容の保存結果が未確認です。照合では現在のスクラッチを保持します。</p>
      )}
      <button
        type="button"
        disabled={!canCreateNote || loading || saving || (!draft.text && !draft.images.length && !draft.pendingNoteRequest)}
        onClick={() => void saveNote()}
      >
        {draft.pendingNoteRequest
          ? pendingMatchesCurrent
            ? 'ノート保存を再試行'
            : '前のノート保存を照合'
          : 'ノートとしてPostgreSQLへ保存'}
      </button>
      {attachmentError && <p role="alert">{attachmentError}</p>}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
