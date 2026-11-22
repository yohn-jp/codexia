import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type CSSProperties } from "react";
import { createPortal, flushSync } from "react-dom";
import { useNavigate } from "react-router-dom";
import { nextOrderKey, snapshotKey } from "@codexia/contracts";
import type { EditorTermSpan } from "../editor/terms";
import { useRecentActivityResume } from "../resume/useRecentActivityResume";
import { formatHandoffHint, loadWritingResume, loadReadingPage, mergeContinueCandidates } from "../resume/continueCandidates";
import type { BrowserEditorDocument, ModuleStatus, SnapshotId, UiContribution } from "@codexia/contracts";
import { availableModulePanels } from "../application/AvailableModulePanels";
import { workspaceContributions } from "../contributions/catalog";
import { ProposalReview } from "../contributions/ProposalReview";
import type { JournalProposal } from "../storage/journal";
import type { Document as PersistenceDocument, DocumentId, DocumentRevision, EvidenceId, KnowledgeNode, KnowledgeNodeId, Project as PersistenceProject, ProjectId, RevisionId } from "@codexia/persistence-contracts";
import { api, type PersistenceAnchorView } from "../api";
import { KnowledgeContextInspector } from "./KnowledgeContextInspector";
import { readWorkspaceSelectionForLocation, workspaceSelectionPath, writeWorkspaceSelection } from "./selection";
import { PersistenceLegacyDraftImport } from "./PersistenceLegacyDraftImport";
import { parseApplicationLocation, rememberUiMode, switchApplicationPath } from "../application/navigation";
import { PersistenceScratch, type ScratchGuard } from "./PersistenceScratch";
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
import { ManuscriptInput, type ManuscriptInputHandle, type ManuscriptPosition, type EvidenceRangeRequest } from "../editor/ManuscriptInput";
import { applyTextChanges, composeTextChanges, emptyDocumentEvidence, initializeDocumentEvidence, markEvidenceNeedsReview, type DocumentEvidenceState, type EditorEvidenceAdapter, type TextChange } from "../editor/evidence";
import { BrowserJournal, type PersistenceDraftTextChanges } from "../storage/journal";
import { createPostgresEditorEvidenceAdapter } from "../editor/postgresEvidenceAdapter";
import { NativeChangeSetReview } from "./NativeChangeSetReview";
import { RevisionDifference } from "./RevisionDifference";
import { DocumentOutlineTree } from "./DocumentOutlineTree";

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
  textChanges?: PersistenceDraftTextChanges;
  generation: number;
  dirty: boolean;
  recovery: "pending" | "stored" | "failed" | "other-tab";
  save: "idle" | "saving" | "saved" | "failed";
  error: string;
  remoteConflict: DocumentRevision | null;
  evidence: DocumentEvidenceState;
  evidenceLoadKey: number;
}

type ContinuePosition = ({ kind: "writing" } & ManuscriptPosition) | { kind: "reading"; pageIndex: number };

interface ContinueRequest {
  projectId: string;
  documentId: string;
  intent: number;
  position: ContinuePosition;
}

interface KnowledgeCreateIntent {
  projectId: string;
  id: KnowledgeNodeId;
  type: string;
  name: string;
  needsReconciliation: boolean;
}

interface EvidenceLoadIssue {
  projectId: string;
  documentId: string;
  revisionId: string;
  message: string;
  retrying: boolean;
}

interface EvidenceLoadPending {
  projectId: string;
  documentId: string;
  revisionId: string;
}

interface OutlineDocument extends PersistenceDocument {
  children: OutlineDocument[];
  misplaced?: boolean;
}

function documentKindLabel(kind: string): string {
  switch (kind) {
    case "volume": return "巻";
    case "chapter": return "章";
    case "scene": return "シーン";
    case "note": return "ノート";
    default: return "文書";
  }
}

function documentMoveTargets(documents: PersistenceDocument[], selected: PersistenceDocument): Array<{ id: string; label: string }> {
  const byId = new Map<string, PersistenceDocument>(documents
    .filter((document) => document.projectId === selected.projectId)
    .map((document) => [document.id, document]));
  const targets: Array<{ id: string; label: string }> = [];
  const labelCounts = new Map<string, number>();
  for (const target of byId.values()) {
    const visited = new Set<string>();
    const names: string[] = [];
    let ancestor: PersistenceDocument | undefined = target;
    while (ancestor && ancestor.id !== selected.id && !visited.has(ancestor.id)) {
      visited.add(ancestor.id);
      if (names.length < 3) names.push(ancestor.title);
      ancestor = ancestor.parentId ? byId.get(ancestor.parentId) : undefined;
    }
    if (ancestor) continue;
    const prefix = visited.size > names.length ? "… / " : "";
    const label = prefix + names.reverse().join(" / ") + " · " + documentKindLabel(target.kind);
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    targets.push({ id: target.id, label });
  }
  return targets.map((target) => labelCounts.get(target.label) === 1
    ? target : { ...target, label: target.label + " · " + target.id });
}

function knowledgeTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    person: "人物", character: "人物", place: "場所", event: "出来事",
    setting: "設定", term: "用語", object: "物・道具",
  };
  return labels[type] ?? "知識";
}

