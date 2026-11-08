import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { Document as PersistenceDocument, DocumentId, DocumentRevision, EvidenceId, KnowledgeNode, KnowledgeNodeId, Project as PersistenceProject, RevisionId } from "@codexia/persistence-contracts";
import { api } from "../api";
import { ApiError } from "../api-error";
import { ManuscriptInput, type ManuscriptInputHandle } from "../editor/ManuscriptInput";
import { initializeDocumentEvidence, type DocumentEvidenceState, type EditorEvidenceAdapter, type TextChange } from "../editor/evidence";
import { BrowserJournal } from "../storage/journal";
import { createPostgresEditorEvidenceAdapter } from "../editor/postgresEvidenceAdapter";

interface ActiveDocument {
  document: PersistenceDocument;
  revision: DocumentRevision;
  baseRevisionId: string;
  baseMarkdown: string;
  markdown: string;
  generation: number;
  dirty: boolean;
  recovery: "pending" | "stored" | "failed" | "other-tab";
  save: "idle" | "saving" | "saved" | "failed";
  error: string;
  remoteConflict: DocumentRevision | null;
  evidence: DocumentEvidenceState;
  evidenceLoadKey: number;
}

interface PendingSave {
  projectId: string;
  documentId: string;
  baseRevisionId: string;
  baseMarkdown: string;
  markdown: string;
  generation: number;
  idempotencyKey: string;
  clientId: string;
}

const editorAdapter: EditorEvidenceAdapter = createPostgresEditorEvidenceAdapter();

