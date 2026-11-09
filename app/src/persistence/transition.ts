/** Navigation can unmount an editor only after the exact current generation is durable. */
export async function protectEditorTransition<T extends { generation: number }>(
  read: () => T | null,
  readEditor: () => void,
  persist: (value: T) => Promise<boolean>,
): Promise<void> {
  readEditor();
  const current = read();
  if (!current) return;
  if (!await persist(current)) throw new Error("別タブに新しい回復記録があります。本文を保護できないため画面を切り替えませんでした。");
  const latest = read();
  if (latest !== null && latest.generation !== current.generation) throw new Error("保存中に本文が更新されました。記録が完了してから、もう一度操作してください。");
}
