import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { BrowserJournal } from "../storage/journal";

interface ScratchNoteRequest { idempotencyKey: string; orderKey: string; markdown: string }
interface Scratch { text: string; images: Array<{ name: string; data: string }>; generation: number; pendingNoteRequest?: ScratchNoteRequest }
const empty = (): Scratch => ({ text: "", images: [], generation: 0 });

function scratchMarkdown(value: Pick<Scratch, "text" | "images">): string {
  return value.text + value.images.map((image) => `\n\n![${image.name.replace(/[\[\]\\]/gu, "")}](${image.data})`).join("");
}

/** Private scratch remains outside the manuscript until explicitly saved as a note. */
export function PersistenceScratch({ projectId, documentId, authorScope, journal, canCreateNote, registerGuard, onSaved }: {
  projectId: string; documentId: string; authorScope: string; journal: BrowserJournal; canCreateNote: boolean;
  registerGuard(guard: (() => Promise<void>) | null): void; onSaved(): Promise<void>;
}) {
  const [draft, setDraft] = useState<Scratch>(empty);
  const draftRef = useRef(draft);
  const [error, setError] = useState("");
  const [attachmentError, setAttachmentError] = useState("");
  const [protectedGeneration, setProtectedGeneration] = useState(-1);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const pendingRead = useRef<Promise<void>>(Promise.resolve());
  const saveTail = useRef<Promise<void>>(Promise.resolve());
  const protectedScratch = useRef<{ text: string; generation: number } | null>(null);
  const path = `scratch/${documentId}`;
  function publish(value: Scratch) { draftRef.current = value; setDraft(value); }
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
    const task = saveTail.current.catch(() => {}).then(async () => {
      const base = protectedScratch.current;
      if (!base || current.generation <= base.generation) return;
      const text = JSON.stringify(current);
      if (!await journal.putScratch(projectId, path, text, authorScope, base.text)) {
        throw new Error("別タブでスクラッチが更新されました。現在の入力を保持しています。");
      }
      protectedScratch.current = { text, generation: current.generation };
    });
    saveTail.current = task;
    try { await task; setProtectedGeneration(current.generation); setError(""); }
    catch (cause) { const message = cause instanceof Error ? cause.message : "スクラッチを保護できませんでした。"; setError(message); throw cause; }
    if (pendingRead.current !== read || draftRef.current.generation !== current.generation) throw new Error("スクラッチに新しい入力があります。記録が完了してから再試行してください。");
  }
  const protectRef = useRef(protect); protectRef.current = protect;
  useEffect(() => {
    let cancelled = false;
    void journal.getScratch(projectId, path, authorScope).then((raw) => {
      if (cancelled) return;
      let initial = empty();
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        const candidate = parsed as Scratch;
        const pendingRequest = candidate?.pendingNoteRequest as ScratchNoteRequest | undefined;
        if (!parsed || typeof parsed !== "object" || typeof candidate.text !== "string" || !Array.isArray(candidate.images) || !candidate.images.every((image) => image && typeof image.name === "string" && typeof image.data === "string" && image.data.startsWith("data:image/")) || !Number.isSafeInteger(candidate.generation) || candidate.generation < 0 || (candidate.pendingNoteRequest !== undefined && (!pendingRequest || typeof pendingRequest.idempotencyKey !== "string" || !pendingRequest.idempotencyKey || typeof pendingRequest.orderKey !== "string" || !pendingRequest.orderKey || typeof pendingRequest.markdown !== "string"))) throw new Error("スクラッチの回復記録を確認できませんでした。元の記録は保持しています。");
        initial = candidate;
      }
      protectedScratch.current = { text: raw, generation: initial.generation };
      publish(initial);
      setProtectedGeneration(initial.generation);
      setLoading(false);
    }).catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "スクラッチを読み込めませんでした。"); });
    registerGuard(() => protectRef.current());
    return () => { cancelled = true; registerGuard(null); };
  }, [journal, projectId, path, authorScope]);
  useEffect(() => { if (!loading && draft.generation > 0) void protectRef.current().catch(() => {}); }, [draft.generation, loading]);
  async function attach(files: File[]) {
    setAttachmentError("");
    const task = pendingRead.current.then(async () => {
      let total = draftRef.current.images.reduce((sum, item) => sum + item.data.length * 0.75, 0);
      const images: Scratch["images"] = [];
      for (const file of files) {
        if (!file.type.startsWith("image/") || file.size > 3 * 1024 * 1024) throw new Error("画像は1件3MB以下で添付してください。");
        total += file.size;
        if (total > 5 * 1024 * 1024) throw new Error("添付画像の合計は5MB以下にしてください。");
        const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("画像を読み込めませんでした。")); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
        images.push({ name: file.name, data });
      }
      const current = draftRef.current;
      publish({ ...current, images: [...current.images, ...images], generation: current.generation + 1 });
    });
    // A rejected attachment does not invalidate the existing scratch draft.
    const settled = task.catch(() => {});
    pendingRead.current = settled;
    try {
      await task;
    } catch (cause) {
      if (pendingRead.current === settled) setAttachmentError(cause instanceof Error ? cause.message : "画像を読み込めませんでした。");
      return;
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
        };
        current = { ...current, pendingNoteRequest: request, generation: current.generation + 1 };
        publish(current);
        await protect();
      }
      await api.createPersistenceDocument(projectId, { parentId: documentId as never, title: "スクラッチ", kind: "note", orderKey: request.orderKey, markdown: request.markdown, idempotencyKey: request.idempotencyKey });
      await onSaved();
      const latest = draftRef.current;
      if (latest.pendingNoteRequest?.idempotencyKey === request.idempotencyKey) {
        publish({ ...latest, pendingNoteRequest: undefined, generation: latest.generation + 1 });
        try { await protect(); }
        catch (cause) {
          const unconfirmed = draftRef.current;
          if (!unconfirmed.pendingNoteRequest) publish({ ...unconfirmed, pendingNoteRequest: request, generation: unconfirmed.generation + 1 });
          throw cause;
        }
      }
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "スクラッチを保存できませんでした。"); }
    finally { setSaving(false); }
  }
  const pendingMatchesCurrent = Boolean(draft.pendingNoteRequest && draft.pendingNoteRequest.markdown === scratchMarkdown(draft));
  return <details className="scratch-panel"><summary>スクラッチ · {protectedGeneration === draft.generation ? "Draft を保護済み" : "記録中"}</summary>
    <label htmlFor="pg-scratch">本文に含まれないメモ</label><textarea id="pg-scratch" value={draft.text} disabled={loading || saving} onChange={(event) => publish({ ...draftRef.current, text: event.target.value, generation: draftRef.current.generation + 1 })} />
    <label>画像を添付<input aria-label="スクラッチ画像を添付" type="file" accept="image/*" multiple disabled={loading || saving} onChange={(event) => { void attach(Array.from(event.target.files ?? [])); event.target.value = ""; }} /></label>
    {draft.images.map((image, index) => <img key={index} src={image.data} alt={image.name} width="120" />)}
    <button type="button" disabled={loading || saving} onClick={() => void protect().catch(() => {})}>続ける</button>
    {draft.pendingNoteRequest && !pendingMatchesCurrent && <p role="status">前回送信した内容の保存結果が未確認です。照合では現在のスクラッチを保持します。</p>}
    <button type="button" disabled={!canCreateNote || loading || saving || (!draft.text && !draft.images.length && !draft.pendingNoteRequest)} onClick={() => void saveNote()}>
      {draft.pendingNoteRequest ? pendingMatchesCurrent ? "ノート保存を再試行" : "前のノート保存を照合" : "ノートとしてPostgreSQLへ保存"}
    </button>
    {attachmentError && <p role="alert">{attachmentError}</p>}
    {error && <p role="alert">{error}</p>}
  </details>;
}
