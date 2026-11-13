import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { snapshotKey } from "@codexia/contracts";
import type { EditorTermSpan } from "../editor/terms";
import { useRecentActivityResume } from "../resume/useRecentActivityResume";
import { formatHandoffHint, loadWritingResume, loadReadingPage, mergeContinueCandidates } from "../resume/continueCandidates";
import type { BrowserEditorDocument, ModuleStatus, SnapshotId, UiContribution } from "@codexia/contracts";
import { availableModulePanels } from "../application/AvailableModulePanels";
import { workspaceContributions } from "../contributions/catalog";
import { ProposalReview } from "../contributions/ProposalReview";
import type { JournalProposal } from "../storage/journal";
import type { Document as PersistenceDocument, DocumentId, DocumentRevision, EvidenceId, KnowledgeNode, KnowledgeNodeId, Project as PersistenceProject, RevisionId } from "@codexia/persistence-contracts";
import { api, type PersistenceAnchorView } from "../api";
import { KnowledgeContextInspector } from "./KnowledgeContextInspector";
import { readWorkspaceSelectionForLocation, workspaceSelectionPath, writeWorkspaceSelection } from "./selection";
import { PersistenceLegacyDraftImport } from "./PersistenceLegacyDraftImport";
import { parseApplicationLocation, switchApplicationPath } from "../application/navigation";
import { PersistenceScratch } from "./PersistenceScratch";
import { protectEditorTransition } from "./transition";
import { ApiError } from "../api-error";
import { DesktopShell } from "../shells/desktop/DesktopShell";
import { MobileShell } from "../shells/mobile/MobileShell";
import type { WorkspacePanel, WorkspacePanelRequest } from "../application/contracts";
import { applyThemeMode, loadThemeMode, persistThemeMode } from "../theme";
import { ThemeControl } from "../components/ThemeControl";
import { JobInbox } from "../components/JobInbox";
import { MobileReadingPager } from "../editor/MobileReadingPager";
import { TermAwareRubyText } from "../editor/TermAwareRubyText";
import { WRITING_SYMBOLS } from "../editor/writingSymbols";
import { loadTypographySettings, storeTypographySettings, TYPOGRAPHY_PRESETS, typographyPresetValues, type TypographyPresetId } from "../editor/typography";
import { ManuscriptInput, type ManuscriptInputHandle, type EvidenceRangeRequest } from "../editor/ManuscriptInput";
import { initializeDocumentEvidence, type DocumentEvidenceState, type EditorEvidenceAdapter, type TextChange } from "../editor/evidence";
import { BrowserJournal } from "../storage/journal";
import { createPostgresEditorEvidenceAdapter } from "../editor/postgresEvidenceAdapter";
import { NativeChangeSetReview } from "./NativeChangeSetReview";

interface EvidenceJump extends EvidenceRangeRequest {
  projectId: string;
  documentId: string;
  positionConfirmed: boolean;
}

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

type DesktopDurability = "draft" | "saving" | "uncertain" | "saved";

function desktopDurabilityFor(active: ActiveDocument | null): DesktopDurability | undefined {
  if (!active) return undefined;
  if (active.remoteConflict || active.error || active.save === "failed" || active.recovery === "failed" || active.recovery === "other-tab") return "uncertain";
  if (active.save === "saving") return "saving";
  if (active.dirty) return "draft";
  return active.save === "saved" && active.recovery === "stored" ? "saved" : "uncertain";
}

function desktopDurabilityDetail(active: ActiveDocument | null, status: DesktopDurability | undefined): string | undefined {
  if (!active || !status) return undefined;
  if (status === "draft") return active.recovery === "pending"
    ? "新しい本文をIndexedDB回復Journalへ記録中です。PostgreSQLへは未保存です。"
    : "下書きはIndexedDB回復Journalに保持されています。PostgreSQLへの保存は未完了です。";
  if (status === "saving") return "本文はIndexedDB回復Journalに保持されています。PostgreSQLへの保存結果を確認中です。";
  if (status === "saved") return "PostgreSQLへの保存を確認しました。";
  if (active.remoteConflict) return "PostgreSQLに別のRevisionがあります。ブラウザーDraftを保持し、内容の比較が必要です。";
  if (active.error) return active.error;
  if (active.recovery === "pending") return "IndexedDB回復Journalへの記録が完了していません。本文を保持して再試行してください。";
  return "PostgreSQL保存またはIndexedDB回復Journalの状態を再確認してください。";
}

const editorAdapter: EditorEvidenceAdapter = createPostgresEditorEvidenceAdapter();

function persistSelectionSafely(authorScope: string, selection: { projectId: string; documentId: string }): void {
  try { writeWorkspaceSelection(window.localStorage, authorScope, selection); } catch { /* Route and journal state do not depend on preferences. */ }
}

export function PersistenceWorkspace({ mode, authorScope, onSignOut }: {
  mode: "desktop" | "mobile";
  authorScope: string;
  onSignOut: () => void;
}) {
  if (mode === "mobile") return <MobilePersistenceWorkspace authorScope={authorScope} onSignOut={onSignOut} />;
  return <PersistenceWorkspaceController mode="desktop" authorScope={authorScope} onSignOut={onSignOut} />;
}

function MobilePersistenceWorkspace({ authorScope, onSignOut }: { authorScope: string; onSignOut: () => void }) {
  const navigate = useNavigate();
  const navigateUrl = useCallback((url: string, replace: boolean) => { navigate(url, { replace }); }, [navigate]);
  return <PersistenceWorkspaceController mode="mobile" authorScope={authorScope} onSignOut={onSignOut} navigateUrl={navigateUrl} />;
}

