import { presentableDiff, type Change } from "@codemirror/merge";
import type { DocumentRevision } from "@codexia/persistence-contracts";
import { useEffect, useState } from "react";

const contextLength = 48;

function DiffExcerpt({ text, from, to }: { text: string; from: number; to: number }) {
  let start = Math.max(0, from - contextLength);
  let end = Math.min(text.length, to + contextLength);
  if (start > 0 && (text.charCodeAt(start) & 0xfc00) === 0xdc00) start -= 1;
  if (end < text.length && (text.charCodeAt(end) & 0xfc00) === 0xdc00) end += 1;
  return <pre>{start > 0 && "…"}{text.slice(start, from)}<mark>{text.slice(from, to) || "（なし）"}</mark>{text.slice(to, end)}{end < text.length && "…"}</pre>;
}

export function RevisionDifference({ previous, current }: { previous: DocumentRevision; current: DocumentRevision }) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<{ pair: string; changes: readonly Change[] | null }>();
  const pair = previous.id + "/" + current.id;
  const previousText = previous.markdown;
  const currentText = current.markdown;
  useEffect(() => {
    if (!open || previousText === currentText) return;
    setResult(undefined);
    let cancelled = false;
    const task = window.setTimeout(() => {
      if (cancelled) return;
      try {
        setResult({ pair, changes: presentableDiff(previousText, currentText, { scanLimit: 1000, timeout: 50 }) });
      } catch {
        setResult({ pair, changes: null });
      }
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(task);
    };
  }, [currentText, open, pair, previousText]);
  if (previousText === currentText) return null;
  const comparison = result?.pair === pair ? result.changes : undefined;

  return <details className="pg-revision-difference" name="pg-revision-differences" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>最新版との違い</summary>
    {open && <section className="pg-revision-diff-preview" aria-label="原稿Revisionの比較">
      <dl className="pg-revision-diff-metadata">
        <div><dt>以前のRevision</dt><dd><time dateTime={previous.createdAt}>{new Date(previous.createdAt).toLocaleString()}</time> <code>{previous.id}</code></dd></div>
        <div><dt>現在のRevision</dt><dd><time dateTime={current.createdAt}>{new Date(current.createdAt).toLocaleString()}</time> <code>{current.id}</code></dd></div>
      </dl>
      {comparison === undefined && <p role="status">本文の違いを読み込んでいます。</p>}
      {comparison === null && <p role="alert">本文の違いを表示できませんでした。</p>}
      {comparison?.map((change) => <div key={change.fromA + "/" + change.fromB} className="pg-revision-diff-hunk">
        <div><h4>以前の本文</h4><DiffExcerpt text={previous.markdown} from={change.fromA} to={change.toA} /></div>
        <div><h4>最新版</h4><DiffExcerpt text={current.markdown} from={change.fromB} to={change.toB} /></div>
      </div>)}
    </section>}
  </details>;
}