function buildDocumentOutline(documents: readonly PersistenceDocument[]): OutlineDocument[] {
  const nodes: OutlineDocument[] = documents.map((document) => ({ ...document, children: [] }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const roots: OutlineDocument[] = [];
  for (const node of nodes) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (!parent || parent.id === node.id) {
      if (node.parentId) node.misplaced = true;
      roots.push(node);
      continue;
    }
    let cursor: OutlineDocument | undefined = parent;
    let cycle = false;
    const visited = new Set<string>([node.id]);
    while (cursor) {
      if (visited.has(cursor.id)) { cycle = true; break; }
      visited.add(cursor.id);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    if (cycle) {
      node.misplaced = true;
      roots.push(node);
    } else parent.children.push(node);
  }
  // The document list already comes from PostgreSQL in order_key, id order.
  // Grouping preserves that sibling order, including ties and non-ASCII keys.
  return roots;
}

function filterDocumentOutline(items: readonly OutlineDocument[], query: string): OutlineDocument[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [...items];
  return items.flatMap((item) => {
    const children = filterDocumentOutline(item.children, normalized);
    return item.title.toLocaleLowerCase().includes(normalized) || children.length > 0
      ? [{ ...item, children }]
      : [];
  });
}

function findOutlineNode(items: readonly OutlineDocument[], id: string): OutlineDocument | null {
  for (const item of items) {
    if (item.id === id) return item;
    const found = findOutlineNode(item.children, id);
    if (found) return found;
  }
  return null;
}

function firstOutlineNodeId(items: readonly OutlineDocument[]): string | null {
  return items[0]?.id ?? null;
}

function outlineAncestors(items: readonly OutlineDocument[], id: string, ancestors: OutlineDocument[] = []): OutlineDocument[] | null {
  for (const item of items) {
    if (item.id === id) return ancestors;
    const found = outlineAncestors(item.children, id, [...ancestors, item]);
    if (found) return found;
  }
  return null;
}

interface PendingSave {
  projectId: string;
  documentId: string;
  baseRevisionId: string;
  baseMarkdown: string;
  markdown: string;
  changes: TextChange[];
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

const editorAdapter: EditorEvidenceAdapter = createPostgresEditorEvidenceAdapter();

function persistSelectionSafely(authorScope: string, selection: { projectId: string; documentId: string }): void {
  try { writeWorkspaceSelection(window.localStorage, authorScope, selection); } catch { /* Route and journal state do not depend on preferences. */ }
}

export function PersistenceWorkspace({ mode, authorScope, hosted = false, onSignOut, registerProtection, sessionBlocked = false }: {
  mode: "desktop" | "mobile";
  authorScope: string;
  hosted?: boolean;
  onSignOut: () => void;
  registerProtection?: (guard: (() => Promise<boolean>) | null) => void;
  sessionBlocked?: boolean;
}) {
  if (mode === "mobile") return <MobilePersistenceWorkspace hosted={hosted} authorScope={authorScope} onSignOut={onSignOut} registerProtection={registerProtection} sessionBlocked={sessionBlocked} />;
  return <PersistenceWorkspaceController mode="desktop" hosted={hosted} authorScope={authorScope} onSignOut={onSignOut} registerProtection={registerProtection} sessionBlocked={sessionBlocked} />;
}

function MobilePersistenceWorkspace({ hosted, authorScope, onSignOut, registerProtection, sessionBlocked }: { hosted: boolean; authorScope: string; onSignOut: () => void; registerProtection?: (guard: (() => Promise<boolean>) | null) => void; sessionBlocked: boolean }) {
  const navigate = useNavigate();
  const navigateUrl = useCallback((url: string, replace: boolean) => { navigate(url, { replace }); }, [navigate]);
  return <PersistenceWorkspaceController mode="mobile" hosted={hosted} authorScope={authorScope} onSignOut={onSignOut} navigateUrl={navigateUrl} registerProtection={registerProtection} sessionBlocked={sessionBlocked} />;
}

function PersistenceWorkspaceController({ mode, hosted, authorScope, onSignOut, navigateUrl, registerProtection, sessionBlocked = false }: {
  mode: "desktop" | "mobile";
  hosted: boolean;
  authorScope: string;
  onSignOut: () => void;
  navigateUrl?: (url: string, replace: boolean) => void;
  registerProtection?: (guard: (() => Promise<boolean>) | null) => void;
  sessionBlocked?: boolean;
}) {
  const sessionBlockedRef = useRef(sessionBlocked);
  sessionBlockedRef.current = sessionBlocked;
  const selectionRef = useRef((() => { try { return readWorkspaceSelectionForLocation(window.localStorage, authorScope, mode, window.location.href); } catch { return null; } })());
  const textSelectionRef = useRef<{ from: number; to: number; text: string } | null>(null);
  const legacyImportTargetRef = useRef<{ authorScope: string; projectId: string; documentId: string; revisionId: string; generation: number; markdown: string } | null>(null);
  const pageWasHiddenRef = useRef(false);
  const loadedDocumentsProjectRef = useRef<string | null>(null);
  const [reading, setReading] = useState(false);
  const [printSnapshot, setPrintSnapshot] = useState<{ documentId: string; generation: number; markdown: string } | null>(null);
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
  const moduleReadRef = useRef<{ snapshot: SnapshotId; files: Array<{ path: string; revision: string | null }> } | null>(null);
  const moduleSequenceRef = useRef(0);
  const [moduleSnapshot, setModuleSnapshot] = useState<SnapshotId | null>(null);
  const [proposals, setProposals] = useState<JournalProposal[]>([]);
  const [moduleError, setModuleError] = useState("");
  const [projects, setProjects] = useState<PersistenceProject[]>([]);
  const [explicitRouteDocumentId, setExplicitRouteDocumentId] = useState(() => {
    const route = parseApplicationLocation(window.location.href);
    return route?.mode === mode ? route.resource?.sceneId ?? "" : "";
  });
  const [projectId, setProjectId] = useState(() => selectionRef.current?.projectId ?? "");
  const [projectPageReady, setProjectPageReady] = useState(false);
  const [projectPageLoading, setProjectPageLoading] = useState(false);
  const [projectNextCursor, setProjectNextCursor] = useState<string | null>(null);
  const projectPageSequenceRef = useRef(0);
  const [nativeReviewEpoch, setNativeReviewEpoch] = useState(0);
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const [documents, setDocuments] = useState<PersistenceDocument[]>([]);
  const structureMutationRef = useRef(false);
  const [collapsedDocumentIds, setCollapsedDocumentIds] = useState<Set<string>>(() => new Set());
  const [outlineQuery, setOutlineQuery] = useState("");
  const [outlineZoomRoot, setOutlineZoomRoot] = useState<string | null>(null);
  const [outlineFocusedId, setOutlineFocusedId] = useState("");
  const [documentId, setDocumentId] = useState("");
  const lastOutlineSelectionRef = useRef("");
  const [nodes, setNodes] = useState<KnowledgeNode[]>([]);
  const [knowledgeListError, setKnowledgeListError] = useState("");
  const [knowledgeListLoading, setKnowledgeListLoading] = useState(false);
  const [knowledgeListRetryEpoch, setKnowledgeListRetryEpoch] = useState(0);
  const [knowledgeQuery, setKnowledgeQuery] = useState("");
  const [knowledgeTypeFilter, setKnowledgeTypeFilter] = useState("");
  const [knowledgeStatusFilter, setKnowledgeStatusFilter] = useState("");
  const [knowledgeNextCursor, setKnowledgeNextCursor] = useState<string | null>(null);
  const [knowledgeComplete, setKnowledgeComplete] = useState(false);
  const [knowledgeLegacyMode, setKnowledgeLegacyMode] = useState(false);
  const [knowledgePageLoading, setKnowledgePageLoading] = useState(false);
  const knowledgeBrowseSequenceRef = useRef(0);
  const refreshKnowledgeBrowse = useCallback(() => setKnowledgeListRetryEpoch((current) => current + 1), []);
  const [nodeId, setNodeId] = useState("");
  const [selectedKnowledgeNode, setSelectedKnowledgeNode] = useState<KnowledgeNode | null>(null);
  const [knowledgeSelectionError, setKnowledgeSelectionError] = useState<{ projectId: string; nodeId: string; message: string } | null>(null);
  const [nodeEvidence, setNodeEvidence] = useState<{ projectId: string; nodeId: string; evidence: PersistenceAnchorView[] } | null>(null);
  const [nodeEvidenceError, setNodeEvidenceError] = useState("");
  const [evidenceJump, setEvidenceJump] = useState<EvidenceJump>();
  const [active, setActive] = useState<ActiveDocument | null>(null);
  const activeRef = useRef<ActiveDocument | null>(null);
  const pendingSaveRef = useRef(new Map<string, PendingSave>());
  // Tracks only recovery records this editor instance successfully wrote. A clean
  // undo may remove that exact stale record, while IndexedDB's compare-and-delete
  // keeps a newer tab generation safe.
  const ownedDraftsRef = useRef(new Map<string, { generation: number; baseRevisionId: string; baseMarkdown: string; markdown: string }>());
  const draftChainsRef = useRef(new Map<string, Promise<boolean>>());
  const saveInFlightRef = useRef(false);
  const restoreInFlightRef = useRef(false);
  const [restoring, setRestoring] = useState(false);
  const saveControllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => { saveControllerRef.current?.abort(); }, []);
  const saveDocumentRef = useRef<() => Promise<void>>(async () => undefined);
  const scratchGuardRef = useRef<ScratchGuard | null>(null);
  const registerScratchGuard = useCallback((guard: ScratchGuard | null) => { scratchGuardRef.current = guard; }, []);
  const editorRef = useRef<ManuscriptInputHandle>(null);
  const [editorPortalContainer] = useState<HTMLElement | null>(() => {
    if (typeof document === "undefined") return null;
    const container = document.createElement("div");
    container.className = "pg-preserved-editor-container";
    container.hidden = true;
    container.inert = true;
    container.setAttribute("aria-hidden", "true");
    return container;
  });
  const editorPortalParkingRef = useRef<HTMLDivElement>(null);
  const attachEditorPortalParking = useCallback((parking: HTMLDivElement | null) => {
    editorPortalParkingRef.current = parking;
    if (parking && editorPortalContainer) parking.append(editorPortalContainer);
  }, [editorPortalContainer]);
  const transitionErrorRef = useRef("");
  const clientIdRef = useRef("");
  const openSequenceRef = useRef(0);
  const selectionIntentRef = useRef(0);
  const continueRequestRef = useRef<ContinueRequest | undefined>(undefined);
  const panelRequestSequenceRef = useRef(0);
  const creationInFlightRef = useRef(false);
  const projectCreationIntentRef = useRef<{ id: ProjectId; title: string } | null>(null);
  const documentCreationIntentRef = useRef<{
    projectId: string;
    documentId: DocumentId;
    parentId: DocumentId | null;
    kind: string;
    title: string;
    orderKey: string;
    appendToEnd: true;
    markdown: string;
    idempotencyKey: string;
  } | null>(null);
  const [resumeEpoch, setResumeEpoch] = useState(0);
  const [legacyImportBusy, setLegacyImportBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [workTransferBusy, setWorkTransferBusy] = useState(false);
  const [workTransferStatus, setWorkTransferStatus] = useState("");
  const [pageError, setPageError] = useState("");
  const [outlineError, setOutlineError] = useState("");
  const [outlineReadyProject, setOutlineReadyProject] = useState("");
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
  const [knowledgeCreateError, setKnowledgeCreateError] = useState<{ projectId: string; message: string } | null>(null);
  const knowledgeCreateIntentRef = useRef<KnowledgeCreateIntent | null>(null);
  const [knowledgeCreatePending, setKnowledgeCreatePending] = useState(false);
  const [knowledgeCreateUncertain, setKnowledgeCreateUncertain] = useState<{ projectId: string; nodeId: KnowledgeNodeId } | null>(null);
  const [revisions, setRevisions] = useState<DocumentRevision[]>([]);
  const [showRevisions, setShowRevisions] = useState(false);
  const [revisionCursor, setRevisionCursor] = useState<string | null>(null);
  const [revisionPageLoading, setRevisionPageLoading] = useState(false);
  const [revisionPageError, setRevisionPageError] = useState("");
  const revisionPageSequenceRef = useRef(0);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState("");
  const [evidenceLoadIssue, setEvidenceLoadIssue] = useState<EvidenceLoadIssue | null>(null);
  const [evidenceLoadPending, setEvidenceLoadPending] = useState<EvidenceLoadPending | null>(null);
  const evidenceReadSequenceRef = useRef(0);
  const evidenceReadControllerRef = useRef<AbortController | null>(null);
  const [requestedPanel, setRequestedPanel] = useState<WorkspacePanelRequest>();
  const [creationIntent, setCreationIntent] = useState<"project" | "document">();

  const resume = useRecentActivityResume({ binding: projectId ? { projectId, authorScope, projectScopeKey: projectId } : null, enabled: Boolean(projectId) });
  const project = projects.find((candidate) => candidate.id === projectId) ?? null;
  const selectedDocument = documents.find((candidate) => candidate.id === documentId) ?? null;
  const explicitRouteDocumentUnavailable = Boolean(explicitRouteDocumentId && outlineReadyProject === projectId &&
    selectionRef.current?.projectId === projectId && selectionRef.current.documentId === explicitRouteDocumentId &&
    !documents.some((candidate) => candidate.id === explicitRouteDocumentId));
  const missingExplicitRouteDocument = Boolean(project && explicitRouteDocumentUnavailable);
  const canCreateDocument = outlineReadyProject === projectId && !!projectId && documents.length < 999;
  const documentOutline = useMemo(() => buildDocumentOutline(documents), [documents]);
  const filteredDocumentOutline = useMemo(() => filterDocumentOutline(documentOutline, outlineQuery), [documentOutline, outlineQuery]);
  const zoomNode = useMemo(() => outlineZoomRoot ? findOutlineNode(documentOutline, outlineZoomRoot) : null, [documentOutline, outlineZoomRoot]);
  const zoomResults = useMemo(() => zoomNode ? filterDocumentOutline([zoomNode], outlineQuery) : [], [zoomNode, outlineQuery]);
  const visibleDocumentOutline = zoomNode ? zoomResults : filteredDocumentOutline;
  const outlineFocusId = findOutlineNode(visibleDocumentOutline, outlineFocusedId)?.id
    ?? findOutlineNode(visibleDocumentOutline, documentId)?.id
    ?? firstOutlineNodeId(visibleDocumentOutline);
  const zoomAncestors = outlineZoomRoot ? (outlineAncestors(documentOutline, outlineZoomRoot) ?? []) : [];
  const activeDocument = active?.document;
  const writingContext = useMemo(() => {
    const ancestors = activeDocument && outlineReadyProject === activeDocument.projectId
      ? outlineAncestors(documentOutline, activeDocument.id)
      : null;
    return [...(ancestors ?? [])].reverse().map((ancestor) => ancestor.title)
      .concat(project ? [project.title] : []).join(" / ");
  }, [activeDocument, documentOutline, outlineReadyProject, project]);
  const moveTargets = useMemo(() => activeDocument ? documentMoveTargets(documents, activeDocument) : [], [documents, activeDocument]);
  const moveTargetAvailable = !moveParent || moveTargets.some((target) => target.id === moveParent);
  useEffect(() => {
    if (!creationIntent || (hosted && creationIntent === "project")) return;
    let cancelled = false;
    let attempts = 0;
    const focusCreation = () => {
      if (cancelled || attempts++ >= 120) return;
      const selector = creationIntent === "project" ? ".pg-library-create" : ".pg-library-create-document";
      const details = Array.from(document.querySelectorAll<HTMLDetailsElement>(selector))
        .find((candidate) => candidate.getClientRects().length > 0);
      const input = details?.querySelector<HTMLInputElement>("input");
      if (!details || !input) {
        window.setTimeout(focusCreation, 50);
        return;
      }
      details.open = true;
      input.focus();
      if (document.activeElement === input) setCreationIntent(undefined);
      else window.setTimeout(focusCreation, 50);
    };
    window.setTimeout(focusCreation, 0);
    return () => { cancelled = true; };
  }, [creationIntent, hosted, requestedPanel?.sequence]);
  const openCreation = useCallback((kind: "project" | "document") => {
    if (hosted && kind === "project") return;
    setCreationIntent(kind);
    if (mode === "mobile") {
      const sequence = ++panelRequestSequenceRef.current;
      setRequestedPanel({ id: "outline", sequence });
    }
  }, [hosted, mode]);
  useEffect(() => {
    if (!documentId || !projectId) {
      lastOutlineSelectionRef.current = "";
      return;
    }
    const byId = new Map<string, PersistenceDocument>(documents.filter((document) => document.projectId === projectId).map((document) => [document.id, document]));
    const selected = byId.get(documentId);
    if (!selected) return; // A route can select a document before the list arrives.
    const ancestors: string[] = [];
    const visited = new Set<string>([documentId]);
    let parent = selected.parentId ? byId.get(selected.parentId) : undefined;
    while (parent && !visited.has(parent.id)) {
      ancestors.push(parent.id);
      visited.add(parent.id);
      parent = parent.parentId ? byId.get(parent.parentId) : undefined;
    }
    const selection = JSON.stringify([projectId, documentId, ancestors]);
    if (lastOutlineSelectionRef.current === selection) return;
    lastOutlineSelectionRef.current = selection;
    setCollapsedDocumentIds((current) => {
      if (!ancestors.some((id) => current.has(id))) return current;
      const next = new Set(current);
      for (const id of ancestors) next.delete(id);
      return next;
    });
  }, [documents, documentId, projectId]);
  const selectedNode = nodes.find((candidate) => candidate.id === nodeId && candidate.projectId === projectId)
    ?? (selectedKnowledgeNode?.id === nodeId && selectedKnowledgeNode.projectId === projectId ? selectedKnowledgeNode : null);
  const selectedNodeError = knowledgeSelectionError?.projectId === projectId && knowledgeSelectionError.nodeId === nodeId
    ? knowledgeSelectionError.message : "";
  const visibleKnowledgeNodes = knowledgeLegacyMode ? nodes.filter((node) =>
    node.name.toLocaleLowerCase().includes(knowledgeQuery.trim().toLocaleLowerCase()) &&
    (!knowledgeTypeFilter || node.type === knowledgeTypeFilter) &&
    (!knowledgeStatusFilter || node.status === knowledgeStatusFilter)) : nodes;
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
    const beforeUnload = (event: BeforeUnloadEvent) => {
      const current = activeRef.current;
      const unprotectedScratch = scratchGuardRef.current?.hasUnprotectedInput() ?? false;
      if (!current && !unprotectedScratch) return;
      if (unprotectedScratch) {
        event.preventDefault();
        event.returnValue = "";
        return;
      }
      if (!current) return;
      const key = JSON.stringify([current.document.projectId, current.document.id]);
      const owned = ownedDraftsRef.current.get(key);
      const unsafeUndo = Boolean(!current.dirty && current.markdown === current.baseMarkdown &&
        ((owned && current.generation > owned.generation) || draftChainsRef.current.has(key)));
      if ((current.dirty && current.recovery !== "stored") || unsafeUndo) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("pagehide", onPageHide); window.addEventListener("pageshow", onPageShow); window.addEventListener("beforeunload", beforeUnload);
    return () => { window.removeEventListener("pagehide", onPageHide); window.removeEventListener("pageshow", onPageShow); window.removeEventListener("beforeunload", beforeUnload); };
  }, [resume.flush]);

  useEffect(() => {
    if (sessionBlocked) return;
    const controller = new AbortController();
    const deepLinkProjectId = parseApplicationLocation(window.location.href)?.resource?.projectId;
    if (deepLinkProjectId) {
      setProjectId(deepLinkProjectId);
      setPageError("");
      return () => controller.abort();
    }
    setProjectPageLoading(true);
    void api.persistenceProjectPage(200, undefined, controller.signal).then((page) => {
      if (controller.signal.aborted || sessionBlockedRef.current) return;
      setProjects(page.projects);
      setProjectPageReady(true);
      setProjectNextCursor(page.nextCursor);
      setProjectId((current) => current || page.projects[0]?.id || "");
      setPageError("");
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setPageError(error instanceof Error ? error.message : "作品一覧を読み込めませんでした。");
    }).finally(() => {
      if (!controller.signal.aborted) setProjectPageLoading(false);
    });
    return () => controller.abort();
  }, [resumeEpoch, sessionBlocked]);

  useEffect(() => {
    if (sessionBlocked || !projectId || projects.some((project) => project.id === projectId)) return;
    const controller = new AbortController();
    const requestedProjectId = projectId;
    void api.persistenceProject(requestedProjectId, controller.signal).then(({ project }) => {
      if (controller.signal.aborted || projectIdRef.current !== requestedProjectId || sessionBlockedRef.current) return;
      setProjects((current) => current.some((item) => item.id === project.id)
        ? current.map((item) => item.id === project.id ? project : item)
        : [project, ...current]);
      setPageError("");
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && projectIdRef.current === requestedProjectId) {
        setPageError(`指定された作品 (${requestedProjectId}) を読み込めませんでした。${error instanceof Error ? error.message : "作品を取得できませんでした。"}`);
      }
    });
    return () => controller.abort();
  }, [projectId, projects, sessionBlocked]);

  async function loadMoreProjects(): Promise<void> {
    if (projectPageLoading || (projectPageReady && !projectNextCursor)) return;
    const sequence = ++projectPageSequenceRef.current;
    const cursor = projectPageReady ? projectNextCursor ?? undefined : undefined;
    setProjectPageLoading(true);
    try {
      const page = await api.persistenceProjectPage(200, cursor);
      if (sequence !== projectPageSequenceRef.current || sessionBlockedRef.current) return;
      setProjects((current) => {
        const byId = new Map(current.map((project) => [project.id, project]));
        for (const project of page.projects) byId.set(project.id, project);
        return [...byId.values()];
      });
      setProjectPageReady(true);
      setProjectNextCursor(page.nextCursor);
      setPageError("");
    } catch (error) {
      if (sequence === projectPageSequenceRef.current) {
        setPageError(error instanceof Error ? error.message : "作品一覧を読み込めませんでした。");
      }
    } finally {
      if (sequence === projectPageSequenceRef.current) setProjectPageLoading(false);
    }
  }

  useEffect(() => {
    if (sessionBlocked) return;
    setOutlineReadyProject("");
    setOutlineError("");
    if (!projectId) {
      setDocuments([]);
      setDocumentId("");
      publishEditor(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setPageError("");
    if (loadedDocumentsProjectRef.current !== projectId) {
      loadedDocumentsProjectRef.current = projectId;
      setDocuments([]);
      setNodes([]);
      setNodeId("");
      setSelectedKnowledgeNode(null);
      publishEditor(null);
    }
    void api.persistenceDocuments(projectId, undefined, controller.signal).then((documentResult) => {
      if (controller.signal.aborted || sessionBlockedRef.current || projectIdRef.current !== projectId) return;
      setDocuments(documentResult.documents);
      setOutlineReadyProject(projectId);
      setDocumentId((current) => {
        if (current && documentResult.documents.some((item) => item.id === current)) return current;
        if (explicitRouteDocumentId && projectId === selectionRef.current?.projectId && explicitRouteDocumentId === selectionRef.current.documentId) return explicitRouteDocumentId;
        return documentResult.documents.find((item) => projectId === selectionRef.current?.projectId && item.id === selectionRef.current.documentId)?.id ?? documentResult.documents[0]?.id ?? "";
      });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && projectIdRef.current === projectId) {
        setOutlineError(error instanceof Error ? error.message : "作品の内容を読み込めませんでした。");
      }
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [explicitRouteDocumentId, projectId, publishEditor, resumeEpoch, sessionBlocked]);

  useEffect(() => {
    if (sessionBlocked) return;
    const sequence = ++knowledgeBrowseSequenceRef.current;
    if (!projectId) {
      setNodes([]);
      setNodeId("");
      setSelectedKnowledgeNode(null);
      setKnowledgeListError("");
      setKnowledgeListLoading(false);
      return;
    }
    const controller = new AbortController();
    setKnowledgeListError("");
    setKnowledgeListLoading(true);
    setKnowledgePageLoading(false);
    setKnowledgeNextCursor(null);
    setKnowledgeComplete(false);
    setKnowledgeLegacyMode(false);
    setNodes([]);
    const delay = window.setTimeout(() => void api.persistenceKnowledgePage(projectId, {
      q: knowledgeQuery, type: knowledgeTypeFilter, status: knowledgeStatusFilter,
    }, controller.signal).then(async (result) => {
      if (controller.signal.aborted || sequence !== knowledgeBrowseSequenceRef.current || sessionBlockedRef.current || projectIdRef.current !== projectId) return;
      setNodes(result.nodes);
      if ("nextCursor" in result) {
        setKnowledgeLegacyMode(false);
        setKnowledgeNextCursor(result.nextCursor);
        setKnowledgeComplete(result.nextCursor === null);
      } else {
        setKnowledgeLegacyMode(true);
        setKnowledgeNextCursor(null);
        setKnowledgeComplete(true);
        // Older API builds ignore the new filter parameters. Recover the
        // previous bounded inventory (up to 500) so local fallback filtering
        // retains the old browse reach, while keeping coverage explicitly unknown.
        const legacy = await api.persistenceNodes(projectId, 500, controller.signal);
        if (controller.signal.aborted || sequence !== knowledgeBrowseSequenceRef.current || sessionBlockedRef.current || projectIdRef.current !== projectId) return;
        setNodes(legacy.nodes);
      }
      setKnowledgeListError("");
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && sequence === knowledgeBrowseSequenceRef.current && projectIdRef.current === projectId) {
        setKnowledgeListError(error instanceof Error ? error.message : "Knowledge一覧を読み込めませんでした。");
      }
    }).finally(() => {
      if (!controller.signal.aborted && sequence === knowledgeBrowseSequenceRef.current && projectIdRef.current === projectId) setKnowledgeListLoading(false);
    }), 200);
    return () => { window.clearTimeout(delay); controller.abort(); };
  }, [projectId, knowledgeQuery, knowledgeTypeFilter, knowledgeStatusFilter, knowledgeListRetryEpoch, resumeEpoch, sessionBlocked]);

  const loadMoreKnowledge = useCallback(async () => {
    if (!projectId || !knowledgeNextCursor || knowledgePageLoading) return;
    const cursor = knowledgeNextCursor;
    const selectedProjectId = projectId;
    const sequence = knowledgeBrowseSequenceRef.current;
    setKnowledgePageLoading(true);
    try {
      const result = await api.persistenceKnowledgePage(selectedProjectId, {
        q: knowledgeQuery, type: knowledgeTypeFilter, status: knowledgeStatusFilter, cursor,
      });
      if (sequence !== knowledgeBrowseSequenceRef.current || projectIdRef.current !== selectedProjectId || sessionBlockedRef.current) return;
      if (!("nextCursor" in result)) {
        const legacy = await api.persistenceNodes(selectedProjectId, 500);
        if (sequence !== knowledgeBrowseSequenceRef.current || projectIdRef.current !== selectedProjectId || sessionBlockedRef.current) return;
        setNodes(legacy.nodes);
        setKnowledgeLegacyMode(true);
        setKnowledgeNextCursor(null);
        setKnowledgeComplete(true);
        return;
      }
      setNodes(current => [...current, ...result.nodes]);
      setKnowledgeNextCursor(result.nextCursor);
      setKnowledgeComplete(result.nextCursor === null);
      setKnowledgeListError("");
    } catch (error) {
      if (sequence === knowledgeBrowseSequenceRef.current && projectIdRef.current === selectedProjectId && !sessionBlockedRef.current) setKnowledgeListError(error instanceof Error ? error.message : "Knowledge一覧を読み込めませんでした。");
    } finally { if (sequence === knowledgeBrowseSequenceRef.current && projectIdRef.current === selectedProjectId && !sessionBlockedRef.current) setKnowledgePageLoading(false); }
  }, [projectId, knowledgeNextCursor, knowledgePageLoading, knowledgeQuery, knowledgeTypeFilter, knowledgeStatusFilter]);

  useEffect(() => {
    setKnowledgeSelectionError(null);
    if (sessionBlocked || !projectId || !nodeId || selectedNode) return;
    // A canonical evidence link can point outside the current browse page.
    const controller = new AbortController();
    const isCurrent = () => !controller.signal.aborted && !sessionBlockedRef.current && projectIdRef.current === projectId;
    void api.persistenceNode(projectId, nodeId, controller.signal).then(({ node }) => {
      if (!isCurrent()) return;
      if (node.projectId !== projectId || node.id !== nodeId) throw new Error("Knowledgeの識別情報が一致しません。");
      setSelectedKnowledgeNode(node);
    }).catch((error: unknown) => {
      if (isCurrent()) setKnowledgeSelectionError({ projectId, nodeId, message: error instanceof Error ? error.message : "Knowledge詳細を読み込めませんでした。" });
    });
    return () => controller.abort();
  }, [projectId, nodeId, selectedNode?.id, sessionBlocked]);

  useEffect(() => {
    if (sessionBlocked) return;
    setNodeEvidence(null);
    setNodeEvidenceError("");
    if (!projectId || !selectedNode) return;
    const selectedId = selectedNode.id;
    const controller = new AbortController();
    void api.persistenceNodeEvidence(projectId, selectedId, 500, controller.signal).then((result) => {
      if (!controller.signal.aborted && !sessionBlockedRef.current) setNodeEvidence({
        projectId, nodeId: selectedId,
        evidence: result.evidence.filter((item) => item.mentions.some(({ link }) => link.nodeId === selectedId && link.status !== "rejected")),
      });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setNodeEvidenceError(error instanceof Error ? error.message : "根拠を読み込めませんでした。");
    });
    return () => controller.abort();
  }, [projectId, selectedNode?.id, active?.revision.id, active?.evidenceLoadKey, resumeEpoch, nativeReviewEpoch, sessionBlocked]);

  const refreshModules = useCallback(async () => {
    if (sessionBlockedRef.current || projectIdRef.current !== projectId) return;
    const sequence = ++moduleSequenceRef.current;
    if (!projectId) { moduleReadRef.current = null; setModuleSnapshot(null); setModules([]); setContributions([]); setProposals([]); return; }
    try {
      const [statuses, catalog, read, remote] = await Promise.all([api.modules(projectId), api.contributions(projectId), api.moduleSnapshot(projectId), api.proposalStatuses(projectId)]);
      if (sessionBlockedRef.current || sequence !== moduleSequenceRef.current) return;
      if (read.snapshot.projectId !== projectId) throw new Error("作品のRevisionが一致しません。");
      const currentJournal = journalRef.current;
      if (currentJournal) {
        for (const status of remote.proposals) await currentJournal.putProposal(projectId, authorScope, status.proposal, status);
        const localProposals = await currentJournal.getProposals(projectId, authorScope);
        if (sessionBlockedRef.current || sequence !== moduleSequenceRef.current || projectIdRef.current !== projectId) return;
        setProposals(localProposals);
      }
      if (sessionBlockedRef.current || sequence !== moduleSequenceRef.current || projectIdRef.current !== projectId) return;
      moduleReadRef.current = { snapshot: read.snapshot, files: read.files };
      setModules(statuses); setContributions(catalog); setModuleSnapshot(read.snapshot); setModuleError("");
    } catch (error) { if (sequence !== moduleSequenceRef.current) return; setModuleError(error instanceof Error ? error.message : "モジュールを読み込めませんでした。"); }
  }, [projectId, authorScope]);
  useEffect(() => { void refreshModules(); }, [refreshModules, journal, active?.revision.id, resumeEpoch, sessionBlocked]);

  const loadOpenEvidence = useCallback(async function loadOpenEvidence(
    identity: { projectId: string; documentId: string; revisionId: string; markdown: string },
    requestSequence: number,
  ): Promise<void> {
    evidenceReadControllerRef.current?.abort();
    const controller = new AbortController();
    evidenceReadControllerRef.current = controller;
    setEvidenceLoadPending({ projectId: identity.projectId, documentId: identity.documentId, revisionId: identity.revisionId });
    try {
      const snapshot = await editorAdapter.read(identity, controller.signal);
      if (controller.signal.aborted || requestSequence !== evidenceReadSequenceRef.current || sessionBlockedRef.current) return;
      const latest = activeRef.current;
      if (!latest || latest.document.projectId !== identity.projectId || latest.document.id !== identity.documentId) return;
      if (latest.revision.id !== identity.revisionId) {
        const nextSequence = ++evidenceReadSequenceRef.current;
        return loadOpenEvidence({
          projectId: latest.document.projectId,
          documentId: latest.document.id,
          revisionId: latest.revision.id,
          markdown: latest.revision.markdown,
        }, nextSequence);
      }
      const evidence = initializeDocumentEvidence(identity.markdown, identity.revisionId, snapshot);
      publishEditor({
        ...latest,
        evidence: latest.dirty || latest.remoteConflict ? markEvidenceNeedsReview(evidence) : evidence,
        evidenceLoadKey: latest.evidenceLoadKey + 1,
      });
      setEvidenceLoadPending(null);
      setEvidenceLoadIssue(null);
    } catch (error) {
      if (controller.signal.aborted || requestSequence !== evidenceReadSequenceRef.current || sessionBlockedRef.current) return;
      const latest = activeRef.current;
      if (!latest || latest.document.projectId !== identity.projectId || latest.document.id !== identity.documentId) return;
      if (latest.revision.id !== identity.revisionId) {
        const nextSequence = ++evidenceReadSequenceRef.current;
        return loadOpenEvidence({
          projectId: latest.document.projectId,
          documentId: latest.document.id,
          revisionId: latest.revision.id,
          markdown: latest.revision.markdown,
        }, nextSequence);
      }
      setEvidenceLoadPending(null);
      setEvidenceLoadIssue({
        projectId: identity.projectId,
        documentId: identity.documentId,
        revisionId: identity.revisionId,
        message: error instanceof Error ? error.message : "根拠を読み込めませんでした。",
        retrying: false,
      });
    } finally {
      if (evidenceReadControllerRef.current === controller) evidenceReadControllerRef.current = null;
    }
  }, [publishEditor]);

  const refreshAfterNativeApply = useCallback(() => {
    const appliedProjectId = projectId;
    if (projectIdRef.current !== appliedProjectId) return;
    setNativeReviewEpoch(current => current + 1);
    refreshKnowledgeBrowse();
    void refreshModules();
    const captured = activeRef.current;
    if (captured?.document.projectId === appliedProjectId) {
      const evidenceRequestSequence = ++evidenceReadSequenceRef.current;
      void loadOpenEvidence({
        projectId: appliedProjectId,
        documentId: captured.document.id,
        revisionId: captured.revision.id,
        markdown: captured.revision.markdown,
      }, evidenceRequestSequence);
    }
    void api.persistenceProject(appliedProjectId).then(({ project: projectResult }) => {
      if (projectIdRef.current !== appliedProjectId) return;
      setProjects((current) => current.map((item) => item.id === appliedProjectId ? projectResult : item));
    }).catch((error: unknown) => {
      if (projectIdRef.current === appliedProjectId) setNotice(error instanceof Error ? `適用後の作品状態を再読み込みできませんでした。${error.message}` : "適用後の作品状態を再読み込みできませんでした。");
    });
  }, [loadOpenEvidence, projectId, refreshModules, refreshKnowledgeBrowse]);

  const openDocument = useCallback(async (nextDocumentId: string): Promise<void> => {
    const currentProject = projects.find((item) => item.id === projectId);
    const currentJournal = journalRef.current;
    if (sessionBlockedRef.current || !currentProject || !currentJournal || !nextDocumentId) return;
    const openSequence = ++openSequenceRef.current;
    evidenceReadSequenceRef.current++;
    evidenceReadControllerRef.current?.abort();
    evidenceReadControllerRef.current = null;
    revisionPageSequenceRef.current += 1;
    setShowRevisions(false);
    setRevisions([]);
    setRevisionCursor(null);
    setRevisionPageLoading(false);
    setRevisionPageError("");
    setLoading(true);
    setPageError("");
    setNotice("");
    setEvidenceLoadIssue(null);
    setEvidenceLoadPending(null);
    publishEditor(null);
    try {
      const [read, draft] = await Promise.all([
        api.persistenceDocument(currentProject.id, nextDocumentId),
        currentJournal.getPersistenceDraft(currentProject.id, nextDocumentId, authorScope),
      ]);
      if (!read.revision) throw new Error("この文書にRevisionがありません。");
      const revision = read.revision;
      if (sessionBlockedRef.current || openSequence !== openSequenceRef.current) return;
      selectionRef.current = { projectId: currentProject.id, documentId: nextDocumentId };
      persistSelectionSafely(authorScope, selectionRef.current);
      updateRouteSelection(selectionRef.current, true);
      const staleDraft = Boolean(draft && (draft.baseRevisionId !== revision.id || draft.baseMarkdown !== revision.markdown));
      const recoveredSave = draft?.pendingSave;
      const recoverablePending = recoveredSave && typeof recoveredSave === "object" &&
        typeof recoveredSave.baseRevisionId === "string" && recoveredSave.baseRevisionId === draft.baseRevisionId &&
        typeof recoveredSave.baseMarkdown === "string" && recoveredSave.baseMarkdown === draft.baseMarkdown &&
        typeof recoveredSave.markdown === "string" && Number.isSafeInteger(recoveredSave.generation) && recoveredSave.generation >= 1 && recoveredSave.generation <= draft.generation &&
        Array.isArray(recoveredSave.changes) && recoveredSave.changes.every((change) => Boolean(change && typeof change === "object" && Number.isSafeInteger(change.from) && Number.isSafeInteger(change.to) && change.from >= 0 && change.to >= change.from && typeof change.insert === "string")) &&
        typeof recoveredSave.idempotencyKey === "string" && recoveredSave.idempotencyKey.length > 0 &&
        typeof recoveredSave.clientId === "string" && recoveredSave.clientId.length > 0
        ? { ...recoveredSave, projectId: currentProject.id, documentId: nextDocumentId }
        : undefined;
      const ownershipKey = JSON.stringify([currentProject.id, nextDocumentId]);
      if (recoverablePending) pendingSaveRef.current.set(ownershipKey, recoverablePending);
      else pendingSaveRef.current.delete(ownershipKey);
      const markdown = draft?.markdown ?? revision.markdown;
      const baseMarkdown = draft?.baseMarkdown ?? revision.markdown;
      const baseRevisionId = draft?.baseRevisionId ?? revision.id;
      const dirty = markdown !== baseMarkdown || (staleDraft && markdown !== revision.markdown);
      const textChanges = recoveredTextChanges(draft?.textChanges, baseMarkdown, markdown, recoverablePending);
      publishEditor({
        document: read.document,
        revision,
        baseRevisionId,
        baseMarkdown,
        markdown,
        textChanges,
        generation: dirty ? Math.max(1, draft?.generation ?? 0) : draft?.generation ?? 0,
        dirty,
        recovery: dirty ? "pending" : "stored",
        save: dirty ? "idle" : "saved",
        error: "",
        remoteConflict: staleDraft && !recoverablePending ? revision : null,
        evidence: { ...emptyDocumentEvidence(revision.markdown, revision.id), positionsTrusted: false },
        evidenceLoadKey: 1,
      });
      if (draft && staleDraft && !recoverablePending) setNotice("ブラウザーに保存された下書きのbase Revisionが変わっています。比較してから、どちらを使うか選んでください。");
      if (recoverablePending) setNotice("応答が失われた可能性のある保存操作を照合しています。");
      const requested = continueRequestRef.current;
      const explicitPosition = requested?.projectId === currentProject.id && requested.documentId === nextDocumentId &&
        requested.intent === selectionIntentRef.current;
      if (!explicitPosition) {
        const position = loadWritingResume(authorScope, currentProject.id);
        const intent = selectionIntentRef.current;
        if (position?.sceneId === nextDocumentId) requestAnimationFrame(() => {
          if (intent === selectionIntentRef.current && activeRef.current?.document.projectId === currentProject.id &&
              activeRef.current.document.id === nextDocumentId) editorRef.current?.restorePosition(position);
        });
      }
      setReadingPage(loadReadingPage(authorScope, currentProject.id, nextDocumentId));
      revisionPageSequenceRef.current += 1;
      setRevisions([]);
      setShowRevisions(false);
      setRevisionCursor(null);
      setRevisionPageLoading(false);
      setRevisionPageError("");
    } catch (error) {
      if (openSequence === openSequenceRef.current) setPageError(error instanceof Error ? error.message : "文書を開けませんでした。");
    } finally {
      if (openSequence === openSequenceRef.current) setLoading(false);
    }
  }, [authorScope, projectId, projects, publishEditor, updateRouteSelection]);

  const persistDraft = useCallback(async (value: ActiveDocument): Promise<boolean> => {
    const currentJournal = journalRef.current;
    if (!currentJournal) throw new Error(journalError || "IndexedDB回復Journalを利用できません。");
    if (value.recovery === "other-tab") return !value.dirty;
    const ownershipKey = JSON.stringify([value.document.projectId, value.document.id]);
    const ownership = { generation: value.generation, baseRevisionId: value.baseRevisionId, baseMarkdown: value.baseMarkdown, markdown: value.markdown };
    const preceding = draftChainsRef.current.get(ownershipKey) ?? Promise.resolve(true);
    const operation = preceding.catch(() => true).then(async () => {
      if (value.dirty && value.generation > 0) {
        const stored = await currentJournal.putPersistenceDraft({
          projectId: value.document.projectId,
          documentId: value.document.id,
          authorScope,
          baseRevisionId: value.baseRevisionId,
          baseMarkdown: value.baseMarkdown,
          markdown: value.markdown,
          textChanges: value.textChanges,
          generation: value.generation,
        });
        if (stored) ownedDraftsRef.current.set(ownershipKey, ownership);
        return stored;
      }

      const owned = ownedDraftsRef.current.get(ownershipKey);
      const latest = activeRef.current;
      const pending = pendingSaveRef.current.get(ownershipKey);
      if (!owned || latest?.document.id !== value.document.id || latest.document.projectId !== value.document.projectId ||
          latest.dirty || latest.generation !== value.generation || latest.markdown !== value.markdown ||
          value.markdown !== value.baseMarkdown || value.generation <= owned.generation ||
          (pending && pending.generation === owned.generation && pending.markdown === owned.markdown)) return true;
      // The journal compares generation and content in one transaction, so a
      // newer tab record cannot be removed by this undo cleanup.
      await currentJournal.removePersistenceDraft(value.document.projectId, value.document.id, authorScope, owned.generation, owned);
      if (ownedDraftsRef.current.get(ownershipKey) === owned) ownedDraftsRef.current.delete(ownershipKey);
      return true;
    });
    draftChainsRef.current.set(ownershipKey, operation);
    try { return await operation; }
    finally { if (draftChainsRef.current.get(ownershipKey) === operation) draftChainsRef.current.delete(ownershipKey); }
  }, [authorScope, journalError]);

  const revalidateActiveDocument = useCallback(async (signal: AbortSignal): Promise<void> => {
    const captured = activeRef.current;
    const currentProject = projects.find((item) => item.id === projectId);
    if (sessionBlockedRef.current || saveInFlightRef.current || restoreInFlightRef.current || !captured || !currentProject || captured.document.id !== documentId || captured.document.projectId !== projectId) return;
    const sequence = ++openSequenceRef.current;
    try {
      const read = await api.persistenceDocument(projectId, captured.document.id, signal);
      if (sessionBlockedRef.current || saveInFlightRef.current || restoreInFlightRef.current || signal.aborted || sequence !== openSequenceRef.current || !read.revision) return;
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
    if (sessionBlocked || !journal || !projectId || !documentId || explicitRouteDocumentUnavailable) return;
    const controller = new AbortController();
    const current = activeRef.current;
    if (current?.document.id === documentId && current.document.projectId === projectId) {
      void revalidateActiveDocument(controller.signal);
    } else {
      void openDocument(documentId);
    }
    return () => controller.abort();
  }, [documentId, explicitRouteDocumentUnavailable, journal, openDocument, projectId, revalidateActiveDocument, resumeEpoch, sessionBlocked]);

  useEffect(() => {
    if (!active || sessionBlocked) {
      evidenceReadSequenceRef.current++;
      evidenceReadControllerRef.current?.abort();
      evidenceReadControllerRef.current = null;
      setEvidenceLoadPending(null);
      return;
    }
    const requestSequence = ++evidenceReadSequenceRef.current;
    void loadOpenEvidence({
      projectId: active.document.projectId,
      documentId: active.document.id,
      revisionId: active.revision.id,
      markdown: active.revision.markdown,
    }, requestSequence);
    return () => {
      if (evidenceReadSequenceRef.current === requestSequence) {
        evidenceReadSequenceRef.current++;
        evidenceReadControllerRef.current?.abort();
        evidenceReadControllerRef.current = null;
      }
    };
  }, [active?.document.projectId, active?.document.id, authorScope, loadOpenEvidence, sessionBlocked]);

  useEffect(() => () => {
    evidenceReadSequenceRef.current++;
    evidenceReadControllerRef.current?.abort();
    evidenceReadControllerRef.current = null;
  }, []);

  useEffect(() => {
    if (!journal || !active || active.generation < 1) return;
    if (!active.dirty) {
      let cancelled = false;
      void persistDraft(active).then(async () => {
        if (cancelled || active.recovery !== "pending" || active.save !== "idle" || active.remoteConflict) return;
        const { projectId, id } = active.document;
        const remaining = await journal.getPersistenceDraft(projectId, id, authorScope);
        const latest = activeRef.current;
        if (cancelled || !latest || sessionBlockedRef.current || latest.document.projectId !== projectId || latest.document.id !== id ||
            latest.generation !== active.generation || latest.dirty || latest.recovery !== "pending" || latest.save !== "idle" ||
            latest.remoteConflict || latest.baseRevisionId !== latest.revision.id || latest.markdown !== latest.revision.markdown ||
            pendingSaveRef.current.has(JSON.stringify([projectId, id]))) return;
        if (remaining) {
          publishEditor({ ...latest, recovery: "other-tab", save: "failed", error: "別タブの回復用の下書きを保持しています。" });
        } else {
          publishEditor({ ...latest, recovery: "stored", save: "saved" });
        }
      }).catch((error: unknown) => {
        if (!cancelled) setJournalError(error instanceof Error ? error.message : "回復Journalの古い下書きを解除できませんでした。");
      });
      return () => { cancelled = true; };
    }
    if (active.recovery === "other-tab") return;
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
      if (!latest.remoteConflict && !sessionBlockedRef.current) timer = window.setTimeout(() => { void saveDocumentRef.current(); }, 900);
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
  }, [active?.document.id, active?.generation, active?.baseRevisionId, active?.markdown, authorScope, journal, persistDraft, publishEditor, sessionBlocked]);

  const saveDocument = useCallback(async (): Promise<void> => {
    const currentJournal = journalRef.current;
    if (!currentJournal || saveInFlightRef.current || restoreInFlightRef.current || sessionBlockedRef.current) return;
    const current = activeRef.current;
    if (!current || current.recovery === "other-tab" || current.remoteConflict) return;
    const pendingKey = JSON.stringify([current.document.projectId, current.document.id]);
    const existingPending = pendingSaveRef.current.get(pendingKey);
    let pending: PendingSave;
    if (!existingPending) {
      if (!current?.dirty || current.remoteConflict || current.recovery !== "stored") return;
      pending = {
        projectId: current.document.projectId,
        documentId: current.document.id,
        baseRevisionId: current.baseRevisionId,
        baseMarkdown: current.baseMarkdown,
        markdown: current.markdown,
        changes: current.textChanges && current.textChanges.afterSaveKey === undefined
          ? current.textChanges.changes : minimalTextChanges(current.baseMarkdown, current.markdown),
        generation: current.generation,
        idempotencyKey: crypto.randomUUID(),
        clientId: clientIdRef.current ||= crypto.randomUUID(),
      };
      pendingSaveRef.current.set(pendingKey, pending);
    } else pending = existingPending;
    saveInFlightRef.current = true;
    const controller = new AbortController();
    saveControllerRef.current = controller;
    const navigation = openSequenceRef.current;
    const inScope = (value: ActiveDocument | null): boolean => Boolean(value && value.document.projectId === pending.projectId && value.document.id === pending.documentId && navigation === openSequenceRef.current && !controller.signal.aborted);
    if (inScope(activeRef.current)) publishEditor({ ...activeRef.current!, save: "saving", error: "" });
    try {
      const bound = await currentJournal.bindPersistenceDraftSave(pending.projectId, pending.documentId, authorScope, {
        baseRevisionId: pending.baseRevisionId,
        baseMarkdown: pending.baseMarkdown,
        markdown: pending.markdown,
        changes: pending.changes,
        generation: pending.generation,
        idempotencyKey: pending.idempotencyKey,
        clientId: pending.clientId,
      });
      if (!bound) throw new Error("送信する保存操作をIndexedDB回復Journalへ確定できませんでした。");
      const result = await editorAdapter.save?.({
        projectId: pending.projectId,
        documentId: pending.documentId,
        revisionId: pending.baseRevisionId,
        markdown: pending.baseMarkdown,
      }, {
        baseMarkdown: pending.baseMarkdown,
        markdown: pending.markdown,
        changes: pending.changes,
        idempotencyKey: pending.idempotencyKey,
        clientId: pending.clientId,
      }, controller.signal);
      if (!result || result.markdown !== pending.markdown || !result.document || !result.revision || result.document.projectId !== pending.projectId || result.document.id !== pending.documentId || result.revision.projectId !== pending.projectId || result.revision.documentId !== pending.documentId || result.document.headRevisionId !== result.revision.id) {
        throw new Error("PostgreSQLの保存結果を確認できませんでした。");
      }
      if (controller.signal.aborted) return;
      const replayHead = existingPending ? await api.persistenceDocument(pending.projectId, pending.documentId, controller.signal) : undefined;
      if (existingPending && (!replayHead || !replayHead.revision || replayHead.document.projectId !== pending.projectId || replayHead.document.id !== pending.documentId || replayHead.document.headRevisionId !== replayHead.revision.id)) {
        throw new Error("再送した保存操作の最新Revisionを確認できませんでした。回復下書きは保持しています。");
      }
      const replayWasSuperseded = Boolean(replayHead?.revision && replayHead.revision.id !== result.revision.id);
      const acknowledgedDocument = replayHead?.document ?? result.document;
      const acknowledgedRevision = replayHead?.revision ?? result.revision;
      const acknowledgement = await currentJournal.acknowledgePersistenceDraftSave(pending.projectId, pending.documentId, authorScope, pending, result.revision.id, !replayWasSuperseded);
      const removed = acknowledgement.acknowledged && !acknowledgement.draft;
      if (removed) {
        const ownershipKey = JSON.stringify([pending.projectId, pending.documentId]);
        const owned = ownedDraftsRef.current.get(ownershipKey);
        if (owned?.generation === pending.generation && owned.markdown === pending.markdown && owned.baseRevisionId === pending.baseRevisionId && owned.baseMarkdown === pending.baseMarkdown) {
          ownedDraftsRef.current.delete(ownershipKey);
        }
      }
      const remaining = acknowledgement.acknowledged ? acknowledgement.draft : await currentJournal.getPersistenceDraft(pending.projectId, pending.documentId, authorScope);
      pendingSaveRef.current.delete(pendingKey);
      const latest = activeRef.current;
      if (replayWasSuperseded) {
        if (latest && inScope(latest) && replayHead?.revision) {
          const hasNewerText = latest.generation > pending.generation || latest.markdown !== pending.markdown;
          if (!acknowledgement.acknowledged) {
            publishEditor({ ...latest, document: replayHead.document, revision: replayHead.revision, recovery: "failed", save: "failed", error: "保存済みRevisionの照合を回復Journalへ反映できませんでした。下書きを保持して再確認してください。", remoteConflict: replayHead.revision });
          } else if (!hasNewerText) {
            publishEditor({ ...latest, document: replayHead.document, revision: replayHead.revision, baseRevisionId: replayHead.revision.id, baseMarkdown: replayHead.revision.markdown, markdown: replayHead.revision.markdown, textChanges: undefined, dirty: false, recovery: "stored", save: "saved", error: "", remoteConflict: null });
          } else {
            publishEditor({ ...latest, document: replayHead.document, revision: replayHead.revision, dirty: true, recovery: remaining ? "stored" : "pending", save: "failed", error: "保存操作の後にPostgreSQL上のRevisionが更新されました。回復Draftを保持し、比較してから適用してください。", remoteConflict: replayHead.revision });
          }
        } else if (latest?.document.id === pending.documentId && latest.document.projectId === pending.projectId) {
          setResumeEpoch((value) => value + 1);
        }
        return;
      }
      if (latest && inScope(latest)) {
        const hasNewerText = latest.generation > pending.generation || latest.markdown !== pending.markdown;
        const ownNewerDraft = hasNewerText && remaining !== undefined && remaining.generation === latest.generation + 1 && remaining.markdown === latest.markdown && remaining.baseRevisionId === result.revision.id && remaining.baseMarkdown === pending.markdown;
        const otherTab = Boolean(remaining && !ownNewerDraft);
        if (otherTab) {
          publishEditor({ ...latest, document: acknowledgedDocument, revision: acknowledgedRevision, baseRevisionId: acknowledgedRevision.id, baseMarkdown: pending.markdown, textChanges: undefined, dirty: hasNewerText, recovery: "other-tab", save: "failed", error: "この文書のより新しい回復記録が別タブに残っています。自動保存を停止しました。", remoteConflict: null });
          return;
        }
        publishEditor({
          ...latest,
          document: acknowledgedDocument,
          revision: acknowledgedRevision,
          baseRevisionId: acknowledgedRevision.id,
          baseMarkdown: pending.markdown,
          textChanges: hasNewerText && latest.textChanges?.afterSaveKey === pending.idempotencyKey
            ? { changes: latest.textChanges.changes } : undefined,
          dirty: hasNewerText,
          // A newer draft may already exist under the old base Revision at this generation.
          // Advance the generation so IndexedDB can persist the rebased record before retrying.
          generation: hasNewerText ? latest.generation + 1 : latest.generation,
          recovery: hasNewerText ? "pending" : "stored",
          save: hasNewerText ? "idle" : "saved",
          error: "",
          remoteConflict: null,
        });
      } else if (latest?.document.id === pending.documentId && latest.document.projectId === pending.projectId) {
        setResumeEpoch((value) => value + 1);
      } else if (latest?.dirty) {
        window.setTimeout(() => { void saveDocumentRef.current(); }, 0);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 409) {
        try {
          await currentJournal.clearPersistenceDraftSave(pending.projectId, pending.documentId, authorScope, pending);
        } catch (journalError) {
          const latest = activeRef.current;
          if (latest && inScope(latest)) publishEditor({ ...latest, recovery: "failed", save: "failed", error: journalError instanceof Error ? journalError.message : "確定的な保存競合を回復Journalへ反映できませんでした。" });
          return;
        }
        pendingSaveRef.current.delete(pendingKey);
        try {
          const currentRead = await api.persistenceDocument(pending.projectId, pending.documentId, controller.signal);
          const latest = activeRef.current;
          if (latest && inScope(latest)) {
            publishEditor({ ...latest, remoteConflict: currentRead.revision ?? null, save: "failed", error: currentRead.revision ? "PostgreSQL上のRevisionが先に更新されました。下書きはIndexedDBに残しています。" : "競合した最新Revisionを確認できません。下書きは保持しています。" });
          }
        } catch (readError) {
          const latest = activeRef.current;
          if (latest && inScope(latest)) publishEditor({ ...latest, save: "failed", error: readError instanceof Error ? readError.message : "競合した最新Revisionを読み込めませんでした。" });
        }
      } else {
        const latest = activeRef.current;
        if (latest && inScope(latest)) {
          publishEditor({ ...latest, save: "failed", error: error instanceof Error ? error.message : "PostgreSQLへ保存できませんでした。回復下書きは保持しています。" });
        }
      }
    } finally {
      saveInFlightRef.current = false;
      if (saveControllerRef.current === controller) saveControllerRef.current = null;
      const latest = activeRef.current;
      if (latest?.dirty && latest.recovery === "stored" && !latest.remoteConflict && (latest.document.id !== pending.documentId || latest.document.projectId !== pending.projectId) && !controller.signal.aborted) {
        window.setTimeout(() => { void saveDocumentRef.current(); }, 0);
      }
    }
  }, [authorScope, publishEditor]);

  saveDocumentRef.current = saveDocument;

  async function createProject(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const title = projectTitle.trim();
    if (!title || creationInFlightRef.current) return;
    creationInFlightRef.current = true;
    let creationStarted = false;
    try {
      if (!await protectTransition()) return;
      creationStarted = true;
    } finally {
      if (!creationStarted) creationInFlightRef.current = false;
    }
    const previousIntent = projectCreationIntentRef.current;
    const intent = previousIntent?.title === title
      ? previousIntent
      : { id: crypto.randomUUID() as ProjectId, title };
    projectCreationIntentRef.current = intent;
    setLoading(true);
    setPageError("");
    try {
      let result: Awaited<ReturnType<typeof api.createPersistenceProject>>;
      try {
        result = await api.createPersistenceProject({ id: intent.id, title: intent.title });
      } catch (createError) {
        // A timed-out response may have committed the project. Read the exact
        // client id before allowing another submission to allocate a project.
        try {
          const existing = await api.persistenceProject(intent.id);
          if (existing.project.title !== intent.title) {
            throw new Error("同じ作品IDに別の作品が存在するため、作成を完了できませんでした。作品名を確認してください。");
          }
          result = existing;
        } catch (readError) {
          throw readError instanceof Error && !(readError instanceof ApiError && readError.status === 404)
            ? readError
            : createError;
        }
      }
      if (result.project.id !== intent.id || result.project.title !== intent.title) {
        throw new Error("作成応答が要求した作品と一致しませんでした。作品名を確認してください。");
      }
      setProjects((current) => current.some((item) => item.id === result.project.id)
        ? current.map((item) => item.id === result.project.id ? result.project : item)
        : [result.project, ...current]);
      if (!await protectTransition()) return;
      selectionRef.current = { projectId: result.project.id, documentId: "" };
      persistSelectionSafely(authorScope, selectionRef.current);
      updateRouteSelection(selectionRef.current, false);
      setProjectId(result.project.id);
      setDocumentId("");
      setProjectTitle("");
      if (mode === "mobile" && projects.length === 0) {
        setRequestedPanel({ id: "editor", sequence: ++panelRequestSequenceRef.current });
      }
      projectCreationIntentRef.current = null;
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "作品を作成できませんでした。");
    } finally {
      creationInFlightRef.current = false;
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
        (archive.omittedRecords.length ? " セキュリティ保護のため除外された項目が " + archive.omittedRecords.length + " 項目あります。" : "") +
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
    const importSelection = selectionRef.current
      ? { ...selectionRef.current }
      : { projectId, documentId };
    const importEditor = activeRef.current;
    const importEditorIdentity = importEditor
      ? { projectId: importEditor.document.projectId, documentId: importEditor.document.id, generation: importEditor.generation, markdown: importEditor.markdown }
      : null;
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
      // Import commits before its response arrives. Protect input written while
      // the request was pending before changing the selected work. If protection
      // fails, keep the source editor in place and leave the imported work in the
      // project list so it can be opened without submitting the archive again.
      if (!await protectTransition()) {
        setWorkTransferStatus("作品JSONは取り込み済みです。元の原稿を保持しました。取り込み済みの作品は一覧から開けます。");
        return;
      }
      const latestSelection = selectionRef.current ?? { projectId, documentId };
      const latestEditor = activeRef.current;
      const sameSelection = latestSelection.projectId === importSelection.projectId &&
        latestSelection.documentId === importSelection.documentId;
      const sameEditor = importEditorIdentity === null
        ? latestEditor === null
        : latestEditor?.document.projectId === importEditorIdentity.projectId && latestEditor.document.id === importEditorIdentity.documentId;
      if (!sameSelection || !sameEditor) {
        setWorkTransferStatus("作品JSONは取り込み済みです。現在の選択を保持しました。取り込み済みの作品は一覧から開けます。");
        return;
      }
      const protectedInterveningInput = Boolean(importEditorIdentity && latestEditor &&
        (latestEditor.generation !== importEditorIdentity.generation || latestEditor.markdown !== importEditorIdentity.markdown));
      openSequenceRef.current += 1;
      publishEditor(null);
      selectionRef.current = { projectId: imported.project.id, documentId: "" };
      persistSelectionSafely(authorScope, selectionRef.current);
      updateRouteSelection(selectionRef.current, false);
      setDocumentId("");
      setProjectId(imported.project.id);
      setWorkTransferStatus((imported.replayed ? "このJSONは既に取り込み済みです。" : "新しい作品としてJSONを取り込みました。") +
        (protectedInterveningInput ? " 待機中の原稿は回復下書きに保護しました。" : "") +
        (imported.unresolvedAnchors ? " 旧RevisionのEvidence " + imported.unresolvedAnchors + " 件は記録を保持し、現在の文書には自動リンクしていません。" : "") +
        (imported.omittedRecords ? " 元データで機密設定など " + imported.omittedRecords + " 項目は除外済みです。" : ""));
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
    if (!title || creationInFlightRef.current) return;
    creationInFlightRef.current = true;
    let creationStarted = false;
    try {
      if (!await protectTransition()) return;
      if (!canCreateDocument) { setPageError("完全な目次を取得できていないか、文書数が現在の作品構成上限に達しています。"); return; }
      creationStarted = true;
    } finally {
      if (!creationStarted) creationInFlightRef.current = false;
    }
    const parentId = (newDocumentParent || null) as DocumentId | null;
    const previousIntent = documentCreationIntentRef.current;
    const intent = previousIntent && previousIntent.projectId === project.id && previousIntent.parentId === parentId && previousIntent.kind === documentKind && previousIntent.title === title
      ? previousIntent
      : {
          projectId: project.id,
          documentId: crypto.randomUUID() as DocumentId,
          parentId,
          kind: documentKind,
          title,
          // Older same-epoch backends use this advisory key. Modern PostgreSQL
          // assigns the actual key inside the project transaction. Replays
          // retain both values from this original intent.
          orderKey: nextOrderKey(documents.filter((document) => document.parentId === parentId).map((document) => document.orderKey)),
          appendToEnd: true as const,
          markdown: "",
          idempotencyKey: crypto.randomUUID(),
        };
    documentCreationIntentRef.current = intent;
    setLoading(true);
    setPageError("");
    try {
      let result: Awaited<ReturnType<typeof api.createPersistenceDocument>>;
      try {
        result = await api.createPersistenceDocument(project.id, intent);
      } catch (createError) {
        // Recover a committed document after an ambiguous timeout or a
        // canonical duplicate response, using the exact document id.
        try {
          const existing = await api.persistenceDocument(project.id, intent.documentId);
          if (existing.document.title !== intent.title) {
            throw new Error("同じ文書IDに別の文書が存在するため、作成を完了できませんでした。文書名を確認してください。");
          }
          if (!existing.revision) throw new Error("作成済み文書のRevisionを確認できませんでした。");
          result = { document: existing.document, revision: existing.revision, replayed: true };
        } catch (readError) {
          throw readError instanceof Error && !(readError instanceof ApiError && readError.status === 404)
            ? readError
            : createError;
        }
      }
      if (result.document.id !== intent.documentId || result.document.projectId !== intent.projectId || result.document.title !== intent.title) {
        throw new Error("作成応答が要求した文書と一致しませんでした。文書名を確認してください。");
      }
      // Refresh the canonical outline instead of assuming local order.
      if (projectIdRef.current !== project.id) return;
      setDocumentTitle("");
      let documentResult: Awaited<ReturnType<typeof api.persistenceDocuments>>;
      try {
        documentResult = await api.persistenceDocuments(project.id);
      } catch (error) {
        if (projectIdRef.current === project.id) {
          setOutlineReadyProject("");
          setOutlineError("文書は作成済みですが、目次を再取得できませんでした。" + (error instanceof Error ? error.message : ""));
        }
        return;
      }
      if (projectIdRef.current !== project.id || !await protectTransition() || projectIdRef.current !== project.id) return;
      setDocuments(documentResult.documents);
      setOutlineReadyProject(project.id);
      setOutlineError("");
      if (!documentResult.documents.some((item) => item.id === result.document.id)) {
        setPageError("文書は作成済みですが、現在の目次取得範囲に含まれていません。");
        return;
      }
      selectionRef.current = { projectId: project.id, documentId: result.document.id };
      persistSelectionSafely(authorScope, selectionRef.current);
      updateRouteSelection(selectionRef.current, false);
      setDocumentId(result.document.id);
      if (mode === "mobile" && documents.length === 0) {
        setRequestedPanel({ id: "editor", sequence: ++panelRequestSequenceRef.current });
      }
      documentCreationIntentRef.current = null;
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "文書を作成できませんでした。");
    } finally {
      creationInFlightRef.current = false;
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
      await scratchGuardRef.current?.protect();
      await protectEditorTransition(() => activeRef.current, () => {
        const markdown = editorRef.current?.readForNavigation();
        const current = activeRef.current;
        if (current && markdown !== undefined && markdown !== current.markdown) {
          const pending = pendingSaveRef.current.get(JSON.stringify([current.document.projectId, current.document.id]));
          publishEditor({
            ...current,
            markdown,
            textChanges: composeDraftChanges(current, pending, markdown, minimalTextChanges(current.markdown, markdown)),
            generation: current.generation + 1,
            dirty: markdown !== current.baseMarkdown || Boolean(pending && markdown !== pending.markdown),
            recovery: current.recovery === "other-tab" ? "other-tab" : "pending",
            save: current.recovery === "other-tab" ? "failed" : current.save === "saving" ? "saving" : "idle",
          });
        }
      }, persistDraft);
      return true;
    } catch (error) {
      transitionErrorRef.current = error instanceof Error ? error.message : "回復Journalを保存できませんでした。";
      setPageError(transitionErrorRef.current);
      return false;
    }
  }, [persistDraft, publishEditor, resume.flush]);

  useEffect(() => {
    registerProtection?.(protectTransition);
    return () => registerProtection?.(null);
  }, [registerProtection, protectTransition]);

  const selectDocument = useCallback(async (nextId: string, position?: ContinuePosition): Promise<boolean> => {
    // Navigation preflight is asynchronous. Only the latest requested selection
    // may publish a document, even when an earlier request finishes later.
    const intent = ++selectionIntentRef.current;
    continueRequestRef.current = undefined;
    setEvidenceJump(undefined);
    const alreadyOpen = nextId === documentId && selectionRef.current?.documentId === nextId &&
      activeRef.current?.document.id === nextId;
    if (alreadyOpen && !position) return true;
    if (!await protectTransition()) return false;
    if (intent !== selectionIntentRef.current) return false;
    if (position) {
      continueRequestRef.current = { projectId, documentId: nextId, intent, position };
      setRequestedPanel({ id: "editor", sequence: ++panelRequestSequenceRef.current });
    }
    if (alreadyOpen) return true;
    openSequenceRef.current += 1;
    publishEditor(null);
    selectionRef.current = { projectId, documentId: nextId };
    persistSelectionSafely(authorScope, selectionRef.current);
    updateRouteSelection(selectionRef.current, false);
    setReading(false);
    setDocumentId(nextId);
    return true;
  }, [authorScope, documentId, projectId, protectTransition, publishEditor, updateRouteSelection]);

  const requestedContinue = continueRequestRef.current;
  const activeContinue = requestedContinue?.projectId === active?.document.projectId &&
    requestedContinue?.documentId === active?.document.id && requestedContinue?.intent === selectionIntentRef.current
    ? requestedContinue : undefined;
  useEffect(() => {
    if (!activeContinue || continueRequestRef.current !== activeContinue || sessionBlockedRef.current) return;
    if (activeContinue.position.kind === "reading") {
      continueRequestRef.current = undefined;
      setReadingPage(activeContinue.position.pageIndex);
      setReading(true);
    } else {
      setReading(false);
    }
  }, [activeContinue]);
  const consumeWritingContinue = useCallback((position: ManuscriptPosition) => {
    const request = continueRequestRef.current;
    const current = activeRef.current;
    if (!request || request.position !== position || request.intent !== selectionIntentRef.current ||
        current?.document.id !== request.documentId || current.document.projectId !== request.projectId || sessionBlockedRef.current) return false;
    continueRequestRef.current = undefined;
    return true;
  }, []);

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
        textChanges: undefined,
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
      const intent = ++selectionIntentRef.current;
      if (nextProjectId === projectId && nextDocumentId === documentId) return;
      void (async () => {
        const allowed = await protectTransition();
        if (intent !== selectionIntentRef.current) return;
        if (!allowed) {
          updateRouteSelection(projectId ? { projectId, documentId } : null, true);
          return;
        }
        selectionRef.current = target;
        setExplicitRouteDocumentId(nextDocumentId);
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

  async function editStructure(
    update: { title?: string; parentId?: string | null; orderKey?: string },
    remove = false,
    requestedDocumentId?: string,
  ): Promise<void> {
    const selectedDocument = activeRef.current?.document;
    const targetDocumentId = requestedDocumentId ?? selectedDocument?.id;
    const target = selectedDocument && selectedDocument.id === targetDocumentId && selectedDocument.projectId === projectId
      ? selectedDocument
      : documents.find((document) => document.id === targetDocumentId && document.projectId === projectId);
    if (!target || projectIdRef.current !== projectId || structureMutationRef.current) return;
    structureMutationRef.current = true;
    try {
      if (!await protectTransition() || projectIdRef.current !== projectId) return;
      const targetProjectId = target.projectId;
      const requestEditor = activeRef.current;
      const requestGeneration = requestEditor?.document.projectId === targetProjectId && requestEditor.document.id === target.id
        ? requestEditor.generation : -1;
      let committed = false;
      setOutlineError("");
      try {
        if (remove) await api.deletePersistenceDocument(targetProjectId, target.id, target.version);
        else await api.updatePersistenceDocument(targetProjectId, target.id, { ...update, expectedVersion: target.version });
        committed = true;
        if (projectIdRef.current !== targetProjectId) return;
        const result = await api.persistenceDocuments(targetProjectId);
        if (projectIdRef.current !== targetProjectId) return;
        setDocuments(result.documents);
        setOutlineReadyProject(targetProjectId);
        setOutlineError("");
        if (remove) {
          const targetStillSelected = (): boolean => {
            const selection = selectionRef.current;
            const activeDocument = activeRef.current?.document;
            return projectIdRef.current === targetProjectId && selection?.projectId === targetProjectId &&
              selection.documentId === target.id && activeDocument?.projectId === targetProjectId &&
              activeDocument.id === target.id;
          };
          let mayTransition = targetStillSelected();
          const latest = activeRef.current;
          if (mayTransition && latest && latest.generation !== requestGeneration) {
            if (!await protectTransition()) {
              setOutlineError("文書は削除済みですが、現在の入力を回復Journalへ保護できないため別の文書へ移動していません。");
              mayTransition = false;
            } else if (projectIdRef.current !== targetProjectId) return;
            else mayTransition = targetStillSelected();
          }
          if (mayTransition) {
            openSequenceRef.current++;
            publishEditor(null);
            const nextDocumentId = result.documents[0]?.id ?? "";
            selectionRef.current = { projectId: targetProjectId, documentId: nextDocumentId };
            persistSelectionSafely(authorScope, selectionRef.current);
            updateRouteSelection(nextDocumentId ? selectionRef.current : { projectId: targetProjectId, documentId: "" }, true);
            setDocumentId(nextDocumentId);
          }
        } else {
          const document = result.documents.find((item) => item.id === target.id);
          const latest = activeRef.current;
          if (document && latest?.document.id === target.id) publishEditor({ ...latest, document });
        }
        await refreshModules();
      } catch (error) {
        if (projectIdRef.current !== targetProjectId) return;
        const message = error instanceof Error ? error.message : "構成を更新できませんでした。";
        if (committed) {
          setOutlineReadyProject("");
          setOutlineError((remove ? "文書は削除済みですが、目次を再取得できませんでした。" : "構成は変更済みですが、目次を再取得できませんでした。") + message);
        } else setPageError(message);
      }
    } finally {
      structureMutationRef.current = false;
    }
  }

  async function refreshEvidence(value = activeRef.current): Promise<void> {
    const currentProject = projects.find((item) => item.id === projectId);
    if (!currentProject || !value) return;
    const requestSequence = ++evidenceReadSequenceRef.current;
    evidenceReadControllerRef.current?.abort();
    const controller = new AbortController();
    evidenceReadControllerRef.current = controller;
    setEvidenceLoadPending({ projectId: currentProject.id, documentId: value.document.id, revisionId: value.revision.id });
    try {
      const snapshot = await editorAdapter.read({
        projectId: currentProject.id,
        documentId: value.document.id,
        revisionId: value.revision.id,
        markdown: value.revision.markdown,
      }, controller.signal);
      const latest = activeRef.current;
      if (controller.signal.aborted || requestSequence !== evidenceReadSequenceRef.current || sessionBlockedRef.current ||
          latest?.document.projectId !== currentProject.id || latest.document.id !== value.document.id) return;
      if (latest.revision.id !== value.revision.id) {
        const nextSequence = ++evidenceReadSequenceRef.current;
        void loadOpenEvidence({
          projectId: latest.document.projectId,
          documentId: latest.document.id,
          revisionId: latest.revision.id,
          markdown: latest.revision.markdown,
        }, nextSequence);
        return;
      }
      const evidence = initializeDocumentEvidence(value.revision.markdown, value.revision.id, snapshot);
      publishEditor({ ...latest, evidence: latest.dirty || latest.remoteConflict ? markEvidenceNeedsReview(evidence) : evidence, evidenceLoadKey: latest.evidenceLoadKey + 1 });
      setEvidenceLoadPending(null);
      setEvidenceLoadIssue(null);
    } catch (error) {
      if (controller.signal.aborted || requestSequence !== evidenceReadSequenceRef.current || sessionBlockedRef.current) return;
      const latest = activeRef.current;
      if (latest?.document.projectId === currentProject.id && latest.document.id === value.document.id && latest.revision.id !== value.revision.id) {
        const nextSequence = ++evidenceReadSequenceRef.current;
        void loadOpenEvidence({
          projectId: latest.document.projectId,
          documentId: latest.document.id,
          revisionId: latest.revision.id,
          markdown: latest.revision.markdown,
        }, nextSequence);
        return;
      }
      setEvidenceLoadPending(null);
      setEvidenceLoadIssue({
        projectId: currentProject.id,
        documentId: value.document.id,
        revisionId: value.revision.id,
        message: error instanceof Error ? error.message : "根拠を読み込めませんでした。",
        retrying: false,
      });
    } finally {
      if (evidenceReadControllerRef.current === controller) evidenceReadControllerRef.current = null;
    }
  }

  async function retryEvidence(): Promise<void> {
    const issue = evidenceLoadIssue;
    const value = activeRef.current;
    if (!issue || !value || issue.retrying || sessionBlockedRef.current ||
        value.document.projectId !== issue.projectId || value.document.id !== issue.documentId) return;
    const requestedRevisionId = value.revision.id;
    setEvidenceLoadIssue({ ...issue, revisionId: requestedRevisionId, retrying: true });
    const requestSequence = ++evidenceReadSequenceRef.current;
    void loadOpenEvidence({
      projectId: value.document.projectId,
      documentId: value.document.id,
      revisionId: requestedRevisionId,
      markdown: value.revision.markdown,
    }, requestSequence);
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
    setKnowledgeCreateError(null);
    const name = knowledgeName.trim();
    const currentIntent = knowledgeCreateIntentRef.current;
    const intent = currentIntent && currentIntent.projectId === project.id && currentIntent.type === knowledgeType && currentIntent.name === name
      ? currentIntent
      : { projectId: project.id, id: crypto.randomUUID() as KnowledgeNodeId, type: knowledgeType, name, needsReconciliation: false };
    knowledgeCreateIntentRef.current = intent;
    setKnowledgeCreatePending(true);
    const complete = (node: KnowledgeNode): void => {
      if (projectIdRef.current !== intent.projectId) return;
      knowledgeCreateIntentRef.current = null;
      setKnowledgeCreateUncertain(null);
      refreshKnowledgeBrowse();
      setNodeId(node.id);
      setSelectedKnowledgeNode(node);
      setKnowledgeName("");
      setNotice("Knowledge候補を保存しました。内容を確認してから確定してください。");
    };
    const matchesIntent = (node: KnowledgeNode): boolean => node.projectId === intent.projectId && node.id === intent.id &&
      node.type === intent.type && node.name === intent.name && node.status === "proposed" && Object.keys(node.attributes).length === 0;
    const reportCreateError = (message: string): void => {
      if (projectIdRef.current !== intent.projectId) return;
      if (mode === "mobile") setPageError(message);
      else setKnowledgeCreateError({ projectId: intent.projectId, message });
    };
    try {
      if (intent.needsReconciliation) {
        let existing: KnowledgeNode | null = null;
        try {
          ({ node: existing } = await api.persistenceNode(intent.projectId, intent.id));
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 404) {
            setKnowledgeCreateUncertain({ projectId: intent.projectId, nodeId: intent.id });
            reportCreateError("保存結果を確認できません。入力を保ったまま、同じ候補の保存結果を再確認してください。");
            return;
          }
        }
        if (existing) {
          if (matchesIntent(existing)) complete(existing);
          else {
            setKnowledgeCreateUncertain({ projectId: intent.projectId, nodeId: intent.id });
            reportCreateError("保存結果が入力内容と一致しません。候補を変更せず、保存結果を再確認してください。");
          }
          return;
        }
        intent.needsReconciliation = false;
        setKnowledgeCreateUncertain(null);
      }
      const result = await api.savePersistenceNode(intent.projectId, intent.id, {
        type: intent.type,
        name: intent.name,
        attributes: {},
        status: "proposed",
        expectedVersion: null,
      });
      complete(result.node);
    } catch (error) {
      intent.needsReconciliation = true;
      setKnowledgeCreateUncertain({ projectId: intent.projectId, nodeId: intent.id });
      const saveMessage = error instanceof Error ? error.message : "Knowledgeを保存できませんでした。";
      try {
        const { node } = await api.persistenceNode(intent.projectId, intent.id);
        if (matchesIntent(node)) complete(node);
        else reportCreateError("保存結果が入力内容と一致しません。候補を変更せず、保存結果を再確認してください。");
      } catch (readError) {
        if (readError instanceof ApiError && readError.status === 404) {
          intent.needsReconciliation = false;
          setKnowledgeCreateUncertain(null);
          reportCreateError(saveMessage);
        } else {
          reportCreateError("保存結果を確認できません。入力を保ったまま、同じ候補の保存結果を再確認してください。");
        }
      }
    } finally {
      setKnowledgeCreatePending(false);
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
      if (nodeId === node.id) setSelectedKnowledgeNode(result.node);
      refreshKnowledgeBrowse();
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

  async function loadRevisionPage(before: string | undefined, replace: boolean): Promise<void> {
    const requestedDocument = activeRef.current;
    if (!requestedDocument) return;
    const requestedProjectId = requestedDocument.document.projectId;
    const requestedDocumentId = requestedDocument.document.id;
    const requestedRevisionId = requestedDocument.revision.id;
    if (!project || project.id !== requestedProjectId) return;
    const navigationGeneration = openSequenceRef.current;
    const requestSequence = ++revisionPageSequenceRef.current;
    const requestOwnsState = () => requestSequence === revisionPageSequenceRef.current;
    const sameDocumentNavigation = () => !sessionBlockedRef.current &&
      requestSequence === revisionPageSequenceRef.current &&
      projectIdRef.current === requestedProjectId &&
      openSequenceRef.current === navigationGeneration &&
      activeRef.current?.document.projectId === requestedProjectId &&
      activeRef.current.document.id === requestedDocumentId;
    const requestIsCurrent = () => sameDocumentNavigation() && activeRef.current?.revision.id === requestedRevisionId;
    setRevisionPageLoading(true);
    setRevisionPageError("");
    try {
      const page = await api.persistenceRevisions(requestedProjectId, requestedDocumentId, 50, before);
      if (!requestIsCurrent()) return;
      setRevisions((current) => {
        if (replace) return [...page.revisions];
        const seen = new Set(current.map((revision) => revision.id));
        return [...current, ...page.revisions.filter((revision) => !seen.has(revision.id))];
      });
      setRevisionCursor(page.nextBefore);
    } catch (error) {
      if (requestIsCurrent()) setRevisionPageError(error instanceof Error ? error.message : "Revision履歴を読み込めませんでした。");
    } finally {
      if (!requestOwnsState()) return;
      if (sameDocumentNavigation() && activeRef.current?.revision.id !== requestedRevisionId) {
        setRevisions([]);
        setRevisionCursor(null);
        setRevisionPageError("");
        void loadRevisionPage(undefined, true);
      } else if (sameDocumentNavigation()) {
        setRevisionPageLoading(false);
      }
    }
  }

  async function loadRevisions(): Promise<void> {
    if (showRevisions) {
      revisionPageSequenceRef.current += 1;
      setShowRevisions(false);
      setRevisions([]);
      setRevisionCursor(null);
      setRevisionPageLoading(false);
      setRevisionPageError("");
      return;
    }
    const requestedDocument = activeRef.current;
    if (!project || !requestedDocument || requestedDocument.document.projectId !== project.id) return;
    setShowRevisions(true);
    setRevisions([]);
    setRevisionCursor(null);
    setRevisionPageError("");
    void loadRevisionPage(undefined, true);
  }

  function loadMoreRevisions(): void {
    if (!revisionCursor || revisionPageLoading) return;
    void loadRevisionPage(revisionCursor, false);
  }

  async function restoreRevision(source: DocumentRevision): Promise<void> {
    const captured = activeRef.current;
    if (!project || !captured || captured.dirty || captured.remoteConflict || saveInFlightRef.current || restoreInFlightRef.current || sessionBlockedRef.current) return;
    if (source.projectId !== captured.document.projectId || source.documentId !== captured.document.id) return;
    if (!await protectTransition()) return;
    const current = activeRef.current;
    if (!current || current !== captured || current.dirty || restoreInFlightRef.current || saveInFlightRef.current || sessionBlockedRef.current) return;
    const navigation = openSequenceRef.current;
    const projectId = captured.document.projectId;
    const documentId = captured.document.id;
    const stillSelected = () => openSequenceRef.current === navigation && activeRef.current?.document.projectId === projectId && activeRef.current?.document.id === documentId;
    const unchanged = () => stillSelected() && activeRef.current?.generation === captured.generation && activeRef.current?.revision.id === captured.revision.id && activeRef.current?.markdown === captured.markdown;
    restoreInFlightRef.current = true;
    setRestoring(true);
    setPageError("");
    try {
      const restored = await api.restorePersistenceDocument(projectId, documentId, {
        baseRevisionId: captured.revision.id as RevisionId,
        sourceRevisionId: source.id as RevisionId,
        idempotencyKey: crypto.randomUUID(),
      });
      if (restored.document.projectId !== projectId || restored.document.id !== documentId || restored.revision.projectId !== projectId || restored.revision.documentId !== documentId || restored.document.headRevisionId !== restored.revision.id) throw new Error("復元結果の識別子が一致しません。");
      if (!unchanged()) {
        if (stillSelected() && activeRef.current) publishEditor({ ...activeRef.current, remoteConflict: restored.revision, save: "failed", error: "復元中に原稿が変わりました。現在の入力を保持しています。" });
        else setResumeEpoch((value) => value + 1);
        return;
      }
      const snapshot = await editorAdapter.read({ projectId, documentId, revisionId: restored.revision.id, markdown: restored.revision.markdown }, new AbortController().signal);
      if (!unchanged()) {
        if (stillSelected() && activeRef.current) publishEditor({ ...activeRef.current, remoteConflict: restored.revision, save: "failed", error: "復元中に原稿が変わりました。現在の入力を保持しています。" });
        else setResumeEpoch((value) => value + 1);
        return;
      }
      const latest = activeRef.current!;
      publishEditor({
        ...latest, document: restored.document, revision: restored.revision,
        baseRevisionId: restored.revision.id, baseMarkdown: restored.revision.markdown, markdown: restored.revision.markdown,
        textChanges: undefined,
        generation: latest.generation + 1, dirty: false, recovery: "stored", save: "saved", error: "", remoteConflict: null,
        evidence: initializeDocumentEvidence(restored.revision.markdown, restored.revision.id, snapshot), evidenceLoadKey: latest.evidenceLoadKey + 1,
      });
      setNotice("選んだRevisionを新しいPostgreSQL Revisionとして復元しました。");
      revisionPageSequenceRef.current += 1;
      setShowRevisions(false);
      setRevisions([]);
      setRevisionCursor(null);
      setRevisionPageLoading(false);
      setRevisionPageError("");
    } catch (error) {
      if (!stillSelected()) { setResumeEpoch((value) => value + 1); return; }
      if (error instanceof ApiError && error.status === 409) {
        try {
          const latest = await api.persistenceDocument(projectId, documentId);
          if (!stillSelected()) return;
          if (!latest.revision) throw new Error("競合した最新Revisionを確認できませんでした。");
          const current = activeRef.current!;
          publishEditor({ ...current, remoteConflict: latest.revision, save: "failed", error: "復元前にRevisionが更新されました。最新Revisionを確認してください。" });
        } catch (cause) {
          if (stillSelected()) setPageError(cause instanceof Error ? cause.message : "競合した最新Revisionを確認できませんでした。");
        }
      } else {
        setPageError(error instanceof Error ? error.message : "Revisionを復元できませんでした。");
        setResumeEpoch((value) => value + 1);
      }
    } finally {
      restoreInFlightRef.current = false;
      setRestoring(false);
      const latest = activeRef.current;
      if (latest?.dirty && latest.recovery === "stored" && !latest.remoteConflict) void saveDocumentRef.current();
    }
  }

  async function useDatabaseRevision(): Promise<void> {
    const current = activeRef.current;
    const remote = current?.remoteConflict;
    const currentJournal = journalRef.current;
    if (!project || !current || !remote || !currentJournal || sessionBlockedRef.current) return;
    const navigation = openSequenceRef.current;
    const stillCurrent = () => navigation === openSequenceRef.current && activeRef.current?.document.id === current.document.id && activeRef.current.document.projectId === current.document.projectId && activeRef.current.generation === current.generation && activeRef.current.markdown === current.markdown;
    try {
      const read = await api.persistenceDocument(project.id, current.document.id);
      if (!read.revision) throw new Error("最新Revisionを読み込めませんでした。");
      const snapshot = await editorAdapter.read({ projectId: project.id, documentId: current.document.id, revisionId: read.revision.id, markdown: read.revision.markdown }, new AbortController().signal);
      if (!stillCurrent()) return;
      const existing = await currentJournal.getPersistenceDraft(project.id, current.document.id, authorScope);
      if (!stillCurrent()) return;
      const removed = existing ? existing.generation === current.generation && existing.markdown === current.markdown && existing.baseRevisionId === current.baseRevisionId && await currentJournal.removePersistenceDraft(project.id, current.document.id, authorScope, current.generation, current) : !current.dirty;
      if (!stillCurrent()) return;
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
        textChanges: undefined,
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
      textChanges: undefined,
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

  const onEditorChange = useCallback((markdown: string, changes: TextChange[]) => {
    const current = activeRef.current;
    if (!current || markdown === current.markdown) return;
    const pending = pendingSaveRef.current.get(JSON.stringify([current.document.projectId, current.document.id]));
    const textChanges = composeDraftChanges(current, pending, markdown, changes);
    publishEditor({ ...current, markdown, textChanges, generation: current.generation + 1, dirty: markdown !== current.baseMarkdown || Boolean(pending && markdown !== pending.markdown), recovery: current.recovery === "other-tab" ? "other-tab" : "pending", save: current.save === "saving" ? "saving" : current.recovery === "other-tab" ? "failed" : "idle", error: current.recovery === "other-tab" ? current.error : "" });
  }, [publishEditor]);

  const selectProject = async (nextProjectId: string): Promise<void> => {
    if (nextProjectId === projectId) return;
    const intent = ++selectionIntentRef.current;
    if (!await protectTransition() || intent !== selectionIntentRef.current) return;
    continueRequestRef.current = undefined;
    openSequenceRef.current += 1;
    publishEditor(null);
    selectionRef.current = { projectId: nextProjectId, documentId: "" };
    persistSelectionSafely(authorScope, selectionRef.current);
    updateRouteSelection(selectionRef.current, false);
    setDocumentId("");
    setProjectId(nextProjectId);
    setOutlineQuery("");
    setOutlineZoomRoot(null);
    setOutlineFocusedId("");
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

  async function openNodeEvidence(item: { anchor: Pick<PersistenceAnchorView["anchor"], "projectId" | "documentId" | "revisionId" | "fromUtf16" | "toUtf16" | "status">; quote: string }): Promise<void> {
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
          {(projects.length > 0 || projectId) && <label htmlFor="pg-project">作品</label>}
          {(projects.length > 0 || projectId) && <select id="pg-project" value={projectId} onChange={(event) => void selectProject(event.target.value)}>
            {projectId && !projects.some((item) => item.id === projectId) && <option value={projectId} disabled>指定した作品を取得できません ({projectId})</option>}
            {projects.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select>}
          {projectId && projects.length === 0 && <p>指定された作品ID: {projectId}</p>}
          {(!projectPageReady || projectNextCursor) && <button type="button" onClick={() => void loadMoreProjects()} disabled={projectPageLoading}>
            {projectPageLoading ? "作品一覧を読み込み中" : projectPageReady ? "さらに作品を読み込む" : "作品一覧を読み込む"}
          </button>}
          {projectPageReady && <p>読み込み済みの作品: {projects.length}</p>}
          {!hosted && <details className="pg-library-create">
            <summary>作品を作成</summary>
            <form onSubmit={(event) => void createProject(event)}>
              <label htmlFor="pg-project-title">作品名</label>
              <input id="pg-project-title" value={projectTitle} onChange={(event) => setProjectTitle(event.target.value)} maxLength={256} required placeholder="作品名" />
              <button type="submit" disabled={loading || !projectTitle.trim()}>作成</button>
            </form>
          </details>}
          <details>
            <summary>{hosted ? "作品のエクスポート" : "作品のエクスポート・インポート"}</summary>
            <p>Markdown本文・構成・Knowledge・Evidence・作者データを作品JSONで持ち出せます。PostgreSQLの全Revision履歴やブラウザーの下書きは含まれません。</p>
            {project && <button type="button" disabled={workTransferBusy || loading} onClick={() => void exportCurrentWork()}>
              選択中の作品をJSONでエクスポート
            </button>}
            {!hosted && <>
              <label htmlFor="pg-work-import">作品JSONをインポート（既存作品は上書きしません）</label>
              <input id="pg-work-import" type="file" accept=".json,application/json" disabled={workTransferBusy || loading}
                onChange={(event) => void importPortableWork(event)} />
            </>}
            {workTransferBusy && <p role="status">作品データを処理中です。</p>}
            {workTransferStatus && <p role="status">{workTransferStatus}</p>}
          </details>
        </section>
        {project && <section>
          <h2>目次</h2>
          <details className="pg-library-continue">
            <summary>続きを開く</summary>
            <section className="continue-panel" aria-label="続きから">
              {resume.error && <p role="status">再開位置を同期できません: {resume.error}</p>}
              {mergeContinueCandidates(resume.localWriting, resume.items, { documents }).map((candidate) => {
                const title = documents.find((item) => item.id === candidate.sceneId)?.title ?? candidate.sceneId;
                const handoff = formatHandoffHint(candidate.deviceType, candidate.updatedAt, Date.now(), resume.deviceType);
                return <p key={candidate.sceneId}>
                  <span>{title}</span>{handoff && <small>{handoff}</small>}
                  <button type="button" onClick={() => void selectDocument(candidate.sceneId, {
                    kind: "writing", cursorSentenceIndex: candidate.sentenceOffset, scrollTop: candidate.scrollTop ?? 0,
                  })}>続きを書く</button>
                  {candidate.pageIndex !== null && <button type="button" onClick={() => void selectDocument(candidate.sceneId, {
                    kind: "reading", pageIndex: candidate.pageIndex ?? 0,
                  })}>読書位置を開く</button>}
                </p>;
              })}
            </section>
          </details>
          {outlineError && <p className="pg-alert" role="alert">{outlineError}</p>}
          {!outlineError && documents.length >= 999 && <p>現在の作品構成上限に達しています。文書を追加できません。</p>}
          <label className="pg-outline-search" htmlFor="pg-outline-search">構成を検索</label>
          <input id="pg-outline-search" value={outlineQuery} onChange={(event) => setOutlineQuery(event.target.value)} placeholder="文書名を検索" />
          {project && <nav className="pg-outline-breadcrumb" aria-label="構成の階層">
            <button type="button" onClick={() => setOutlineZoomRoot(null)} aria-current={outlineZoomRoot ? undefined : "page"}>全体</button>
            {zoomAncestors.map((ancestor) => <span key={ancestor.id}><span aria-hidden="true"> › </span><button type="button" onClick={() => setOutlineZoomRoot(ancestor.id)}>{ancestor.title}</button></span>)}
            {zoomNode && <span><span aria-hidden="true"> › </span><strong>{zoomNode.title}</strong></span>}
          </nav>}
          <DocumentOutlineTree
            items={visibleDocumentOutline}
            selectedId={documentId}
            focusedId={outlineFocusId ?? ""}
            onFocusedIdChange={setOutlineFocusedId}
            collapsedIds={collapsedDocumentIds}
            onCollapsedIdsChange={setCollapsedDocumentIds}
            forceExpanded={Boolean(outlineQuery || outlineZoomRoot)}
            busy={loading}
            onSelect={(id) => { void selectDocument(id); }}
            onZoom={setOutlineZoomRoot}
            onRename={(id, title) => { void editStructure({ title }, false, id); }}
            onMove={async (id, parentId) => {
              const source = documents.find((item) => item.id === id && item.projectId === projectId);
              if (!source || source.parentId === parentId) return;
              const orderKey = nextOrderKey(documents.filter((item) =>
                item.projectId === projectId && item.parentId === parentId && item.id !== id).map((item) => item.orderKey));
              await editStructure({ parentId, orderKey }, false, id);
            }}
            kindLabel={documentKindLabel}
          />
          {journal && active && <PersistenceLegacyDraftImport
            targetKey={JSON.stringify([authorScope, projectId, active.document.id, active.revision.id])}
            targetLabel={`${project.title} / ${active.document.title}`}
            beforeImport={beforeLegacyImport}
            onImport={importLegacyDraft}
          />}
          <details className="pg-library-create-document">
            <summary>巻・章・シーンを追加</summary>
            <form onSubmit={(event) => void createDocument(event)}>
              <label htmlFor="pg-document-title">文書名</label>
              <input id="pg-document-title" value={documentTitle} onChange={(event) => setDocumentTitle(event.target.value)} maxLength={256} required placeholder="章・シーン名" />
              <label htmlFor="pg-document-kind">種類</label><select id="pg-document-kind" value={documentKind} onChange={(event) => setDocumentKind(event.target.value)}><option value="volume">巻</option><option value="chapter">章</option><option value="scene">シーン</option><option value="note">ノート</option></select>
              <label htmlFor="pg-document-parent">追加先</label>
              <select id="pg-document-parent" value={newDocumentParent} onChange={(event) => setNewDocumentParent(event.target.value)}>
                <option value="">作品の直下</option>
                {documents.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
              </select>
              <button type="submit" disabled={loading || !canCreateDocument || !documentTitle.trim()}>作成</button>
            </form>
          </details>
          {active && <details><summary>選択文書の構成を変更</summary>
            <form onSubmit={(event) => { event.preventDefault(); if (renameTitle.trim()) void editStructure({ title: renameTitle.trim() }); }}><label htmlFor="pg-rename">新しい文書名</label><input id="pg-rename" value={renameTitle} onChange={(event) => setRenameTitle(event.target.value)} required maxLength={256} /><button type="submit">文書名を変更</button></form>
            <form onSubmit={(event) => { event.preventDefault(); if (moveTargetAvailable) void editStructure({ parentId: moveParent || null }); }}>
              <label htmlFor="pg-move">移動先</label>
              <select id="pg-move" value={moveParent} onChange={(event) => setMoveParent(event.target.value)}>
                <option value="">作品の直下</option>
                {!moveTargetAvailable && <option value={moveParent} disabled>選んだ移動先は利用できません</option>}
                {moveTargets.map((target) => <option key={target.id} value={target.id}>{target.label}</option>)}
              </select>
              <button type="submit" disabled={!moveTargetAvailable}>文書を移動</button>
            </form>
            <form onSubmit={(event) => { event.preventDefault(); void editStructure({ orderKey: String(orderRank).padStart(8, "0") }); }}><label htmlFor="pg-order">並び順</label><input id="pg-order" type="number" min="0" max="99999999" value={orderRank} onChange={(event) => setOrderRank(Number(event.target.value))} /><button type="submit">並び順を変更</button></form>
            <button type="button" onClick={() => { if (window.confirm(`「${active.document.title}」を削除しますか？保存済みRevisionは保持されます。`)) void editStructure({}, true); }}>文書を削除</button>
          </details>}
        </section>}
      </aside>);
  const pendingSaveForDisplay = active
    ? pendingSaveRef.current.get(JSON.stringify([active.document.projectId, active.document.id]))
    : undefined;
  const evidencePendingForActive = Boolean(active && evidenceLoadPending &&
    evidenceLoadPending.projectId === active.document.projectId && evidenceLoadPending.documentId === active.document.id);
  const editor = (<main className="pg-editor-column" aria-label="PostgreSQL原稿編集">
        {mode === "desktop" && pageError && <p className="pg-alert" role="alert">{pageError}</p>}
        {notice && <p className="pg-notice" role="status">{notice}</p>}
        {journalError && <p className="pg-alert" role="alert">{journalError}</p>}
        {!project && <section className="pg-empty">
          {hosted ? <>
            <h2>{loading ? "割り当てられた作品を確認しています" : pageError ? "割当作品を確認できません" : "割り当てられた作品がありません"}</h2>
            <p>Hosted環境では割り当てられた作品だけを利用できます。</p>
          </> : <>
            <h2>最初の作品を作成してください</h2>
            <p>作品、原稿Revision、Knowledge、EvidenceはPostgreSQLへ保存されます。</p>
            <button type="button" onClick={() => openCreation("project")}>最初の作品を作成</button>
          </>}
        </section>}
        {missingExplicitRouteDocument && <section className="pg-empty" role="status"><h2>指定された文書が見つかりません</h2><p>この作品に指定された文書はありません。目次から開く文書を選択してください。</p></section>}
        {project && !missingExplicitRouteDocument && !selectedDocument && !active && !outlineError && <section className="pg-empty"><h2>{project.title}</h2><p>編集を始める文書を作成してください。</p><button type="button" onClick={() => openCreation("document")}>最初の文書を作成</button></section>}
        {active && <section className="pg-editor" data-reader={reading ? "true" : undefined} aria-label={active.document.title}>
          <div className="pg-editor-heading">
            <div><p className="eyebrow">{writingContext}</p><h2>{active.document.title}</h2></div>
            <details className="pg-save-state" data-state={desktopDurabilityFor(active)}>
              <summary aria-live={active.error || active.remoteConflict || active.recovery === "failed" || active.recovery === "other-tab"
                ? "off"
                : active.save === "saving" || (active.save === "saved" && !active.dirty && active.recovery === "stored") ? "polite" : "off"}>
                {active.remoteConflict || active.error || active.save === "failed" || active.recovery === "failed" || active.recovery === "other-tab"
                  ? "要確認"
                  : active.save === "saving" ? "サーバーへの保存を確認中"
                    : active.dirty ? active.recovery === "pending" ? "この端末へ記録中" : "この端末に下書きがあります"
                      : active.save === "saved" && active.recovery === "stored" ? "保存済み" : "保存状態を確認中"}
                {evidencePendingForActive && <span role="status" className="pg-evidence-pending"> · 根拠を確認中</span>}
              </summary>
              <div className="pg-save-state-detail">
                <p>この端末: {active.recovery === "stored"
                  ? (active.dirty ? "現在の編集をこのブラウザーに記録しました。" : "この原稿に未保存の変更はありません")
                  : active.recovery === "pending" ? "現在の編集をこのブラウザーに記録しています。"
                    : active.recovery === "other-tab" ? "別タブに下書きがあります"
                      : "現在の編集の回復記録を確認できません。画面を開いたままエラーを確認してください。"}</p>
                <p>サーバー: {active.remoteConflict ? "作品に別の版が保存されています。原稿の比較を確認してください。"
                  : active.dirty ? "直前に確認した版は作品に保存されています。"
                    : active.save === "saved" ? "PostgreSQLへの保存を確認しました" : "開いた版を表示しています。"}</p>
                <p>確認した版の保存日時 <time dateTime={active.revision.createdAt}>{new Date(active.revision.createdAt).toLocaleString()}</time></p>
                {pendingSaveForDisplay && <p>
                  {active.save === "failed" ? "今回の保存結果を確認できません。" : "今回の保存結果を確認しています。"}
                  送信後の入力は今回の保存に含まれません。
                  {active.save === "failed" && active.dirty && active.recovery === "stored" && !active.remoteConflict &&
                    "保存を再試行すると同じ操作の結果を確かめます。"}
                </p>}
                {active.save === "failed" && !pendingSaveForDisplay && !active.remoteConflict &&
                  active.recovery !== "failed" && active.recovery !== "other-tab" &&
                  <p>現在の編集の保存を確認できません。原稿のエラーを確認してください。</p>}
              </div>
            </details>
          </div>
          {active.error && <p className="pg-alert" role="alert">{active.error}</p>}
          {evidenceLoadIssue && evidenceLoadIssue.projectId === active.document.projectId && evidenceLoadIssue.documentId === active.document.id && <div className="pg-alert" role="alert">
            <p>このRevisionの根拠を取得できませんでした。登録状況は未確認です。{evidenceLoadIssue.message}</p>
            <button type="button" disabled={evidenceLoadIssue.retrying || sessionBlocked} onClick={() => void retryEvidence()}>{evidenceLoadIssue.retrying ? "根拠を再読み込みしています…" : "根拠を再試行"}</button>
          </div>}
          <div className="pg-editor-actions" role="group" aria-label="原稿の操作">
            <button type="button" onClick={() => void saveDocument()} disabled={!active.dirty || active.recovery !== "stored" || Boolean(active.remoteConflict) || active.save === "saving"}>
              {active.save === "failed" ? "PostgreSQLへ再試行" : "今すぐ保存"}
            </button>
            <button type="button" aria-pressed={reading} onClick={() => void protectTransition().then((allowed) => { if (!allowed) return; setReading(!reading); if (reading) requestAnimationFrame(() => editorRef.current?.restorePosition(editorPositionRef.current)); })}>{reading ? "編集へ戻る" : "読む"}</button>
            <details className="pg-editor-command-menu">
              <summary>その他</summary>
              <div>
                <button type="button" onClick={() => {
                  if (!editorRef.current) return;
                  try {
                    const markdown = editorRef.current.readForNavigation();
                    flushSync(() => setPrintSnapshot({ documentId: active.document.id, generation: active.generation, markdown }));
                    window.print();
                  } catch (error) {
                    setPageError(error instanceof Error ? error.message : "変換を確定してください。");
                  }
                }}>印刷</button>
                <button type="button" onClick={() => void loadRevisions()} disabled={active.dirty || Boolean(active.remoteConflict)}>Revision履歴</button>
                <button type="button" onClick={() => void createAnchor()} disabled={active.dirty || Boolean(active.remoteConflict) || active.save !== "saved" || evidencePendingForActive || Boolean(evidenceLoadIssue && evidenceLoadIssue.projectId === active.document.projectId && evidenceLoadIssue.documentId === active.document.id)}>選択範囲をText Anchorにする</button>
              </div>
            </details>
            <details className="pg-editor-display-menu">
              <summary>表示と書式</summary>
              <div>
                <label>組版<select aria-label="組版プリセット" defaultValue="" onChange={(event) => { const next = { ...typography, ...typographyPresetValues(event.target.value as TypographyPresetId) }; setTypography(next); storeTypographySettings(next); }}><option value="" disabled>表示設定</option>{Object.entries(TYPOGRAPHY_PRESETS).map(([id, preset]) => <option key={id} value={id}>{preset.label}</option>)}</select></label>
                <label>文字サイズ<input aria-label="原稿の文字サイズ" type="number" min="14" max="24" value={typography.fontSize} onChange={(event) => { const next = { ...typography, fontSize: Math.max(14, Math.min(24, Number(event.target.value))) }; setTypography(next); storeTypographySettings(next); }} /></label>
                {reading && <label>組方向<select aria-label="組方向" value={readingDirection} onChange={(event) => setReadingDirection(event.target.value as "horizontal" | "vertical")}><option value="horizontal">横書き</option><option value="vertical">縦書き</option></select></label>}
                {!reading && <div className="pg-editor-symbol-menu" aria-label="書式記号">{WRITING_SYMBOLS.map((symbol) => <button key={symbol.id} type="button" aria-label={symbol.ariaLabel} onClick={() => editorRef.current?.insert(symbol.id)}>{symbol.label}</button>)}</div>}
              </div>
            </details>
          </div>
          <div hidden={reading}>
          <label id="pg-manuscript-label" htmlFor="manuscript">本文</label>
          <ManuscriptInput
            key={active.document.id}
            ref={editorRef}
            style={typographyStyle}
            resolveTerms={resolveTerms}
            termResolutionKey={moduleSnapshot ? snapshotKey(moduleSnapshot) : ""}
            onTermNavigate={handleTermNavigate}
            onCursorPositionChange={(cursorSentenceIndex, scrollTop) => { editorPositionRef.current = { cursorSentenceIndex, scrollTop }; resume.onWritingPosition(active.document.id, cursorSentenceIndex, scrollTop); }}
            requestedPosition={!reading && activeContinue?.position.kind === "writing" ? activeContinue.position : undefined}
            consumeRequestedPosition={consumeWritingContinue}
            onSelectionChange={(selection) => { textSelectionRef.current = selection; }}
            value={active.markdown}
            externalTextRevision={active.generation}
            readOnly={Boolean(journalError) || legacyImportBusy || restoring || sessionBlocked || active.recovery === "other-tab"}
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

          {journal && <PersistenceScratch key={`${active.document.projectId}:${active.document.id}`} projectId={active.document.projectId} documentId={active.document.id} authorScope={authorScope} journal={journal} canCreateNote={canCreateDocument} registerGuard={registerScratchGuard} onSaved={async () => {
            if (projectIdRef.current !== projectId) return;
            setNotice("スクラッチを独立したノートとしてPostgreSQLへ保存しました。");
            try {
              const result = await api.persistenceDocuments(projectId);
              if (projectIdRef.current !== projectId) return;
              setDocuments(result.documents);
              setOutlineReadyProject(projectId);
              setOutlineError("");
            } catch (error) {
              if (projectIdRef.current !== projectId) return;
              setOutlineReadyProject("");
              setOutlineError("ノートは保存済みですが、目次を再取得できませんでした。" + (error instanceof Error ? error.message : ""));
            }
          }} />}
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
            {revisions.map((revision) => <article key={revision.id} data-revision-id={revision.id}>
              <p>{new Date(revision.createdAt).toLocaleString()} · {revision.id === active.revision.id ? "現在" : "保存済み"}</p>
              <pre>{revision.markdown.slice(0, 700) || "（空の原稿）"}</pre>
              {revision.id !== active.revision.id && <RevisionDifference previous={revision} current={active.revision} />}
              {revision.id !== active.revision.id && <button type="button" disabled={loading || restoring || active.dirty} onClick={() => void restoreRevision(revision)}>このRevisionを新しいRevisionとして復元</button>}
              </article>)}
            {revisionPageError && <p role="alert">{revisionPageError}</p>}
            {revisionPageLoading && <p role="status">古いRevision履歴を読み込んでいます。</p>}
            {revisionCursor && <button type="button" disabled={loading || restoring || revisionPageLoading || active.dirty || Boolean(active.remoteConflict)} onClick={loadMoreRevisions}>さらに古いRevisionを読む</button>}
            {revisionPageError && revisions.length === 0 && <button type="button" disabled={revisionPageLoading} onClick={() => void loadRevisionPage(undefined, true)}>Revision履歴を再試行</button>}
          </section>}
        </section>}
      </main>);
  const knowledge = (<aside className="pg-knowledge" aria-label="知識と根拠">
        <section>
          <h2>作品内の知識</h2>
        <details className="pg-knowledge-tools">
          <summary>知識候補を追加・根拠に指定</summary>
          <form onSubmit={(event) => void createKnowledge(event)}>
            <label htmlFor="pg-knowledge-name">Knowledge候補を追加</label>
            <input id="pg-knowledge-name" value={knowledgeName} onChange={(event) => setKnowledgeName(event.target.value)} maxLength={512} required disabled={knowledgeCreatePending || knowledgeCreateUncertain?.projectId === projectId} placeholder="人物・場所・用語" />
            <label htmlFor="pg-knowledge-type">種類</label>
            <select id="pg-knowledge-type" value={knowledgeType} onChange={(event) => setKnowledgeType(event.target.value)} disabled={knowledgeCreatePending || knowledgeCreateUncertain?.projectId === projectId}>
              <option value="person">人物</option><option value="place">場所</option><option value="event">出来事</option><option value="setting">設定</option><option value="term">用語</option>
            </select>
            <button type="submit" disabled={!project || !knowledgeName.trim() || knowledgeCreatePending}>{knowledgeCreatePending ? "保存中…" : knowledgeCreateUncertain?.projectId === projectId ? "保存結果を再確認" : "候補を保存"}</button>
          </form>
          <label htmlFor="pg-knowledge-target">Text AnchorのKnowledge先</label>
          <select id="pg-knowledge-target" value={nodeId} onChange={(event) => {
            const selectedId = event.target.value;
            setNodeId(selectedId);
            setSelectedKnowledgeNode(nodes.find(item => item.id === selectedId && item.projectId === projectId)
              ?? (selectedKnowledgeNode?.id === selectedId && selectedKnowledgeNode.projectId === projectId ? selectedKnowledgeNode : null));
          }} disabled={nodes.length === 0 && !selectedNode}>
            <option value="">Knowledgeを選択</option>
            {selectedNode && !nodes.some(item => item.id === selectedNode.id) && <option value={selectedNode.id}>{selectedNode.name} · 選択中</option>}
            {nodes.map((node) => <option key={node.id} value={node.id}>{node.name} · {node.status === "confirmed" ? "確定" : node.status === "proposed" ? "候補" : "退役"}</option>)}
          </select>
        </details>
          {knowledgeCreateError?.projectId === projectId && <p className="pg-alert" role="alert">{knowledgeCreateError.message}</p>}
          <search aria-label="Knowledgeを検索・絞り込み">
            <form onSubmit={(event) => event.preventDefault()}>
              <label htmlFor="pg-knowledge-search">名前または別名で検索</label>
              <input id="pg-knowledge-search" type="search" maxLength={128} value={knowledgeQuery} onChange={event => setKnowledgeQuery(event.target.value)} placeholder="名前・別名" />
              <label htmlFor="pg-knowledge-filter-type">種類で絞り込み</label>
              <select id="pg-knowledge-filter-type" value={knowledgeTypeFilter} onChange={event => setKnowledgeTypeFilter(event.target.value)}>
                <option value="">すべての種類</option><option value="person">人物</option><option value="place">場所</option><option value="event">出来事</option><option value="setting">設定</option><option value="term">用語</option>
                {[...new Set(nodes.map(node => node.type))].filter(type => !["person", "place", "event", "setting", "term"].includes(type)).sort().map(type => <option key={type} value={type}>{type}</option>)}
              </select>
              <label htmlFor="pg-knowledge-filter-status">状態で絞り込み</label>
              <select id="pg-knowledge-filter-status" value={knowledgeStatusFilter} onChange={event => setKnowledgeStatusFilter(event.target.value)}>
                <option value="">すべての状態</option><option value="confirmed">作者確定</option><option value="proposed">未確認候補</option><option value="retired">退役</option>
              </select>
            </form>
          </search>
          <p role="status" aria-live="polite">
            {knowledgeListLoading ? "Knowledgeを検索しています。" : knowledgeListError
              ? `${nodes.length}件取得済み。Knowledgeの取得に失敗しました。`
              : knowledgeLegacyMode
              ? `旧サーバーから取得した${nodes.length}件の名前・種類・状態だけを表示しています。別名検索と続きの取得は利用できず、全体の網羅状況は不明です。${visibleKnowledgeNodes.length}件が現在の条件に一致。`
              : nodes.length === 0 && knowledgeComplete
              ? "該当するKnowledgeはありません。"
              : knowledgeComplete ? `すべての絞り込み結果を取得済み（${nodes.length}件）。`
                : `${nodes.length}件取得済み。続きがあります。`}
          </p>
          <ul className="pg-knowledge-list">
            {knowledgeListLoading && nodes.length === 0 && <li role="status">Knowledge一覧を読み込んでいます。</li>}
            {visibleKnowledgeNodes.map((node) => <li key={node.id}>
              <button type="button" className={node.id === nodeId ? "is-selected" : ""} onClick={() => { setNodeId(node.id); setSelectedKnowledgeNode(node); }}>
                <span>{node.name}</span><small>{knowledgeTypeLabel(node.type)} · {node.status === "confirmed" ? "作者確定" : node.status === "proposed" ? "未確認候補" : "退役"}</small>
              </button>
              {node.status === "proposed" && <button type="button" onClick={() => void confirmKnowledge(node)}>内容を確認して確定</button>}
            </li>)}
          </ul>
          {knowledgeNextCursor && <button type="button" onClick={() => void loadMoreKnowledge()} disabled={knowledgePageLoading}>
            {knowledgePageLoading ? "読み込み中…" : "続きのKnowledgeを読み込む"}
          </button>}
          {knowledgeListError && <div className="pg-alert" role="alert">
            <p>Knowledge一覧を読み込めませんでした。{knowledgeListError}</p>
            <button type="button" onClick={() => setKnowledgeListRetryEpoch((value) => value + 1)} disabled={knowledgeListLoading}>再試行</button>
          </div>}
          {nodeId && !selectedNode && (selectedNodeError
            ? <p className="pg-alert" role="alert">{selectedNodeError}</p>
            : <p role="status">Knowledge詳細を読み込んでいます。</p>)}
          {selectedNode && <KnowledgeContextInspector key={selectedNode.id} node={selectedNode} nodes={nodes} documentId={active?.document.id} revisionId={active?.revision.id} clean={Boolean(active&&!active.dirty&&!active.remoteConflict&&active.save==="saved")} selectedEvidenceId={selectedEvidenceId??""} evidenceLoadKey={(active?.evidenceLoadKey??0)+nativeReviewEpoch} onOpenEvidence={(item)=>void openNodeEvidence(item)} onDataChanged={refreshKnowledgeBrowse} onNodeUpdate={(updated)=>{setSelectedKnowledgeNode(updated);refreshKnowledgeBrowse();}} onMerge={(target,source)=>{setSelectedKnowledgeNode(target);setNodeId(target.id);refreshKnowledgeBrowse();setNotice("Knowledgeを統合しました。")}} />}
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
          <h2>本文の根拠</h2>
          {!active && <p>文書を開くと、この作品の知識と根拠を利用できます。</p>}
          {active && active.evidence.anchors.length === 0 && <p>このRevisionにText Anchorはありません。本文で範囲を選び、作成してください。</p>}
          {active && <ul className="pg-evidence-list">
            {active.evidence.anchors.map((anchor) => <li key={anchor.id}>
              <button type="button" className={selectedEvidenceId === anchor.id ? "is-selected" : ""} onClick={() => setSelectedEvidenceId(anchor.id)}>
                <q>{anchor.quote || "引用位置を確認できません"}</q><small>{anchor.status === "current" ? "現在のRevision" : anchor.status === "proposed" ? "確認待ち" : anchor.status === "needs_review" ? "再確認が必要" : anchor.status === "orphaned" ? "本文から削除" : "Revision不一致"}</small>
              </button>
              {(anchor.targets ?? (anchor.target ? [anchor.target] : [])).map((target) => <p key={target.id}>確定先: {target.label} <button type="button" onClick={() => setNodeId(target.id)}>Knowledgeの根拠を表示</button></p>)}
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
    { id: "editor", title: "原稿", preserveContainer: editorPortalContainer ?? undefined, preserveParkingRef: editorPortalParkingRef, render: () => editor },
    { id: "inspector", title: "知識と根拠", render: () => knowledge },
  ];
  const readCurrentEditor = (): BrowserEditorDocument | null => {
    const current = activeRef.current;
    const read = moduleReadRef.current;
    if (!current || !read || !moduleSnapshot || snapshotKey(read.snapshot) !== snapshotKey(moduleSnapshot) || read.snapshot.projectId !== current.document.projectId || projectIdRef.current !== current.document.projectId || sessionBlockedRef.current) return null;
    const documentPath = `documents/${current.document.id}.md`;
    if (!read.files.some((file) => file.path === documentPath && file.revision === current.revision.sha256)) return null;
    return { sceneId: current.document.id, documentPath, documentRevision: current.revision.id,
      sceneRevision: current.revision.id, text: current.markdown, snapshot: read.snapshot, baseSnapshot: read.snapshot, baseSceneRevision: current.revision.id };
  };
  const modulePanels = availableModulePanels({ items: workspaceContributions(contributions, modules), contributions, modules, projectId, authorScope,
    snapshot: moduleSnapshot, journal, refresh: refreshModules, onProposalStored: () => { void refreshModules(); }, readCurrentEditor,
    navigateDocument: navigateReference,
  });
  panels.push({ id: "review", title: "提案レビュー", render: () => <>{moduleError && <p role="alert">{moduleError}</p>}<NativeChangeSetReview key={projectId} projectId={projectId} onApplied={refreshAfterNativeApply} onOpenSource={(anchor, quote) => openNodeEvidence({ anchor, quote })} />{journal && <ProposalReview projectId={projectId} authorScope={authorScope} journal={journal} proposals={proposals} onChange={() => { void refreshModules(); }} onStatus={(message) => setNotice(message)} />}</> }, ...modulePanels);
  const Shell = mode === "mobile" ? MobileShell : DesktopShell;
  return <div className={`pg-workspace pg-shell pg-${mode}`}>
    <div className="pg-preserved-editor-parking" hidden inert aria-hidden="true" ref={attachEditorPortalParking} />
    {editorPortalContainer ? createPortal(editor, editorPortalContainer) : null}
    {active && createPortal(
      <article className="print-view pg-print-document" style={typographyStyle}>
        <h1>{active.document.title}</h1>
        <div className="pg-print-manuscript">{printSnapshot?.documentId === active.document.id && printSnapshot.generation === active.generation
          ? printSnapshot.markdown : active.markdown}</div>
      </article>,
      document.body,
    )}
    <Shell mode={mode}
      header={<><h1>Database workspace</h1><JobInbox /><ThemeControl mode={theme} error={themeError} onChange={(next) => { setTheme(next); applyThemeMode(next); try { persistThemeMode(next); setThemeError(""); } catch { setThemeError("外観設定をこのブラウザーへ保存できませんでした。"); } }} /><button type="button" onClick={() => void protectTransition().then((allowed) => { if (allowed) onSignOut(); })}>ログアウト</button></>}
      documentTitle={active?.document.title}
      documentContext={writingContext}
      library={library} editor={editor} tools={knowledge}
      status={<>
        {loading && <p role="status">PostgreSQLの状態を読み込んでいます。</p>}
        {mode === "mobile" && pageError && <p className="pg-alert" role="alert">{pageError}</p>}
      </>}
      workspaceScope={`postgres:${authorScope}`}
      panels={panels}
      requestedPanel={requestedPanel}
      beforeLayoutChange={protectTransition}
      onSwitchMode={async () => {
        const nextMode = mode === "desktop" ? "mobile" : "desktop";
        if (!await protectTransition()) return false;
        rememberUiMode(nextMode);
        window.location.assign(switchApplicationPath(window.location.href, nextMode));
        return true;
      }}
    />
  </div>;
}

function composeDraftChanges(current: ActiveDocument, pending: PendingSave | undefined, markdown: string, changes: TextChange[]): PersistenceDraftTextChanges {
  const baseMarkdown = pending?.markdown ?? current.baseMarkdown;
  const afterSaveKey = pending?.idempotencyKey;
  if (markdown === baseMarkdown) return { changes: [], afterSaveKey };
  const previous = current.textChanges;
  const preceding = current.markdown === baseMarkdown ? [] : previous && previous.afterSaveKey === afterSaveKey
    ? previous.changes : minimalTextChanges(baseMarkdown, current.markdown);
  return {
    changes: composeTextChanges(baseMarkdown, preceding, changes)
      .filter((change) => baseMarkdown.slice(change.from, change.to) !== change.insert),
    afterSaveKey,
  };
}

function recoveredTextChanges(value: PersistenceDraftTextChanges | undefined, base: string, markdown: string, pending: PendingSave | undefined): PersistenceDraftTextChanges | undefined {
  if (!value || !Array.isArray(value.changes)) return undefined;
  if (value.afterSaveKey !== undefined) {
    if (!pending || value.afterSaveKey !== pending.idempotencyKey) return undefined;
    base = pending.markdown;
  }
  let previousEnd = 0;
  for (const change of value.changes) {
    if (!change || !Number.isSafeInteger(change.from) || !Number.isSafeInteger(change.to) ||
        change.from < previousEnd || change.to < change.from || change.to > base.length || typeof change.insert !== "string") return undefined;
    previousEnd = change.to;
  }
  return applyTextChanges(base, value.changes) === markdown ? value : undefined;
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