function PersistenceWorkspaceController({ mode, authorScope, onSignOut, navigateUrl }: {
  mode: "desktop" | "mobile";
  authorScope: string;
  onSignOut: () => void;
  navigateUrl?: (url: string, replace: boolean) => void;
}) {
  const selectionRef = useRef((() => { try { return readWorkspaceSelectionForLocation(window.localStorage, authorScope, mode, window.location.href); } catch { return null; } })());
  const textSelectionRef = useRef<{ from: number; to: number; text: string } | null>(null);
  const legacyImportTargetRef = useRef<{ authorScope: string; projectId: string; documentId: string; revisionId: string; generation: number; markdown: string } | null>(null);
  const pageWasHiddenRef = useRef(false);
  const loadedDocumentsProjectRef = useRef<string | null>(null);
  const [reading, setReading] = useState(false);
  const [readingDirection, setReadingDirection] = useState<"horizontal" | "vertical">("horizontal");
  const [readingPage, setReadingPage] = useState(0);
  const [typography, setTypography] = useState(loadTypographySettings);
  const editorPositionRef = useRef<{ cursorSentenceIndex: number | null; scrollTop: number }>({ cursorSentenceIndex: null, scrollTop: 0 });
  const [theme, setTheme] = useState(loadThemeMode);
  const [themeError, setThemeError] = useState("");
  const [journal, setJournal] = useState<BrowserJournal | null>(null);
  const journalRef = useRef<BrowserJournal | null>(null);
  const [journalError, setJournalError] = useState("");
  const [modules, setModules] = useState<ModuleStatus[]>([]);
  const [contributions, setContributions] = useState<UiContribution[]>([]);
  const moduleFilesRef = useRef<Array<{ path: string; revision: string | null }>>([]);
  const moduleSequenceRef = useRef(0);
  const [moduleSnapshot, setModuleSnapshot] = useState<SnapshotId | null>(null);
  const [proposals, setProposals] = useState<JournalProposal[]>([]);
  const [moduleError, setModuleError] = useState("");
  const [projects, setProjects] = useState<PersistenceProject[]>([]);
  const [projectId, setProjectId] = useState("");
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const [documents, setDocuments] = useState<PersistenceDocument[]>([]);
  const [documentId, setDocumentId] = useState("");
  const [nodes, setNodes] = useState<KnowledgeNode[]>([]);
  const [nodeId, setNodeId] = useState("");
  const [nodeEvidence, setNodeEvidence] = useState<{ projectId: string; nodeId: string; evidence: PersistenceAnchorView[] } | null>(null);
  const [nodeEvidenceError, setNodeEvidenceError] = useState("");
  const [evidenceJump, setEvidenceJump] = useState<EvidenceJump>();
  const [active, setActive] = useState<ActiveDocument | null>(null);
  const activeRef = useRef<ActiveDocument | null>(null);
  const pendingSaveRef = useRef(new Map<string, PendingSave>());
  const saveInFlightRef = useRef(false);
  const saveDocumentRef = useRef<() => Promise<void>>(async () => undefined);
  const scratchGuardRef = useRef<(() => Promise<void>) | null>(null);
  const editorRef = useRef<ManuscriptInputHandle>(null);
  const transitionErrorRef = useRef("");
  const clientIdRef = useRef("");
  const openSequenceRef = useRef(0);
  const selectionIntentRef = useRef(0);
  const panelRequestSequenceRef = useRef(0);
  const [resumeEpoch, setResumeEpoch] = useState(0);
  const [legacyImportBusy, setLegacyImportBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [workTransferBusy, setWorkTransferBusy] = useState(false);
  const [workTransferStatus, setWorkTransferStatus] = useState("");
  const [pageError, setPageError] = useState("");
  const [notice, setNotice] = useState("");
  const [projectTitle, setProjectTitle] = useState("");
  const [documentKind, setDocumentKind] = useState("scene");
  const [renameTitle, setRenameTitle] = useState("");
  const [orderRank, setOrderRank] = useState(0);
  const [moveParent, setMoveParent] = useState("");
  const [documentTitle, setDocumentTitle] = useState("");
  const [newDocumentParent, setNewDocumentParent] = useState("");
  const [knowledgeName, setKnowledgeName] = useState("");
  const [knowledgeType, setKnowledgeType] = useState("person");
  const [revisions, setRevisions] = useState<DocumentRevision[]>([]);
  const [showRevisions, setShowRevisions] = useState(false);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState("");
  const [requestedPanel, setRequestedPanel] = useState<WorkspacePanelRequest>();

  const resume = useRecentActivityResume({ binding: projectId ? { projectId, authorScope, projectScopeKey: projectId } : null, enabled: Boolean(projectId) });
  const project = projects.find((candidate) => candidate.id === projectId) ?? null;
  const selectedDocument = documents.find((candidate) => candidate.id === documentId) ?? null;
  const selectedNode = nodes.find((candidate) => candidate.id === nodeId && candidate.projectId === projectId) ?? null;
  const selectedNodeEvidence = nodeEvidence?.projectId === projectId && nodeEvidence.nodeId === selectedNode?.id ? nodeEvidence.evidence : null;

  const publishEditor = useCallback((next: ActiveDocument | null) => {
    if (!next || (activeRef.current && activeRef.current.document.id !== next.document.id)) textSelectionRef.current = null;
    activeRef.current = next;
    setActive(next);
  }, []);

  const updateRouteSelection = useCallback((selection: { projectId: string; documentId: string } | null, replace: boolean) => {
    const nextPath = workspaceSelectionPath(mode, selection, window.location.search);
    const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (nextPath === currentPath) return;
    if (navigateUrl) navigateUrl(nextPath, replace);
    else window.history[replace ? "replaceState" : "pushState"](window.history.state, "", nextPath);
  }, [mode, navigateUrl]);

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
    const onPageHide = () => { pageWasHiddenRef.current = true; resume.flush(true); };
    const onPageShow = (event: PageTransitionEvent) => {
      if (!pageWasHiddenRef.current && !event.persisted) return;
      pageWasHiddenRef.current = false;
      setResumeEpoch((value) => value + 1);
    };
    const beforeUnload = (event: BeforeUnloadEvent) => { const current = activeRef.current; if (current?.dirty && current.recovery !== "stored") { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("pagehide", onPageHide); window.addEventListener("pageshow", onPageShow); window.addEventListener("beforeunload", beforeUnload);
    return () => { window.removeEventListener("pagehide", onPageHide); window.removeEventListener("pageshow", onPageShow); window.removeEventListener("beforeunload", beforeUnload); };
  }, [resume.flush]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void api.persistenceProjects(200, controller.signal).then((values) => {
      setProjects(values);
      setProjectId((current) => current && values.some((value) => value.id === current) ? current : values.find((value) => value.id === selectionRef.current?.projectId)?.id ?? values[0]?.id ?? "");
      setPageError("");
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setPageError(error instanceof Error ? error.message : "作品一覧を読み込めませんでした。");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [resumeEpoch]);

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
    if (loadedDocumentsProjectRef.current !== projectId) {
      loadedDocumentsProjectRef.current = projectId;
      publishEditor(null);
    }
    void Promise.all([
      api.persistenceDocuments(projectId, undefined, controller.signal),
      api.persistenceNodes(projectId, 500, controller.signal),
    ]).then(([documentResult, nodeResult]) => {
      setDocuments(documentResult.documents);
      setNodes(nodeResult.nodes);
      setDocumentId((current) => current && documentResult.documents.some((item) => item.id === current)
        ? current : documentResult.documents.find((item) => projectId === selectionRef.current?.projectId && item.id === selectionRef.current.documentId)?.id ?? documentResult.documents[0]?.id ?? "");
      setNodeId((current) => current && nodeResult.nodes.some((item) => item.id === current) ? current : "");
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setPageError(error instanceof Error ? error.message : "作品の内容を読み込めませんでした。");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [projectId, publishEditor, resumeEpoch]);

  useEffect(() => {
    setNodeEvidence(null);
    setNodeEvidenceError("");
    if (!projectId || !selectedNode) return;
    const selectedId = selectedNode.id;
    const controller = new AbortController();
    void api.persistenceNodeEvidence(projectId, selectedId, 500, controller.signal).then((result) => {
      if (!controller.signal.aborted) setNodeEvidence({
        projectId, nodeId: selectedId,
        evidence: result.evidence.filter((item) => item.mentions.some(({ link }) => link.nodeId === selectedId && link.status !== "rejected")),
      });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setNodeEvidenceError(error instanceof Error ? error.message : "根拠を読み込めませんでした。");
    });
    return () => controller.abort();
  }, [projectId, selectedNode?.id, active?.revision.id, active?.evidenceLoadKey, resumeEpoch]);

  const refreshModules = useCallback(async () => {
    const sequence = ++moduleSequenceRef.current;
    if (!projectId) { setModuleSnapshot(null); setModules([]); setContributions([]); setProposals([]); return; }
    try {
      const [statuses, catalog, read, remote] = await Promise.all([api.modules(projectId), api.contributions(projectId), api.moduleSnapshot(projectId), api.proposalStatuses(projectId)]);
      if (sequence !== moduleSequenceRef.current) return;
      if (read.snapshot.projectId !== projectId) throw new Error("作品のRevisionが一致しません。");
      const currentJournal = journalRef.current;
      if (currentJournal) {
        for (const status of remote.proposals) await currentJournal.putProposal(projectId, authorScope, status.proposal, status);
        setProposals(await currentJournal.getProposals(projectId, authorScope));
      }
      moduleFilesRef.current = read.files;
      setModules(statuses); setContributions(catalog); setModuleSnapshot(read.snapshot); setModuleError("");
    } catch (error) { if (sequence !== moduleSequenceRef.current) return; setModuleError(error instanceof Error ? error.message : "モジュールを読み込めませんでした。"); }
  }, [projectId, authorScope]);
  const refreshAfterNativeApply = useCallback(() => {
    const appliedProjectId = projectId;
    void refreshModules();
    void Promise.all([api.persistenceNodes(appliedProjectId, 500), api.persistenceProject(appliedProjectId)]).then(([nodeResult, projectResult]) => {
      if (projectIdRef.current !== appliedProjectId) return;
      setNodes(nodeResult.nodes);
      setProjects((current) => current.map((item) => item.id === appliedProjectId ? projectResult.project : item));
    }).catch((error: unknown) => {
      if (projectIdRef.current === appliedProjectId) setNotice(error instanceof Error ? `適用後の作品状態を再読み込みできませんでした。${error.message}` : "適用後の作品状態を再読み込みできませんでした。");
    });
  }, [projectId, refreshModules]);
  useEffect(() => { void refreshModules(); }, [refreshModules, journal, active?.revision.id, resumeEpoch]);

  const openDocument = useCallback(async (nextDocumentId: string): Promise<void> => {
    const currentProject = projects.find((item) => item.id === projectId);
    const currentJournal = journalRef.current;
    if (!currentProject || !currentJournal || !nextDocumentId) return;
    const openSequence = ++openSequenceRef.current;
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
      if (openSequence !== openSequenceRef.current) return;
      selectionRef.current = { projectId: currentProject.id, documentId: nextDocumentId };
      persistSelectionSafely(authorScope, selectionRef.current);
      updateRouteSelection(selectionRef.current, true);
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
      const position = loadWritingResume(authorScope, currentProject.id);
      if (position?.sceneId === nextDocumentId) requestAnimationFrame(() => { if (activeRef.current?.document.id === nextDocumentId) editorRef.current?.restorePosition(position); });
      setReadingPage(loadReadingPage(authorScope, currentProject.id, nextDocumentId));
      setRevisions([]);
      setShowRevisions(false);
    } catch (error) {
      if (openSequence === openSequenceRef.current) setPageError(error instanceof Error ? error.message : "文書を開けませんでした。");
    } finally {
      if (openSequence === openSequenceRef.current) setLoading(false);
    }
  }, [authorScope, projectId, projects, publishEditor, updateRouteSelection]);

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

  const revalidateActiveDocument = useCallback(async (signal: AbortSignal): Promise<void> => {
    const captured = activeRef.current;
    const currentProject = projects.find((item) => item.id === projectId);
    if (!captured || !currentProject || captured.document.id !== documentId || captured.document.projectId !== projectId) return;
    const sequence = ++openSequenceRef.current;
    try {
      const read = await api.persistenceDocument(projectId, captured.document.id, signal);
      if (signal.aborted || sequence !== openSequenceRef.current || !read.revision) return;
      const latest = activeRef.current;
      if (!latest || latest.document.id !== captured.document.id) return;
      if (latest.revision.id === read.revision.id) {
        if (latest.document.version !== read.document.version) publishEditor({ ...latest, document: read.document });
        return;
      }
      if (!latest.dirty) {
        await openDocument(captured.document.id);
        return;
      }
      if (latest.recovery !== "stored") {
        const stored = await persistDraft(latest);
        if (signal.aborted || sequence !== openSequenceRef.current) return;
        const afterWrite = activeRef.current;
        if (!stored && afterWrite?.document.id === latest.document.id) {
          publishEditor({ ...afterWrite, recovery: "other-tab", save: "failed", error: "別タブの回復Draftがあるため上書きを止めました。" });
          return;
        }
      }
      const newest = activeRef.current;
      if (!newest || newest.document.id !== captured.document.id) return;
      publishEditor({
        ...newest,
        document: read.document,
        remoteConflict: read.revision,
        save: "idle",
        error: "PostgreSQL上で別の端末が新しいRevisionを保存しました。現在のブラウザーDraftを保持しています。",
      });
    } catch (error) {
      if (!signal.aborted && sequence === openSequenceRef.current) setPageError(error instanceof Error ? error.message : "開いている文書を再確認できませんでした。");
    }
  }, [documentId, openDocument, persistDraft, projectId, projects, publishEditor]);

  useEffect(() => {
    if (!journal || !projectId || !documentId) return;
    const controller = new AbortController();
    const current = activeRef.current;
    if (current?.document.id === documentId && current.document.projectId === projectId) {
      void revalidateActiveDocument(controller.signal);
    } else {
      void openDocument(documentId);
    }
    return () => controller.abort();
  }, [documentId, journal, openDocument, projectId, revalidateActiveDocument, resumeEpoch]);

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
          // A newer draft may already exist under the old base Revision at this generation.
          // Advance the generation so IndexedDB can persist the rebased record before retrying.
          generation: hasNewerText ? latest.generation + 1 : latest.generation,
          recovery: hasNewerText ? "pending" : "stored",
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
    if (!title || !await protectTransition()) return;
    setLoading(true);
    setPageError("");
    try {
      const result = await api.createPersistenceProject({ title });
      setProjects((current) => [result.project, ...current]);
      if (!await protectTransition()) return;
      selectionRef.current = { projectId: result.project.id, documentId: "" };
      persistSelectionSafely(authorScope, selectionRef.current);
      updateRouteSelection(selectionRef.current, false);
      setProjectId(result.project.id);
      setDocumentId("");
      setProjectTitle("");
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "作品を作成できませんでした。");
    } finally {
      setLoading(false);
    }
  }

  async function exportCurrentWork(): Promise<void> {
    if (!project || workTransferBusy) return;
    const current = activeRef.current;
    if (current?.document.projectId === project.id && (current.dirty || current.save === "saving" || current.remoteConflict)) {
      setPageError("現在の原稿にPostgreSQL未保存の変更があります。保存または競合解決後にエクスポートしてください。");
      return;
    }
    setWorkTransferBusy(true);
    setWorkTransferStatus("");
    setPageError("");
    try {
      const archive = await api.exportWorkArchive(project.id);
      const blob = new Blob([JSON.stringify(archive) + "\n"], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = "codexia-" + (project.title.replace(/[^\p{L}\p{N}._-]+/gu, "-").slice(0, 64) || "work") + ".json";
        document.body.appendChild(link);
        link.click();
        link.remove();
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      setWorkTransferStatus("作品のJSONスナップショットを生成しました。過去のRevisionとブラウザーDraftは含まれません。" +
        (archive.omittedRecords.length ? " セキュリティ保護のため除外された設定が " + archive.omittedRecords.length + " 件あります。" : "") +
        (archive.evidence.unresolved.anchors.length ? " 未解決の旧Evidenceが " + archive.evidence.unresolved.anchors.length + " 件含まれています。" : ""));
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "作品をエクスポートできませんでした。");
    } finally {
      setWorkTransferBusy(false);
    }
  }

  async function importPortableWork(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || workTransferBusy || !await protectTransition()) return;
    if (file.size > 12 * 1024 * 1024) {
      setPageError("JSONファイルが12 MiBの受信上限を超えています。");
      return;
    }
    setWorkTransferBusy(true);
    setWorkTransferStatus("");
    setPageError("");
    try {
      const raw: unknown = JSON.parse(await file.text());
      const imported = await api.importWorkArchive(raw);
      setProjects((current) => current.some((item) => item.id === imported.project.id)
        ? current : [imported.project, ...current]);
      openSequenceRef.current += 1;
      publishEditor(null);
      selectionRef.current = { projectId: imported.project.id, documentId: "" };
      persistSelectionSafely(authorScope, selectionRef.current);
      updateRouteSelection(selectionRef.current, false);
      setDocumentId("");
      setProjectId(imported.project.id);
      setWorkTransferStatus((imported.replayed ? "このJSONは既に取り込み済みです。" : "新しい作品としてJSONを取り込みました。") +
        (imported.unresolvedAnchors ? " 旧RevisionのEvidence " + imported.unresolvedAnchors + " 件は記録を保持し、現在の文書には自動リンクしていません。" : "") +
        (imported.omittedRecords ? " 元データで機密設定など " + imported.omittedRecords + " 件は除外済みです。" : ""));
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "作品JSONを取り込めませんでした。");
    } finally {
      setWorkTransferBusy(false);
    }
  }

  async function createDocument(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!project) return;
    const title = documentTitle.trim();
    if (!title || !await protectTransition()) return;
    setLoading(true);
    setPageError("");
    try {
      const result = await api.createPersistenceDocument(project.id, {
        parentId: (newDocumentParent || null) as DocumentId | null,
        kind: documentKind,
        title,
        orderKey: String(documents.length).padStart(8, "0"),
        markdown: "",
        idempotencyKey: crypto.randomUUID(),
      });
      if (!await protectTransition()) return;
      setDocuments((current) => [...current, result.document]);
      selectionRef.current = { projectId: project.id, documentId: result.document.id };
      persistSelectionSafely(authorScope, selectionRef.current);
      updateRouteSelection(selectionRef.current, false);
      setDocumentId(result.document.id);
      setDocumentTitle("");
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "文書を作成できませんでした。");
    } finally {
      setLoading(false);
    }
  }

  const protectTransition = useCallback(async (): Promise<boolean> => {
    try {
      transitionErrorRef.current = "";
      // Capture the IME guard synchronously, before scratch/journal promises can
      // settle after compositionend. A transition requested during composition
      // must remain denied even if the browser finishes composing meanwhile.
      editorRef.current?.readForNavigation();
      resume.flush();
      await scratchGuardRef.current?.();
      await protectEditorTransition(() => activeRef.current, () => {
        const markdown = editorRef.current?.readForNavigation();
        const current = activeRef.current;
        if (current && markdown !== undefined && markdown !== current.markdown) publishEditor({ ...current, markdown, generation: current.generation + 1, dirty: markdown !== current.baseMarkdown, recovery: "pending" });
      }, persistDraft);
      return true;
    } catch (error) {
      transitionErrorRef.current = error instanceof Error ? error.message : "回復Journalを保存できませんでした。";
      setPageError(transitionErrorRef.current);
      return false;
    }
  }, [persistDraft, publishEditor, resume.flush]);

  const selectDocument = useCallback(async (nextId: string): Promise<boolean> => {
    // Navigation preflight is asynchronous. Only the latest requested selection
    // may publish a document, even when an earlier request finishes later.
    const intent = ++selectionIntentRef.current;
    setEvidenceJump(undefined);
    if (nextId === documentId && selectionRef.current?.documentId === nextId &&
        activeRef.current?.document.id === nextId) return true;
    if (!await protectTransition()) return false;
    if (intent !== selectionIntentRef.current) return false;
    openSequenceRef.current += 1;
    publishEditor(null);
    selectionRef.current = { projectId, documentId: nextId };
    persistSelectionSafely(authorScope, selectionRef.current);
    updateRouteSelection(selectionRef.current, false);
    setReading(false);
    setDocumentId(nextId);
    return true;
  }, [authorScope, documentId, projectId, protectTransition, publishEditor, updateRouteSelection]);

  const beforeLegacyImport = useCallback(async (): Promise<void> => {
    legacyImportTargetRef.current = null;
    if (!journalRef.current) throw new Error(journalError || "回復Journalが利用できません。");
    if (!await protectTransition()) throw new Error(transitionErrorRef.current || "現在の原稿を回復Journalへ保護できませんでした。");
    const current = activeRef.current;
    if (!current || !projectId || current.document.projectId !== projectId) throw new Error("先に移行先のPostgreSQL文書を開いてください。");
    if (current.dirty || current.recovery !== "stored" || current.save !== "saved" || current.remoteConflict) {
      throw new Error("現在の原稿に未保存または競合中の変更があります。PostgreSQLへ保存してから旧Draftを取り込んでください。");
    }
    const editorMarkdown = editorRef.current?.readForNavigation();
    if (editorMarkdown !== undefined && editorMarkdown !== current.markdown) {
      throw new Error("現在の入力が画面状態へ反映されていません。原稿を保護してから再試行してください。");
    }
    legacyImportTargetRef.current = {
      authorScope,
      projectId,
      documentId: current.document.id,
      revisionId: current.revision.id,
      generation: current.generation,
      markdown: current.markdown,
    };
  }, [authorScope, journalError, projectId, protectTransition]);

  const importLegacyDraft = useCallback(async (markdown: string): Promise<void> => {
    const target = legacyImportTargetRef.current;
    legacyImportTargetRef.current = null;
    const current = activeRef.current;
    if (!target || target.authorScope !== authorScope || target.projectId !== projectId || target.documentId !== documentId ||
        !current || current.document.projectId !== target.projectId || current.document.id !== target.documentId ||
        current.revision.id !== target.revisionId || current.generation !== target.generation || current.markdown !== target.markdown ||
        current.dirty || current.recovery !== "stored" || current.save !== "saved" || current.remoteConflict) {
      throw new Error("プレビュー後に移行先の文書またはRevisionが変わりました。元Draftは保持しています。");
    }
    const editorMarkdown = editorRef.current?.readForNavigation();
    if (editorMarkdown !== undefined && editorMarkdown !== target.markdown) {
      throw new Error("プレビュー後に原稿が変更されました。元Draftは保持しています。");
    }
    if (markdown === current.markdown) return;

    setLegacyImportBusy(true);
    try {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const latest = activeRef.current;
      const editorText = editorRef.current?.readForNavigation();
      if (!latest || latest.document.projectId !== target.projectId || latest.document.id !== target.documentId ||
          latest.revision.id !== target.revisionId || latest.generation !== target.generation || latest.markdown !== target.markdown ||
          latest.dirty || latest.recovery !== "stored" || latest.save !== "saved" || latest.remoteConflict ||
          (editorText !== undefined && editorText !== target.markdown)) {
        throw new Error("取り込み中に原稿が変更されました。元Draftは保持しています。");
      }
      const imported: ActiveDocument = {
        ...latest,
        markdown,
        generation: latest.generation + 1,
        dirty: markdown !== latest.baseMarkdown,
        recovery: "pending",
        save: markdown === latest.baseMarkdown ? "saved" : "idle",
        error: "",
      };
      if (imported.dirty) {
        const stored = await persistDraft(imported);
        if (!stored) throw new Error("別タブに新しい回復Draftがあります。元Draftは保持しています。");
      }
      const afterWrite = activeRef.current;
      if (!afterWrite || afterWrite.document.projectId !== target.projectId || afterWrite.document.id !== target.documentId ||
          afterWrite.revision.id !== target.revisionId || afterWrite.generation !== target.generation || afterWrite.markdown !== target.markdown || afterWrite.dirty) {
        throw new Error("Journal保存中に原稿が変わりました。元Draftは保持しています。");
      }
      publishEditor({ ...imported, recovery: "stored" });
      setNotice(imported.dirty ? "旧DraftをIndexedDB回復Journalへ取り込みました。PostgreSQLへ保存します。" : "旧DraftとPostgreSQLの原稿は同じ内容でした。");
    } finally {
      setLegacyImportBusy(false);
    }
  }, [authorScope, documentId, persistDraft, projectId, publishEditor]);

  useEffect(() => {
    const onPopState = () => {
      const route = parseApplicationLocation(window.location.href);
      const target = route?.mode === mode && route.resource?.projectId
        ? { projectId: route.resource.projectId, documentId: route.resource.sceneId ?? "" }
        : null;
      const nextProjectId = target?.projectId ?? "";
      const nextDocumentId = target?.documentId ?? "";
      if (nextProjectId === projectId && nextDocumentId === documentId) return;
      void (async () => {
        if (!await protectTransition()) {
          updateRouteSelection(projectId ? { projectId, documentId } : null, true);
          return;
        }
        selectionRef.current = target;
        if (target) persistSelectionSafely(authorScope, target);
        openSequenceRef.current += 1;
        publishEditor(null);
        setReading(false);
        setProjectId(nextProjectId);
        setDocumentId(nextDocumentId);
      })();
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [authorScope, documentId, mode, projectId, protectTransition, publishEditor, updateRouteSelection]);

  async function editStructure(update: { title?: string; parentId?: string | null; orderKey?: string }, remove = false): Promise<void> {
    const current = activeRef.current;
    if (!current || !await protectTransition()) return;
    try {
      if (remove) await api.deletePersistenceDocument(projectId, current.document.id, current.document.version);
      else await api.updatePersistenceDocument(projectId, current.document.id, { ...update, expectedVersion: current.document.version });
      const result = await api.persistenceDocuments(projectId);
      setDocuments(result.documents);
      if (remove) {
        openSequenceRef.current++;
        publishEditor(null);
        const nextDocumentId = result.documents[0]?.id ?? "";
        selectionRef.current = { projectId, documentId: nextDocumentId };
        persistSelectionSafely(authorScope, selectionRef.current);
        updateRouteSelection(nextDocumentId ? selectionRef.current : { projectId, documentId: "" }, true);
        setDocumentId(nextDocumentId);
      }
      else { const document = result.documents.find((item) => item.id === current.document.id); const latest = activeRef.current; if (document && latest?.document.id === current.document.id) publishEditor({ ...latest, document }); }
      await refreshModules();
    } catch (error) { setPageError(error instanceof Error ? error.message : "構成を更新できませんでした。"); }
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
    if (latest?.document.id === value.document.id && latest.revision.id === value.revision.id) {
      publishEditor({ ...latest, evidence, evidenceLoadKey: latest.evidenceLoadKey + 1 });
    }
  }

  async function createAnchor(): Promise<void> {
    const current = activeRef.current;
    const editorSelection = editorRef.current?.getSelection();
    const rememberedSelection = textSelectionRef.current;
    const selection = editorSelection ?? (rememberedSelection && current?.markdown.slice(rememberedSelection.from, rememberedSelection.to) === rememberedSelection.text ? rememberedSelection : null);
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
      setRequestedPanel({ id: "inspector", sequence: ++panelRequestSequenceRef.current });
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

  const selectProject = async (nextProjectId: string): Promise<void> => {
    if (nextProjectId === projectId || !await protectTransition()) return;
    openSequenceRef.current += 1;
    publishEditor(null);
    selectionRef.current = { projectId: nextProjectId, documentId: "" };
    persistSelectionSafely(authorScope, selectionRef.current);
    updateRouteSelection(selectionRef.current, false);
    setDocumentId("");
    setProjectId(nextProjectId);
    setReading(false);
  };

  const resolveTerms = useCallback(async (text: string, signal: AbortSignal): Promise<readonly EditorTermSpan[]> => {
    if (!moduleSnapshot || signal.aborted) return [];
    const enabled = new Set(modules.filter((item) => item.availability === "enabled-idle" || item.availability === "active").map((item) => item.id));
    const adornments = contributions.filter((item) => item.kind === "editor-adornment" && enabled.has(item.module));
    const results = await Promise.allSettled(adornments.map((item) => api.action(projectId, item.action, { text }, signal, moduleSnapshot)));
    if (signal.aborted) return [];
    return results.flatMap((result) => result.status === "fulfilled" && result.value.ok && snapshotKey(result.value.snapshot) === snapshotKey(moduleSnapshot) && Array.isArray((result.value.data as { spans?: unknown })?.spans) ? (result.value.data as { spans: EditorTermSpan[] }).spans : []);
  }, [moduleSnapshot, modules, contributions, projectId]);
  const navigateReference = useCallback(async (path: string): Promise<void> => {
    // Snapshot file revisions are content hashes; PostgreSQL headRevisionId is a
    // revision UUID. Never equate them when resolving a module's document link.
    const canonicalPath = /^documents\/([^/]+)\.md$/u.exec(path);
    let target = canonicalPath ? documents.find((item) => item.id === canonicalPath[1]) : undefined;
    if (!target) {
      const resolution = await api.action(projectId, "core.document.resolve", { path }, undefined, moduleSnapshot ?? undefined);
      if (!resolution.ok) throw new Error(resolution.error.message);
      const sceneId = (resolution.data as { sceneId?: unknown }).sceneId;
      target = documents.find((item) => item.id === sceneId);
    }
    if (!target) throw new Error("この作品の文書が見つかりません。");
    if (!await selectDocument(target.id)) throw new Error("回復JournalまたはIMEを確認できないため、参照先を開けませんでした。");
    // Search and terminology may be shown in another workspace tab. Reveal the
    // selected manuscript through the existing guarded panel request path.
    setRequestedPanel({ id: "editor", sequence: ++panelRequestSequenceRef.current });
  }, [documents, moduleSnapshot, projectId, selectDocument]);
  const handleEvidenceRangeResult = useCallback((request: EvidenceRangeRequest, revealed: boolean) => {
    setEvidenceJump((current) => current === request ? undefined : current);
    setNotice(revealed ? "現在のRevisionの根拠箇所を選択しました。" : "原稿またはRevisionが変わっているため、根拠の位置は再確認してください。");
  }, []);

  useEffect(() => {
    if (!evidenceJump) return;
    if (evidenceJump.projectId !== projectId || evidenceJump.documentId !== documentId) {
      setEvidenceJump(undefined);
      return;
    }
    if (active?.document.id !== evidenceJump.documentId) return;
    if (!evidenceJump.positionConfirmed) {
      setEvidenceJump(undefined);
      setNotice("現在位置が未確定の根拠です。本文の位置を再確認してください。");
      return;
    }
    if (active.revision.id !== evidenceJump.revisionId || active.dirty || active.remoteConflict || active.markdown !== active.revision.markdown) {
      setEvidenceJump(undefined);
      setNotice("原稿またはRevisionが変わっているため、根拠の位置は再確認してください。");
    }
  }, [evidenceJump, projectId, documentId, active]);

  async function openNodeEvidence(item: PersistenceAnchorView): Promise<void> {
    const { anchor, quote } = item;
    if (!project || anchor.projectId !== project.id || !documents.some((document) => document.id === anchor.documentId)) {
      setPageError("この作品の根拠文書が見つかりません。");
      return;
    }
    // The same-document fast path of selectDocument does not perform a guard.
    if (activeRef.current?.document.id === anchor.documentId && !await protectTransition()) return;
    if (selectionRef.current?.projectId !== project.id) return;
    if (!await selectDocument(anchor.documentId)) return;
    if (selectionRef.current?.projectId !== project.id || selectionRef.current.documentId !== anchor.documentId) return;
    setReading(false);
    setRequestedPanel({ id: "editor", sequence: ++panelRequestSequenceRef.current });
    setEvidenceJump({ projectId: project.id, documentId: anchor.documentId, revisionId: anchor.revisionId,
      from: anchor.fromUtf16, to: anchor.toUtf16, quote,
      positionConfirmed: anchor.status === "confirmed" && anchor.toUtf16 > anchor.fromUtf16 && Boolean(quote) });
  }

  const handleTermNavigate = useCallback((path: string) => {
    void navigateReference(path).catch((error) => setPageError(error instanceof Error ? error.message : "参照を開けませんでした。"));
  }, [navigateReference]);
  const switchPath = switchApplicationPath(window.location.href, mode === "desktop" ? "mobile" : "desktop");

  const editorFontFamily = typography.fontFamily === "mincho" ? "serif" : "sans-serif";
  const typographyStyle = {
    fontSize: typography.fontSize,
    lineHeight: typography.lineHeight,
    letterSpacing: `${typography.letterSpacing}em`,
    maxWidth: typography.maxWidth,
    fontFamily: editorFontFamily,
    "--editor-font-size": `${typography.fontSize}px`,
    "--editor-line-height": String(typography.lineHeight),
    "--editor-letter-spacing": `${typography.letterSpacing}em`,
    "--editor-font-family": editorFontFamily,
    "--reader-max-width": `${typography.maxWidth}px`,
  } as CSSProperties;
  const library = (<aside className="pg-library" aria-label="作品と文書">
        <section>
          <h2>作品</h2>
          {projects.length > 0 && <label htmlFor="pg-project">開く作品</label>}
          {projects.length > 0 && <select id="pg-project" value={projectId} onChange={(event) => void selectProject(event.target.value)}>
            {projects.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select>}
          <form onSubmit={(event) => void createProject(event)}>
            <label htmlFor="pg-project-title">新しい作品</label>
            <input id="pg-project-title" value={projectTitle} onChange={(event) => setProjectTitle(event.target.value)} maxLength={256} required placeholder="作品名" />
            <button type="submit" disabled={loading || !projectTitle.trim()}>作品を作成</button>
          </form>
          <details>
            <summary>作品のエクスポート・インポート</summary>
            <p>Markdown本文・構成・Knowledge・Evidence・作者データを作品JSONで持ち出し、別の作品として取り込めます。PostgreSQLの全Revision履歴やブラウザーの下書きは含まれません。</p>
            {project && <button type="button" disabled={workTransferBusy || loading} onClick={() => void exportCurrentWork()}>
              選択中の作品をJSONでエクスポート
            </button>}
            <label htmlFor="pg-work-import">作品JSONをインポート（既存作品は上書きしません）</label>
            <input id="pg-work-import" type="file" accept=".json,application/json" disabled={workTransferBusy || loading}
              onChange={(event) => void importPortableWork(event)} />
            {workTransferBusy && <p role="status">作品データを処理中です。</p>}
            {workTransferStatus && <p role="status">{workTransferStatus}</p>}
          </details>
        </section>
        {project && <section>
          <h2>文書</h2>
          <section className="continue-panel" aria-label="続きから">
            <h3>続きから</h3>
            {resume.error && <p role="status">再開位置を同期できません: {resume.error}</p>}
            {mergeContinueCandidates(resume.localWriting, resume.items, { documents }).map((candidate) => {
              const title = documents.find((item) => item.id === candidate.sceneId)?.title ?? candidate.sceneId;
              const handoff = formatHandoffHint(candidate.deviceType, candidate.updatedAt, Date.now(), resume.deviceType);
              return <p key={candidate.sceneId}>
                <span>{title}</span>{handoff && <small>{handoff}</small>}
                <button type="button" onClick={() => { void selectDocument(candidate.sceneId).then((opened) => {
                  if (!opened) return;
                  setReading(false);
                  requestAnimationFrame(() => editorRef.current?.restorePosition({ cursorSentenceIndex: candidate.sentenceOffset, scrollTop: candidate.scrollTop ?? 0 }));
                }); }}>続きを書く</button>
                {candidate.pageIndex !== null && <button type="button" onClick={() => { void selectDocument(candidate.sceneId).then((opened) => {
                  if (!opened) return;
                  setReading(true);
                  setReadingPage(candidate.pageIndex ?? 0);
                }); }}>読書位置を開く</button>}
              </p>;
            })}
          </section>
          <ul className="pg-document-list">
            {documents.map((item) => <li key={item.id}>
              <button type="button" className={item.id === documentId ? "is-selected" : ""} aria-current={item.id === documentId ? "page" : undefined} onClick={() => void selectDocument(item.id)}>
                <span>{item.title}</span><small>{item.parentId ? `${documents.find((parent) => parent.id === item.parentId)?.title ?? "親文書"} · ` : ""}{item.kind}</small>
              </button>
            </li>)}
          </ul>
          {journal && active && <PersistenceLegacyDraftImport
            targetKey={JSON.stringify([authorScope, projectId, active.document.id, active.revision.id])}
            targetLabel={`${project.title} / ${active.document.title}`}
            beforeImport={beforeLegacyImport}
            onImport={importLegacyDraft}
          />}
          <form onSubmit={(event) => void createDocument(event)}>
            <label htmlFor="pg-document-title">文書を追加</label>
            <input id="pg-document-title" value={documentTitle} onChange={(event) => setDocumentTitle(event.target.value)} maxLength={256} required placeholder="章・シーン名" />
            <label htmlFor="pg-document-kind">文書の種類</label><select id="pg-document-kind" value={documentKind} onChange={(event) => setDocumentKind(event.target.value)}><option value="volume">巻</option><option value="chapter">章</option><option value="scene">シーン</option><option value="note">ノート</option></select>
            <label htmlFor="pg-document-parent">追加先</label>
            <select id="pg-document-parent" value={newDocumentParent} onChange={(event) => setNewDocumentParent(event.target.value)}>
              <option value="">作品の直下</option>
              {documents.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
            </select>
            <button type="submit" disabled={loading || !documentTitle.trim()}>文書を作成</button>
          </form>
          {active && <details><summary>選択文書の構成を変更</summary>
            <form onSubmit={(event) => { event.preventDefault(); if (renameTitle.trim()) void editStructure({ title: renameTitle.trim() }); }}><label htmlFor="pg-rename">新しい文書名</label><input id="pg-rename" value={renameTitle} onChange={(event) => setRenameTitle(event.target.value)} required maxLength={256} /><button type="submit">文書名を変更</button></form>
            <form onSubmit={(event) => { event.preventDefault(); void editStructure({ parentId: moveParent || null }); }}><label htmlFor="pg-move">移動先</label><select id="pg-move" value={moveParent} onChange={(event) => setMoveParent(event.target.value)}><option value="">作品の直下</option>{documents.filter((item) => item.id !== active.document.id).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select><button type="submit">文書を移動</button></form>
            <form onSubmit={(event) => { event.preventDefault(); void editStructure({ orderKey: String(orderRank).padStart(8, "0") }); }}><label htmlFor="pg-order">並び順</label><input id="pg-order" type="number" min="0" max="99999999" value={orderRank} onChange={(event) => setOrderRank(Number(event.target.value))} /><button type="submit">並び順を変更</button></form>
            <button type="button" onClick={() => { if (window.confirm(`「${active.document.title}」を削除しますか？保存済みRevisionは保持されます。`)) void editStructure({}, true); }}>文書を削除</button>
          </details>}
        </section>}
      </aside>);
  const editor = (<main className="pg-editor-column" aria-label="PostgreSQL原稿編集">
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
            <button type="button" onClick={() => { if (!editorRef.current) return; try { editorRef.current.readForNavigation(); window.print(); } catch (error) { setPageError(error instanceof Error ? error.message : "変換を確定してください。"); } }}>印刷</button>
            <button type="button" onClick={() => void loadRevisions()} disabled={active.dirty || Boolean(active.remoteConflict)}>Revision履歴</button>
            <button type="button" onClick={() => void createAnchor()} disabled={active.dirty || Boolean(active.remoteConflict) || active.save !== "saved"}>選択範囲をText Anchorにする</button>
          </div>
          <div className="pg-editor-actions" aria-label="原稿の表示と書式">
            <button type="button" aria-pressed={reading} onClick={() => void protectTransition().then((allowed) => { if (!allowed) return; setReading(!reading); if (reading) requestAnimationFrame(() => editorRef.current?.restorePosition(editorPositionRef.current)); })}>{reading ? "編集へ戻る" : "読む"}</button>
            <label>組版<select aria-label="組版プリセット" defaultValue="" onChange={(event) => { const next = { ...typography, ...typographyPresetValues(event.target.value as TypographyPresetId) }; setTypography(next); storeTypographySettings(next); }}><option value="" disabled>表示設定</option>{Object.entries(TYPOGRAPHY_PRESETS).map(([id, preset]) => <option key={id} value={id}>{preset.label}</option>)}</select></label>
            <label>文字サイズ<input aria-label="原稿の文字サイズ" type="number" min="14" max="24" value={typography.fontSize} onChange={(event) => { const next = { ...typography, fontSize: Math.max(14, Math.min(24, Number(event.target.value))) }; setTypography(next); storeTypographySettings(next); }} /></label>
            {reading && <label>組方向<select aria-label="組方向" value={readingDirection} onChange={(event) => setReadingDirection(event.target.value as "horizontal" | "vertical")}><option value="horizontal">横書き</option><option value="vertical">縦書き</option></select></label>}
            {!reading && WRITING_SYMBOLS.map((symbol) => <button key={symbol.id} type="button" aria-label={symbol.ariaLabel} onClick={() => editorRef.current?.insert(symbol.id)}>{symbol.label}</button>)}
          </div>
          <div hidden={reading}>
          <label id="pg-manuscript-label" htmlFor="manuscript">原稿 Markdown</label>
          <ManuscriptInput
            key={active.document.id}
            ref={editorRef}
            style={typographyStyle}
            resolveTerms={resolveTerms}
            termResolutionKey={moduleSnapshot ? snapshotKey(moduleSnapshot) : ""}
            onTermNavigate={handleTermNavigate}
            onCursorPositionChange={(cursorSentenceIndex, scrollTop) => { editorPositionRef.current = { cursorSentenceIndex, scrollTop }; resume.onWritingPosition(active.document.id, cursorSentenceIndex, scrollTop); }}
            onSelectionChange={(selection) => { textSelectionRef.current = selection; }}
            value={active.markdown}
            externalTextRevision={active.generation}
            readOnly={Boolean(journalError) || legacyImportBusy}
            onChange={onEditorChange}
            documentRevision={active.revision.id}
            evidenceState={active.evidence}
            evidenceLoadKey={active.evidenceLoadKey}
            evidenceSourceText={active.revision.markdown}
            evidenceRangeRequest={evidenceJump?.positionConfirmed && evidenceJump.projectId === projectId && evidenceJump.documentId === active.document.id && evidenceJump.revisionId === active.revision.id && !active.dirty && !active.remoteConflict ? evidenceJump : undefined}
            onEvidenceRangeResult={handleEvidenceRangeResult}
            onEvidenceChange={(evidence) => {
              const current = activeRef.current;
              if (current?.document.id === active.document.id) publishEditor({ ...current, evidence });
            }}
            labelledBy="pg-manuscript-label"
            placeholder="物語の続きを書く"
          />
          </div>
          {reading && <section aria-label="原稿の閲覧" className={`scene-reading scene-reading-${readingDirection}`} style={typographyStyle}><MobileReadingPager mode={readingDirection} pageIndex={readingPage} onPageIndexChange={(page) => { setReadingPage(page); resume.onReadingPage(active.document.id, page); }}><TermAwareRubyText text={active.markdown} resolveTerms={resolveTerms} onTermNavigate={handleTermNavigate} /></MobileReadingPager></section>}
          <p className="pg-editor-hint">{active.markdown.length}字 · UTF-16差分をRevisionへ保存します。本文を送る前にIndexedDBの回復Journalへ記録します。</p>

          {journal && <PersistenceScratch key={`${active.document.projectId}:${active.document.id}`} projectId={active.document.projectId} documentId={active.document.id} authorScope={authorScope} journal={journal} registerGuard={(guard) => { scratchGuardRef.current = guard; }} onSaved={async () => { const result = await api.persistenceDocuments(projectId); setDocuments(result.documents); setNotice("スクラッチを独立したノートとしてPostgreSQLへ保存しました。"); }} />}
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
      </main>);
  const knowledge = (<aside className="pg-knowledge" aria-label="KnowledgeとEvidence">
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
          {selectedNode && <KnowledgeContextInspector key={selectedNode.id} node={selectedNode} nodes={nodes} documentId={active?.document.id} revisionId={active?.revision.id} clean={Boolean(active&&!active.dirty&&!active.remoteConflict&&active.save==="saved")} selectedEvidenceId={selectedEvidenceId??""} evidenceLoadKey={active?.evidenceLoadKey??0} onOpenEvidence={(item)=>void openNodeEvidence(item)} onNodeUpdate={(updated)=>setNodes(current=>current.map(item=>item.id===updated.id?updated:item))} onMerge={(target,source)=>{setNodes(current=>current.filter(item=>item.id!==source.id).map(item=>item.id===target.id?target:item));setNodeId(target.id);setNotice("Knowledgeを統合しました。")}} />}
          {selectedNode && <section aria-label="Knowledgeの根拠">
            <h3>{selectedNode.name}の根拠</h3>
            {nodeEvidenceError && <p role="alert">{nodeEvidenceError}</p>}
            {!nodeEvidenceError && selectedNodeEvidence === null && <p role="status">根拠を読み込んでいます。</p>}
            {selectedNodeEvidence?.length === 0 && <p>このKnowledgeにリンクされた根拠はありません。</p>}
            <ul className="pg-node-evidence-list">
              {selectedNodeEvidence?.map((item) => {
                const { anchor, quote } = item;
                const link = item.mentions.find(({ link }) => link.nodeId === selectedNode.id)?.link;
                const title = documents.find((document) => document.id === anchor.documentId)?.title;
                const status = anchor.status === "confirmed" ? "確認済みの根拠" : anchor.status === "orphaned" ? "本文から削除" : anchor.status === "needs_review" ? "位置の再確認が必要" : "確認待ち";
                return <li key={anchor.id}>
                  <button type="button" disabled={!title} onClick={() => void openNodeEvidence(item)}>
                    <span>{title ?? "文書不明"}</span>
                    <q>{quote || "引用なし"}</q>
                    <small>{link?.status === "confirmed" ? "確定リンク" : "候補リンク"} · {status}</small>
                  </button>
                </li>;
              })}
            </ul>
          </section>}
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
              {anchor.target && <p>確定先: {anchor.target.label} <button type="button" onClick={() => setNodeId(anchor.target!.id)}>Knowledgeの根拠を表示</button></p>}
              {anchor.candidates?.map((candidate) => <p key={candidate.id}>候補: {candidate.label}</p>)}
              {anchor.status === "current" && selectedNode && <div className="pg-link-actions">
                <button type="button" onClick={() => void linkKnowledge(anchor.id, "proposed")}>候補としてリンク</button>
                <button type="button" disabled={selectedNode.status !== "confirmed"} onClick={() => void linkKnowledge(anchor.id, "confirmed")}>Knowledgeリンクを確定</button>
              </div>}
            </li>)}
          </ul>}
        </section>
      </aside>);
  const panels: WorkspacePanel[] = [
    { id: "outline", title: "作品と構成", render: () => library },
    { id: "editor", title: "原稿", render: () => editor },
    { id: "inspector", title: "KnowledgeとEvidence", render: () => knowledge },
  ];
  const readCurrentEditor = (): BrowserEditorDocument | null => {
    const current = activeRef.current;
    if (!current || !moduleSnapshot || moduleSnapshot.projectId !== current.document.projectId) return null;
    return { sceneId: current.document.id, documentPath: moduleFilesRef.current.find((file) => file.revision === current.revision.id)?.path ?? `documents/${current.document.id}.md`, documentRevision: current.revision.id,
      sceneRevision: current.revision.id, text: current.markdown, snapshot: moduleSnapshot, baseSnapshot: moduleSnapshot, baseSceneRevision: current.revision.id };
  };
  const modulePanels = availableModulePanels({ items: workspaceContributions(contributions, modules), contributions, modules, projectId, authorScope,
    snapshot: moduleSnapshot, journal, refresh: refreshModules, onProposalStored: () => { void refreshModules(); }, readCurrentEditor,
    navigateDocument: navigateReference,
  });
  panels.push({ id: "review", title: "提案レビュー", render: () => <>{moduleError && <p role="alert">{moduleError}</p>}<NativeChangeSetReview key={projectId} projectId={projectId} onApplied={refreshAfterNativeApply} />{journal && <ProposalReview projectId={projectId} authorScope={authorScope} journal={journal} proposals={proposals} onChange={() => { void refreshModules(); }} onStatus={(message) => setNotice(message)} />}</> }, ...modulePanels);
  const Shell = mode === "mobile" ? MobileShell : DesktopShell;
  const currentDesktopDurability = desktopDurabilityFor(active);
  return <div className={`pg-workspace pg-shell pg-${mode}`}>
    <Shell mode={mode}
      header={<><h1>Database workspace</h1><JobInbox /><ThemeControl mode={theme} error={themeError} onChange={(next) => { setTheme(next); applyThemeMode(next); try { persistThemeMode(next); setThemeError(""); } catch { setThemeError("外観設定をこのブラウザーへ保存できませんでした。"); } }} /><button type="button" onClick={() => void protectTransition().then((allowed) => { if (allowed) onSignOut(); })}>ログアウト</button></>}
      documentTitle={active?.document.title}
      documentContext={project?.title}
      desktopDurability={currentDesktopDurability}
      desktopDurabilityDetail={desktopDurabilityDetail(active, currentDesktopDurability)}
      library={library} editor={editor} tools={knowledge}
      status={<>{pageError && <p role="alert">{pageError}</p>}{loading && <p role="status">PostgreSQLの状態を読み込んでいます。</p>}</>}
      workspaceScope={`postgres:${authorScope}`}
      panels={panels}
      requestedPanel={requestedPanel}
      beforeLayoutChange={protectTransition}
      onSwitchMode={async () => { if (!await protectTransition()) return false; window.location.assign(switchPath); return true; }}
    />
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