export function PersistenceWorkspace({ mode, authorScope, onSignOut }: {
  mode: "desktop" | "mobile";
  authorScope: string;
  onSignOut: () => void;
}) {
  const [journal, setJournal] = useState<BrowserJournal | null>(null);
  const journalRef = useRef<BrowserJournal | null>(null);
  const [journalError, setJournalError] = useState("");
  const [projects, setProjects] = useState<PersistenceProject[]>([]);
  const [projectId, setProjectId] = useState("");
  const [documents, setDocuments] = useState<PersistenceDocument[]>([]);
  const [documentId, setDocumentId] = useState("");
  const [nodes, setNodes] = useState<KnowledgeNode[]>([]);
  const [nodeId, setNodeId] = useState("");
  const [active, setActive] = useState<ActiveDocument | null>(null);
  const activeRef = useRef<ActiveDocument | null>(null);
  const pendingSaveRef = useRef(new Map<string, PendingSave>());
  const saveInFlightRef = useRef(false);
  const saveDocumentRef = useRef<() => Promise<void>>(async () => undefined);
  const editorRef = useRef<ManuscriptInputHandle>(null);
  const clientIdRef = useRef("");
  const [loading, setLoading] = useState(false);
  const [pageError, setPageError] = useState("");
  const [notice, setNotice] = useState("");
  const [projectTitle, setProjectTitle] = useState("");
  const [documentTitle, setDocumentTitle] = useState("");
  const [newDocumentParent, setNewDocumentParent] = useState("");
  const [knowledgeName, setKnowledgeName] = useState("");
  const [knowledgeType, setKnowledgeType] = useState("person");
  const [revisions, setRevisions] = useState<DocumentRevision[]>([]);
  const [showRevisions, setShowRevisions] = useState(false);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState("");

  const project = projects.find((candidate) => candidate.id === projectId) ?? null;
  const selectedDocument = documents.find((candidate) => candidate.id === documentId) ?? null;
  const selectedNode = nodes.find((candidate) => candidate.id === nodeId) ?? null;

  const publishEditor = useCallback((next: ActiveDocument | null) => {
    activeRef.current = next;
    setActive(next);
  }, []);

  useEffect(() => {
    let open = true;
    void BrowserJournal.open().then((value) => {
      if (!open) { value.close(); return; }
      journalRef.current = value;
      setJournal(value);
      setJournalError("");
    }).catch((error: unknown) => {
      if (!open) return;
      setJournalError(error instanceof Error ? error.message : "IndexedDB回復Journalを開けませんでした。");
    });
    return () => {
      open = false;
      journalRef.current?.close();
      journalRef.current = null;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void api.persistenceProjects(200, controller.signal).then((values) => {
      setProjects(values);
      setProjectId((current) => current && values.some((value) => value.id === current) ? current : values[0]?.id ?? "");
      setPageError("");
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setPageError(error instanceof Error ? error.message : "作品一覧を読み込めませんでした。");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!projectId) {
      setDocuments([]);
      setNodes([]);
      setDocumentId("");
      publishEditor(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setPageError("");
    publishEditor(null);
    void Promise.all([
      api.persistenceDocuments(projectId, undefined, controller.signal),
      api.persistenceNodes(projectId, 500, controller.signal),
    ]).then(([documentResult, nodeResult]) => {
      setDocuments(documentResult.documents);
      setNodes(nodeResult.nodes);
      setDocumentId((current) => current && documentResult.documents.some((item) => item.id === current)
        ? current : documentResult.documents[0]?.id ?? "");
      setNodeId((current) => current && nodeResult.nodes.some((item) => item.id === current) ? current : "");
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setPageError(error instanceof Error ? error.message : "作品の内容を読み込めませんでした。");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [projectId, publishEditor]);

  const openDocument = useCallback(async (nextDocumentId: string): Promise<void> => {
    const currentProject = projects.find((item) => item.id === projectId);
    const currentJournal = journalRef.current;
    if (!currentProject || !currentJournal || !nextDocumentId) return;
    setLoading(true);
    setPageError("");
    setNotice("");
    publishEditor(null);
    try {
      const [read, draft] = await Promise.all([
        api.persistenceDocument(currentProject.id, nextDocumentId),
        currentJournal.getPersistenceDraft(currentProject.id, nextDocumentId, authorScope),
      ]);
      if (!read.revision) throw new Error("この文書にRevisionがありません。");
      const revision = read.revision;
      const snapshot = await editorAdapter.read({
        projectId: currentProject.id,
        documentId: nextDocumentId,
        revisionId: revision.id,
        markdown: revision.markdown,
      }, new AbortController().signal);
      const evidence = initializeDocumentEvidence(revision.markdown, revision.id, snapshot);
      const staleDraft = Boolean(draft && (draft.baseRevisionId !== revision.id || draft.baseMarkdown !== revision.markdown));
      const markdown = draft?.markdown ?? revision.markdown;
      const baseMarkdown = draft?.baseMarkdown ?? revision.markdown;
      const baseRevisionId = draft?.baseRevisionId ?? revision.id;
      const dirty = markdown !== baseMarkdown;
      publishEditor({
        document: read.document,
        revision,
        baseRevisionId,
        baseMarkdown,
        markdown,
        generation: dirty ? Math.max(1, draft?.generation ?? 0) : draft?.generation ?? 0,
        dirty,
        recovery: dirty ? "pending" : "stored",
        save: dirty ? "idle" : "saved",
        error: "",
        remoteConflict: staleDraft ? revision : null,
        evidence,
        evidenceLoadKey: 1,
      });
      if (draft && staleDraft) setNotice("ブラウザーに保存された下書きのbase Revisionが変わっています。比較してから、どちらを使うか選んでください。");
      setRevisions([]);
      setShowRevisions(false);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "文書を開けませんでした。");
    } finally {
      setLoading(false);
    }
  }, [authorScope, projectId, projects, publishEditor]);

  useEffect(() => {
    if (journal && projectId && documentId) void openDocument(documentId);
  }, [documentId, journal, openDocument, projectId]);

  const persistDraft = useCallback(async (value: ActiveDocument): Promise<boolean> => {
    const currentJournal = journalRef.current;
    if (!currentJournal) throw new Error(journalError || "IndexedDB回復Journalを利用できません。");
    if (!value.dirty || value.generation < 1) return true;
    return currentJournal.putPersistenceDraft({
      projectId: value.document.projectId,
      documentId: value.document.id,
      authorScope,
      baseRevisionId: value.baseRevisionId,
      baseMarkdown: value.baseMarkdown,
      markdown: value.markdown,
      generation: value.generation,
    });
  }, [authorScope, journalError]);

  useEffect(() => {
    if (!journal || !active?.dirty || active.generation < 1) return;
    let cancelled = false;
    let timer: number | undefined;
    const current = active;
    publishEditor({ ...current, recovery: "pending", error: current.error });
    void persistDraft(current).then((stored) => {
      if (cancelled) return;
      const latest = activeRef.current;
      if (latest?.document.id !== current.document.id || latest.generation !== current.generation) return;
      if (!stored) {
        publishEditor({ ...latest, recovery: "other-tab", save: "failed", error: "別タブに、より新しい回復下書きがあります。回復記録を上書きせず、この文書の自動保存を止めました。" });
        return;
      }
      publishEditor({ ...latest, recovery: "stored", error: "" });
      if (!latest.remoteConflict) timer = window.setTimeout(() => { void saveDocumentRef.current(); }, 900);
    }).catch((error: unknown) => {
      if (cancelled) return;
      const latest = activeRef.current;
      if (latest?.document.id === current.document.id && latest.generation === current.generation) {
        publishEditor({ ...latest, recovery: "failed", save: "failed", error: error instanceof Error ? error.message : "回復Journalへ保存できませんでした。" });
      }
    });
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
    // Save only after this exact editor generation has been written to IndexedDB.
  }, [active?.document.id, active?.generation, active?.baseRevisionId, active?.markdown, journal, persistDraft, publishEditor]);

  const saveDocument = useCallback(async (): Promise<void> => {
    const currentJournal = journalRef.current;
    if (!currentJournal || saveInFlightRef.current) return;
    const current = activeRef.current;
    if (!current) return;
    const pendingKey = JSON.stringify([current.document.projectId, current.document.id]);
    let pending = pendingSaveRef.current.get(pendingKey);
    if (!pending) {
      if (!current?.dirty || current.remoteConflict || current.recovery !== "stored") return;
      pending = {
        projectId: current.document.projectId,
        documentId: current.document.id,
        baseRevisionId: current.baseRevisionId,
        baseMarkdown: current.baseMarkdown,
        markdown: current.markdown,
        generation: current.generation,
        idempotencyKey: crypto.randomUUID(),
        clientId: clientIdRef.current ||= crypto.randomUUID(),
      };
      pendingSaveRef.current.set(pendingKey, pending);
    }
    saveInFlightRef.current = true;
    const inScope = activeRef.current?.document.id === pending.documentId;
    if (inScope) publishEditor({ ...activeRef.current!, save: "saving", error: "" });
    try {
      const result = await editorAdapter.save?.({
        projectId: pending.projectId,
        documentId: pending.documentId,
        revisionId: pending.baseRevisionId,
        markdown: pending.baseMarkdown,
      }, {
        baseMarkdown: pending.baseMarkdown,
        markdown: pending.markdown,
        changes: minimalTextChanges(pending.baseMarkdown, pending.markdown),
        idempotencyKey: pending.idempotencyKey,
        clientId: pending.clientId,
      }, new AbortController().signal);
      if (!result || result.markdown !== pending.markdown || !result.document || !result.revision) {
        throw new Error("PostgreSQLの保存結果を確認できませんでした。");
      }
      const removed = await currentJournal.removePersistenceDraft(pending.projectId, pending.documentId, authorScope, pending.generation);
      pendingSaveRef.current.delete(pendingKey);
      const latest = activeRef.current;
      if (latest?.document.id === pending.documentId) {
        const hasNewerText = latest.generation > pending.generation || latest.markdown !== pending.markdown;
        publishEditor({
          ...latest,
          document: result.document,
          revision: result.revision,
          baseRevisionId: result.revision.id,
          baseMarkdown: pending.markdown,
          dirty: hasNewerText,
          recovery: hasNewerText ? latest.recovery : "stored",
          save: hasNewerText ? "idle" : "saved",
          error: !removed && !hasNewerText ? "この文書のより新しい回復記録が別タブに残っています。" : "",
          remoteConflict: null,
        });
      } else if (latest?.dirty) {
        window.setTimeout(() => { void saveDocumentRef.current(); }, 0);
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        pendingSaveRef.current.delete(pendingKey);
        try {
          const currentRead = await api.persistenceDocument(pending.projectId, pending.documentId);
          const latest = activeRef.current;
          if (latest?.document.id === pending.documentId && currentRead.revision) {
            publishEditor({ ...latest, remoteConflict: currentRead.revision, save: "failed", error: "PostgreSQL上のRevisionが先に更新されました。下書きはIndexedDBに残しています。" });
          }
        } catch (readError) {
          const latest = activeRef.current;
          if (latest?.document.id === pending.documentId) publishEditor({ ...latest, save: "failed", error: readError instanceof Error ? readError.message : "競合した最新Revisionを読み込めませんでした。" });
        }
      } else {
        const latest = activeRef.current;
        if (latest?.document.id === pending.documentId) {
          publishEditor({ ...latest, save: "failed", error: error instanceof Error ? error.message : "PostgreSQLへ保存できませんでした。回復下書きは保持しています。" });
        }
      }
    } finally {
      saveInFlightRef.current = false;
      const latest = activeRef.current;
      if (latest?.dirty && latest.recovery === "stored" && !latest.remoteConflict && latest.document.id !== pending.documentId) {
        window.setTimeout(() => { void saveDocumentRef.current(); }, 0);
      }
    }
  }, [authorScope, publishEditor]);

  saveDocumentRef.current = saveDocument;

  async function createProject(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const title = projectTitle.trim();
    if (!title) return;
    setLoading(true);
    setPageError("");
    try {
      const result = await api.createPersistenceProject({ title });
      setProjects((current) => [result.project, ...current]);
      setProjectId(result.project.id);
      setDocumentId("");
      setProjectTitle("");
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "作品を作成できませんでした。");
    } finally {
      setLoading(false);
    }
  }

  async function createDocument(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!project) return;
    const title = documentTitle.trim();
    if (!title) return;
    setLoading(true);
    setPageError("");
    try {
      const result = await api.createPersistenceDocument(project.id, {
        parentId: (newDocumentParent || null) as DocumentId | null,
        kind: "scene",
        title,
        orderKey: String(documents.length).padStart(8, "0"),
        markdown: "",
        idempotencyKey: crypto.randomUUID(),
      });
      setDocuments((current) => [...current, result.document]);
      setDocumentId(result.document.id);
      setDocumentTitle("");
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "文書を作成できませんでした。");
    } finally {
      setLoading(false);
    }
  }

  async function selectDocument(nextId: string): Promise<void> {
    const current = activeRef.current;
    if (current?.dirty) {
      try {
        const stored = await persistDraft(current);
        if (!stored) throw new Error("別タブの新しい回復記録があるため、この文書は切り替えませんでした。");
      } catch (error) {
        setPageError(error instanceof Error ? error.message : "回復Journalを保存できませんでした。");
        return;
      }
    }
    publishEditor(null);
    setDocumentId(nextId);
  }

  async function refreshEvidence(value = activeRef.current): Promise<void> {
    const currentProject = projects.find((item) => item.id === projectId);
    if (!currentProject || !value) return;
    const snapshot = await editorAdapter.read({
      projectId: currentProject.id,
      documentId: value.document.id,
      revisionId: value.revision.id,
      markdown: value.revision.markdown,
    }, new AbortController().signal);
    const evidence = initializeDocumentEvidence(value.revision.markdown, value.revision.id, snapshot);
    const latest = activeRef.current;
    if (latest?.document.id === value.document.id) publishEditor({ ...latest, evidence, evidenceLoadKey: latest.evidenceLoadKey + 1 });
  }

  async function createAnchor(): Promise<void> {
    const current = activeRef.current;
    const selection = editorRef.current?.getSelection();
    if (!project || !current || !selection) { setNotice("Text Anchorにする本文範囲を選択してください。"); return; }
    if (current.dirty || current.remoteConflict || current.save !== "saved") {
      setNotice("Text Anchorを作るには、先に本文をPostgreSQLへ保存してください。");
      return;
    }
    try {
      const created = await api.createPersistenceAnchor(project.id, current.document.id, {
        id: crypto.randomUUID() as EvidenceId,
        revisionId: current.revision.id as RevisionId,
        fromUtf16: selection.from,
        toUtf16: selection.to,
        status: "confirmed",
      });
      await refreshEvidence();
      setSelectedEvidenceId(created.anchor.id);
      setNotice(`Text Anchorを保存しました: ${created.quote}`);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Text Anchorを保存できませんでした。");
    }
  }

  async function createKnowledge(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!project || !knowledgeName.trim()) return;
    const id = crypto.randomUUID() as KnowledgeNodeId;
    try {
      const result = await api.savePersistenceNode(project.id, id, {
        type: knowledgeType,
        name: knowledgeName.trim(),
        attributes: {},
        status: "proposed",
        expectedVersion: null,
      });
      setNodes((current) => [...current, result.node].sort((a, b) => a.name.localeCompare(b.name, "ja")));
      setNodeId(result.node.id);
      setKnowledgeName("");
      setNotice("Knowledge候補を保存しました。内容を確認してから確定してください。");
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Knowledgeを保存できませんでした。");
    }
  }

  async function confirmKnowledge(node: KnowledgeNode): Promise<void> {
    if (!project) return;
    try {
      const result = await api.savePersistenceNode(project.id, node.id, {
        type: node.type,
        name: node.name,
        attributes: node.attributes,
        status: "confirmed",
        expectedVersion: node.version,
      });
      setNodes((current) => current.map((item) => item.id === node.id ? result.node : item));
      setNotice(`Knowledge「${result.node.name}」を確定しました。`);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Knowledgeを確定できませんでした。");
    }
  }

  async function linkKnowledge(anchorId: string, status: "proposed" | "confirmed"): Promise<void> {
    if (!project || !active || !selectedNode) return;
    try {
      await api.savePersistenceMention(project.id, active.document.id, anchorId, {
        nodeId: selectedNode.id as KnowledgeNodeId,
        status,
      });
      await refreshEvidence();
      setNotice(status === "confirmed" ? "Knowledge参照を作者確認済みとして保存しました。" : "Knowledge参照候補を保存しました。");
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Knowledge参照を保存できませんでした。");
    }
  }

  async function loadRevisions(): Promise<void> {
    if (!project || !active) return;
    try {
      const page = await api.persistenceRevisions(project.id, active.document.id, 50);
      setRevisions([...page.revisions]);
      setShowRevisions((value) => !value);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Revision履歴を読み込めませんでした。");
    }
  }

  async function restoreRevision(source: DocumentRevision): Promise<void> {
    if (!project || !active || active.dirty || active.remoteConflict) return;
    setLoading(true);
    setPageError("");
    try {
      const restored = await api.restorePersistenceDocument(project.id, active.document.id, {
        baseRevisionId: active.revision.id as RevisionId,
        sourceRevisionId: source.id as RevisionId,
        idempotencyKey: crypto.randomUUID(),
      });
      const snapshot = await editorAdapter.read({
        projectId: project.id,
        documentId: active.document.id,
        revisionId: restored.revision.id,
        markdown: restored.revision.markdown,
      }, new AbortController().signal);
      const evidence = initializeDocumentEvidence(restored.revision.markdown, restored.revision.id, snapshot);
      publishEditor({
        ...active,
        document: restored.document,
        revision: restored.revision,
        baseRevisionId: restored.revision.id,
        baseMarkdown: restored.revision.markdown,
        markdown: restored.revision.markdown,
        generation: active.generation + 1,
        dirty: false,
        recovery: "stored",
        save: "saved",
        error: "",
        remoteConflict: null,
        evidence,
        evidenceLoadKey: active.evidenceLoadKey + 1,
      });
      setNotice("選んだRevisionを新しいPostgreSQL Revisionとして復元しました。");
      setShowRevisions(false);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        const latest = await api.persistenceDocument(project.id, active.document.id);
        if (latest.revision) publishEditor({ ...active, remoteConflict: latest.revision, save: "failed", error: "復元前にRevisionが更新されました。最新Revisionを確認してください。" });
      } else setPageError(error instanceof Error ? error.message : "Revisionを復元できませんでした。");
    } finally {
      setLoading(false);
    }
  }

  async function useDatabaseRevision(): Promise<void> {
    const current = activeRef.current;
    const remote = current?.remoteConflict;
    const currentJournal = journalRef.current;
    if (!project || !current || !remote || !currentJournal) return;
    try {
      const read = await api.persistenceDocument(project.id, current.document.id);
      if (!read.revision) throw new Error("最新Revisionを読み込めませんでした。");
      const snapshot = await editorAdapter.read({ projectId: project.id, documentId: current.document.id, revisionId: read.revision.id, markdown: read.revision.markdown }, new AbortController().signal);
      const removed = await currentJournal.removePersistenceDraft(project.id, current.document.id, authorScope, current.generation);
      if (!removed) {
        setPageError("別タブに新しい回復記録があるため、破棄しませんでした。まずそのタブの保存状態を確認してください。");
        return;
      }
      publishEditor({
        ...current,
        document: read.document,
        revision: read.revision,
        baseRevisionId: read.revision.id,
        baseMarkdown: read.revision.markdown,
        markdown: read.revision.markdown,
        generation: current.generation + 1,
        dirty: false,
        recovery: "stored",
        save: "saved",
        error: "",
        remoteConflict: null,
        evidence: initializeDocumentEvidence(read.revision.markdown, read.revision.id, snapshot),
        evidenceLoadKey: current.evidenceLoadKey + 1,
      });
      setNotice("PostgreSQLの最新版を開きました。回復Draftは明示的に破棄しました。");
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "PostgreSQLの最新版を開けませんでした。");
    }
  }

  function adoptRecoveredDraft(): void {
    const current = activeRef.current;
    const remote = current?.remoteConflict;
    if (!current || !remote) return;
    pendingSaveRef.current.delete(JSON.stringify([current.document.projectId, current.document.id]));
    publishEditor({
      ...current,
      revision: remote,
      baseRevisionId: remote.id,
      baseMarkdown: remote.markdown,
      generation: current.generation + 1,
      dirty: current.markdown !== remote.markdown,
      recovery: "pending",
      save: "idle",
      error: "",
      remoteConflict: null,
      evidenceLoadKey: current.evidenceLoadKey + 1,
    });
    setNotice("下書きを最新Revision全体へ適用します。IndexedDBへ再保存後、通常の競合検出を通して保存します。");
  }

  const onEditorChange = useCallback((markdown: string, _changes: TextChange[]) => {
    const current = activeRef.current;
    if (!current || markdown === current.markdown) return;
    publishEditor({ ...current, markdown, generation: current.generation + 1, dirty: markdown !== current.baseMarkdown, recovery: "pending", save: "idle", error: "" });
  }, [publishEditor]);

  const selectProject = (nextProjectId: string) => {
    publishEditor(null);
    setDocumentId("");
    setProjectId(nextProjectId);
  };

  const switchPath = `/${mode === "desktop" ? "mobile" : "desktop"}?store=postgres`;

  return <div className={`pg-workspace pg-${mode}`}>
    <header className="pg-header">
      <div><p className="eyebrow">Codexia · PostgreSQL</p><h1>Database workspace</h1></div>
      <nav aria-label="Workspace controls">
        <a href={switchPath}>{mode === "desktop" ? "Mobileへ" : "Desktopへ"}</a>
        <a href={`/${mode}`}>Git作品を開く</a>
        <button type="button" onClick={onSignOut}>ログアウト</button>
      </nav>
    </header>
    <div className={`pg-layout ${active ? "has-document" : ""}`}>
      <aside className="pg-library" aria-label="作品と文書">
        <section>
          <h2>作品</h2>
          {projects.length > 0 && <label htmlFor="pg-project">開く作品</label>}
          {projects.length > 0 && <select id="pg-project" value={projectId} onChange={(event) => selectProject(event.target.value)}>
            {projects.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select>}
          <form onSubmit={(event) => void createProject(event)}>
            <label htmlFor="pg-project-title">新しい作品</label>
            <input id="pg-project-title" value={projectTitle} onChange={(event) => setProjectTitle(event.target.value)} maxLength={256} required placeholder="作品名" />
            <button type="submit" disabled={loading || !projectTitle.trim()}>作品を作成</button>
          </form>
        </section>
        {project && <section>
          <h2>文書</h2>
          <ul className="pg-document-list">
            {documents.map((item) => <li key={item.id}>
              <button type="button" className={item.id === documentId ? "is-selected" : ""} aria-current={item.id === documentId ? "page" : undefined} onClick={() => void selectDocument(item.id)}>
                <span>{item.title}</span><small>{item.parentId ? `${documents.find((parent) => parent.id === item.parentId)?.title ?? "親文書"} · ` : ""}{item.kind}</small>
              </button>
            </li>)}
          </ul>
          <form onSubmit={(event) => void createDocument(event)}>
            <label htmlFor="pg-document-title">文書を追加</label>
            <input id="pg-document-title" value={documentTitle} onChange={(event) => setDocumentTitle(event.target.value)} maxLength={256} required placeholder="章・シーン名" />
            <label htmlFor="pg-document-parent">追加先</label>
            <select id="pg-document-parent" value={newDocumentParent} onChange={(event) => setNewDocumentParent(event.target.value)}>
              <option value="">作品の直下</option>
              {documents.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
            </select>
            <button type="submit" disabled={loading || !documentTitle.trim()}>文書を作成</button>
          </form>
        </section>}
      </aside>

      <main className="pg-editor-column" aria-label="PostgreSQL原稿編集">
        {pageError && <p className="pg-alert" role="alert">{pageError}</p>}
        {notice && <p className="pg-notice" role="status">{notice}</p>}
        {journalError && <p className="pg-alert" role="alert">{journalError}</p>}
        {!project && <section className="pg-empty"><h2>最初の作品を作成してください</h2><p>作品、原稿Revision、Knowledge、EvidenceはPostgreSQLへ保存されます。</p></section>}
        {project && !selectedDocument && <section className="pg-empty"><h2>{project.title}</h2><p>編集を始める文書を作成してください。</p></section>}
        {active && <section className="pg-editor" aria-label={active.document.title}>
          <div className="pg-editor-heading">
            <div><p className="eyebrow">{project?.title}</p><h2>{active.document.title}</h2></div>
            <div className="pg-save-state" aria-live="polite">
              <span>{active.recovery === "stored" ? "IndexedDB回復Journalに保存済み" : active.recovery === "pending" ? "ブラウザーへ記録中" : active.recovery === "other-tab" ? "別タブの下書きあり" : "回復Journalエラー"}</span>
              <span>{active.save === "saved" ? "PostgreSQLへ保存済み" : active.save === "saving" ? "PostgreSQLへ保存中" : active.save === "failed" ? "PostgreSQL保存を確認できません" : active.dirty ? "PostgreSQL保存待ち" : "Revisionを開いています"}</span>
            </div>
          </div>
          {active.error && <p className="pg-alert" role="alert">{active.error}</p>}
          <div className="pg-editor-actions">
            <button type="button" onClick={() => void saveDocument()} disabled={!active.dirty || active.recovery !== "stored" || Boolean(active.remoteConflict) || active.save === "saving"}>
              {active.save === "failed" ? "PostgreSQLへ再試行" : "今すぐ保存"}
            </button>
            <button type="button" onClick={() => void loadRevisions()} disabled={active.dirty || Boolean(active.remoteConflict)}>Revision履歴</button>
            <button type="button" onClick={() => void createAnchor()} disabled={active.dirty || Boolean(active.remoteConflict) || active.save !== "saved"}>選択範囲をText Anchorにする</button>
          </div>
          <label id="pg-manuscript-label" htmlFor="manuscript">原稿 Markdown</label>
          <ManuscriptInput
            key={active.document.id}
            ref={editorRef}
            value={active.markdown}
            externalTextRevision={active.generation}
            readOnly={Boolean(journalError)}
            onChange={onEditorChange}
            documentRevision={active.revision.id}
            evidenceState={active.evidence}
            evidenceLoadKey={active.evidenceLoadKey}
            evidenceSourceText={active.revision.markdown}
            onEvidenceChange={(evidence) => {
              const current = activeRef.current;
              if (current?.document.id === active.document.id) publishEditor({ ...current, evidence });
            }}
            labelledBy="pg-manuscript-label"
            placeholder="物語の続きを書く"
          />
          <p className="pg-editor-hint">{active.markdown.length}字 · UTF-16差分をRevisionへ保存します。本文を送る前にIndexedDBの回復Journalへ記録します。</p>

          {active.remoteConflict && <section className="pg-conflict" aria-labelledby="pg-conflict-title">
            <h3 id="pg-conflict-title">Revision競合</h3>
            <p>ブラウザーDraftのbaseとPostgreSQLの最新版が違います。本文は上書きしていません。</p>
            <div className="pg-conflict-comparison">
              <div><h4>PostgreSQL最新版</h4><pre>{active.remoteConflict.markdown}</pre></div>
              <div><h4>回復Draft</h4><pre>{active.markdown}</pre></div>
            </div>
            <button type="button" onClick={adoptRecoveredDraft}>比較後、この回復Draftを最新版へ適用</button>
            <button type="button" onClick={() => void useDatabaseRevision()}>回復Draftを破棄してPostgreSQL最新版を開く</button>
          </section>}

          {showRevisions && <section className="pg-revisions" aria-label="Revision履歴">
            <h3>Revision履歴</h3>
            {revisions.map((revision) => <article key={revision.id}>
              <p>{new Date(revision.createdAt).toLocaleString()} · {revision.id === active.revision.id ? "現在" : "保存済み"}</p>
              <pre>{revision.markdown.slice(0, 700) || "（空の原稿）"}</pre>
              {revision.id !== active.revision.id && <button type="button" disabled={loading || active.dirty} onClick={() => void restoreRevision(revision)}>このRevisionを新しいRevisionとして復元</button>}
            </article>)}
          </section>}
        </section>}
      </main>

      <aside className="pg-knowledge" aria-label="KnowledgeとEvidence">
        <section>
          <h2>Knowledge</h2>
          <form onSubmit={(event) => void createKnowledge(event)}>
            <label htmlFor="pg-knowledge-name">Knowledge候補を追加</label>
            <input id="pg-knowledge-name" value={knowledgeName} onChange={(event) => setKnowledgeName(event.target.value)} maxLength={512} required placeholder="人物・場所・用語" />
            <label htmlFor="pg-knowledge-type">種類</label>
            <select id="pg-knowledge-type" value={knowledgeType} onChange={(event) => setKnowledgeType(event.target.value)}>
              <option value="person">人物</option><option value="place">場所</option><option value="event">出来事</option><option value="setting">設定</option><option value="term">用語</option>
            </select>
            <button type="submit" disabled={!project || !knowledgeName.trim()}>候補を保存</button>
          </form>
          <label htmlFor="pg-knowledge-target">Text AnchorのKnowledge先</label>
          <select id="pg-knowledge-target" value={nodeId} onChange={(event) => setNodeId(event.target.value)} disabled={nodes.length === 0}>
            <option value="">Knowledgeを選択</option>
            {nodes.map((node) => <option key={node.id} value={node.id}>{node.name} · {node.status === "confirmed" ? "確定" : node.status === "proposed" ? "候補" : "退役"}</option>)}
          </select>
          <ul className="pg-knowledge-list">
            {nodes.map((node) => <li key={node.id}>
              <button type="button" className={node.id === nodeId ? "is-selected" : ""} onClick={() => setNodeId(node.id)}>
                <span>{node.name}</span><small>{node.type} · {node.status === "confirmed" ? "作者確定" : node.status === "proposed" ? "未確認候補" : "退役"}</small>
              </button>
              {node.status === "proposed" && <button type="button" onClick={() => void confirmKnowledge(node)}>内容を確認して確定</button>}
            </li>)}
          </ul>
        </section>
        <section>
          <h2>Text Anchor / Evidence</h2>
          {!active && <p>文書を開くと、この作品のKnowledgeとEvidenceを利用できます。</p>}
          {active && active.evidence.anchors.length === 0 && <p>このRevisionにText Anchorはありません。本文で範囲を選び、作成してください。</p>}
          {active && <ul className="pg-evidence-list">
            {active.evidence.anchors.map((anchor) => <li key={anchor.id}>
              <button type="button" className={selectedEvidenceId === anchor.id ? "is-selected" : ""} onClick={() => setSelectedEvidenceId(anchor.id)}>
                <q>{anchor.quote}</q><small>{anchor.status === "current" ? "現在のRevision" : anchor.status === "proposed" ? "確認待ち" : anchor.status === "needs_review" ? "再確認が必要" : anchor.status === "orphaned" ? "本文から削除" : "Revision不一致"}</small>
              </button>
              {anchor.target && <p>確定先: {anchor.target.label}</p>}
              {anchor.candidates?.map((candidate) => <p key={candidate.id}>候補: {candidate.label}</p>)}
              {anchor.status === "current" && selectedNode && <div className="pg-link-actions">
                <button type="button" onClick={() => void linkKnowledge(anchor.id, "proposed")}>候補としてリンク</button>
                <button type="button" disabled={selectedNode.status !== "confirmed"} onClick={() => void linkKnowledge(anchor.id, "confirmed")}>Knowledgeリンクを確定</button>
              </div>}
            </li>)}
          </ul>}
        </section>
      </aside>
    </div>
    {loading && <p className="pg-loading" role="status">PostgreSQLの状態を読み込んでいます。</p>}
  </div>;
}

function minimalTextChanges(source: string, target: string): TextChange[] {
  if (source === target) return [];
  const sourcePoints = Array.from(source);
  const targetPoints = Array.from(target);
  let prefix = 0;
  while (prefix < sourcePoints.length && prefix < targetPoints.length && sourcePoints[prefix] === targetPoints[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < sourcePoints.length - prefix && suffix < targetPoints.length - prefix &&
      sourcePoints[sourcePoints.length - suffix - 1] === targetPoints[targetPoints.length - suffix - 1]) suffix += 1;
  const from = sourcePoints.slice(0, prefix).join("").length;
  const to = sourcePoints.slice(0, sourcePoints.length - suffix).join("").length;
  const insert = targetPoints.slice(prefix, targetPoints.length - suffix).join("");
  return [{ from, to, insert }];
}
