import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { BrowserJournal } from "../storage/journal";

interface Scratch { text: string; images: Array<{ name: string; data: string }>; generation: number }
const empty = (): Scratch => ({ text: "", images: [], generation: 0 });

/** Private scratch remains outside the manuscript until explicitly saved as a note. */
export function PersistenceScratch({ projectId, documentId, authorScope, journal, registerGuard, onSaved }: {
  projectId: string; documentId: string; authorScope: string; journal: BrowserJournal;
  registerGuard(guard: (() => Promise<void>) | null): void; onSaved(): Promise<void>;
}) {
  const [draft, setDraft] = useState<Scratch>(empty);
  const draftRef = useRef(draft);
  const [error, setError] = useState("");
  const [protectedGeneration, setProtectedGeneration] = useState(-1);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const pendingRead = useRef<Promise<void>>(Promise.resolve());
  const saveTail = useRef<Promise<void>>(Promise.resolve());
  const path = `scratch/${documentId}`;
  function publish(value: Scratch) { draftRef.current = value; setDraft(value); }
  async function protect(): Promise<void> {
    await pendingRead.current;
    const current = draftRef.current;
    const task = saveTail.current.catch(() => {}).then(() => journal.putScratch(projectId, path, JSON.stringify(current), authorScope));
    saveTail.current = task;
    try { await task; setProtectedGeneration(current.generation); setError(""); }
    catch (cause) { const message = cause instanceof Error ? cause.message : "スクラッチを保護できませんでした。"; setError(message); throw cause; }
    if (draftRef.current.generation !== current.generation) throw new Error("スクラッチに新しい入力があります。記録が完了してから再試行してください。");
  }
  const protectRef = useRef(protect); protectRef.current = protect;
  useEffect(() => {
    let cancelled = false;
    void journal.getScratch(projectId, path, authorScope).then((raw) => {
      if (cancelled) return;
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || typeof (parsed as Scratch).text !== "string" || !Array.isArray((parsed as Scratch).images) || !Number.isSafeInteger((parsed as Scratch).generation)) throw new Error("スクラッチの回復記録を確認できませんでした。元の記録は保持しています。");
        publish(parsed as Scratch); setProtectedGeneration((parsed as Scratch).generation);
      }
      setLoading(false);
    }).catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "スクラッチを読み込めませんでした。"); });
    registerGuard(() => protectRef.current());
    return () => { cancelled = true; registerGuard(null); };
  }, [journal, projectId, path, authorScope]);
  useEffect(() => { if (!loading && draft.generation > 0) void protectRef.current().catch(() => {}); }, [draft.generation, loading]);
  async function attach(files: File[]) {
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
    pendingRead.current = task;
    try { await task; await protectRef.current(); } catch (cause) { setError(cause instanceof Error ? cause.message : "画像を保護できませんでした。"); }
  }
  async function saveNote() {
    setSaving(true);
    try {
      await protect();
      const current = draftRef.current;
      await api.createPersistenceDocument(projectId, { parentId: documentId as never, title: "スクラッチ", kind: "note", orderKey: String(Date.now()), markdown: current.text + current.images.map((image) => `\n\n![${image.name.replace(/[\[\]\\]/gu, "")}](${image.data})`).join(""), idempotencyKey: crypto.randomUUID() });
      await onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "スクラッチを保存できませんでした。"); }
    finally { setSaving(false); }
  }
  return <details className="scratch-panel"><summary>スクラッチ · {protectedGeneration === draft.generation ? "Draft を保護済み" : "記録中"}</summary>
    <label htmlFor="pg-scratch">本文に含まれないメモ</label><textarea id="pg-scratch" value={draft.text} disabled={loading || saving} onChange={(event) => publish({ ...draftRef.current, text: event.target.value, generation: draftRef.current.generation + 1 })} />
    <label>画像を添付<input aria-label="スクラッチ画像を添付" type="file" accept="image/*" multiple disabled={loading || saving} onChange={(event) => { void attach(Array.from(event.target.files ?? [])); event.target.value = ""; }} /></label>
    {draft.images.map((image, index) => <img key={index} src={image.data} alt={image.name} width="120" />)}
    <button type="button" disabled={loading || saving} onClick={() => void protect().catch(() => {})}>続ける</button>
    <button type="button" disabled={loading || saving || (!draft.text && !draft.images.length)} onClick={() => void saveNote()}>ノートとしてPostgreSQLへ保存</button>
    {error && <p role="alert">{error}</p>}
  </details>;
}
