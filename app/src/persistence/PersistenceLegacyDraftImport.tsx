import { useState } from "react";
import { listLegacyDrafts, readLegacyDraft, removeImportedLegacyDraft, type LegacyDraftSnapshot } from "./legacy-drafts";

export interface PersistenceLegacyDraftImportProps {
  targetKey: string;
  targetLabel: string;
  beforeImport(): Promise<void>;
  /** Resolves only after the captured text is durable for the captured target. */
  onImport(text: string): Promise<void>;
}

export function PersistenceLegacyDraftImport({ targetKey, targetLabel, beforeImport, onImport }: PersistenceLegacyDraftImportProps) {
  const [items, setItems] = useState<LegacyDraftSnapshot[]>([]);
  const [selected, setSelected] = useState<LegacyDraftSnapshot | null>(null);
  const [previewTarget, setPreviewTarget] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  function inspect(): void {
    try { setItems(listLegacyDrafts(window.localStorage)); setMessage(""); }
    catch { setMessage("旧Draftを読み出せません。元データは保持しています。"); }
  }
  function preview(key: string): void {
    try { setSelected(readLegacyDraft(window.localStorage, key)); setPreviewTarget(targetKey); }
    catch { setMessage("旧Draftを読み出せません。元データは保持しています。"); }
  }
  function exportSource(): void {
    if (!selected) return;
    const url = URL.createObjectURL(new Blob([selected.raw], { type: "application/json;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = "codexia-legacy-draft.json"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  async function importSelected(): Promise<void> {
    if (!selected || busy || previewTarget !== targetKey) return;
    setBusy(true); setMessage("");
    try {
      await beforeImport();
      // The caller binds the editor generation and refuses late input/navigation.
      await onImport(selected.draft.text);
      const removed = removeImportedLegacyDraft(window.localStorage, selected);
      setSelected(null); inspect();
      setMessage(removed ? "旧Draftを回復Journalへ取り込みました。" : "取り込み後に元Draftが変更されたため、元データも保持しています。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "取り込めません。元Draftは保持しています。"); }
    finally { setBusy(false); }
  }
  return <details className="pg-legacy-import"><summary>旧ブラウザーDraftの回復</summary>
    <p>保存元と移行先を確認して取り込んでください。旧記録には作者情報がありません。</p>
    <button type="button" onClick={inspect} disabled={busy}>旧Draftを確認</button>
    {items.map((item) => <button key={item.key} type="button" disabled={busy} onClick={() => preview(item.key)}>{item.draft.projectId} / {item.draft.sceneId}</button>)}
    {selected && <section aria-label="旧Draftのプレビュー"><p>移行先: {targetLabel}</p><pre>{selected.draft.text}</pre>
      <button type="button" disabled={busy || previewTarget !== targetKey} onClick={() => void importSelected()}>この文書へ取り込む</button>
      <button type="button" disabled={busy} onClick={exportSource}>旧Draftを書き出す</button>
      <button type="button" disabled={busy} onClick={() => setSelected(null)}>取り込みをキャンセル</button>
    </section>}
    {message && <p role="status">{message}</p>}
  </details>;
}
