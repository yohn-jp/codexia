import { api } from "../api";
import type { RevisionId } from "@codexia/persistence-contracts";
import { composeTextChanges, parseMarkdownBlocks, type EditorEvidenceAdapter, type EditorEvidenceIdentity, type EditorEvidenceSnapshot, type EditorPersistenceSaveResult, type TextAnchor, type TextChange } from "./evidence";

export interface PersistenceEditorBinding {
  projectId: string;
  documentId: string;
  /** Revision mapping for imported Git-backed editors; omitted when identities already use PostgreSQL IDs. */
  revisionId?: string;
}

/**
 * Connects the existing CodeMirror evidence contract to the authenticated PostgreSQL API.
 * Hosts may map legacy UI identities to imported PostgreSQL identities after migration.
 */
export function createPostgresEditorEvidenceAdapter(
  resolveBinding: (identity: EditorEvidenceIdentity) => PersistenceEditorBinding | null = (identity) => identity,
): EditorEvidenceAdapter {
  const clientId = crypto.randomUUID();
  return {
    async read(identity, signal): Promise<EditorEvidenceSnapshot> {
      const binding = resolveBinding(identity);
      if (!binding) throw new Error("このEditor原稿にはPostgreSQLの保存先が割り当てられていません。");
      const requestedRevisionId = binding.revisionId ?? identity.revisionId;
      const read = await api.persistenceDocument(binding.projectId, binding.documentId, signal, requestedRevisionId);
      if (!read.revision) throw new Error("PostgreSQL にこの原稿Revisionがありません。");
      if (identity.markdown !== undefined && read.revision.markdown !== identity.markdown) {
        return { revisionId: read.revision.id, markdown: read.revision.markdown, blocks: [], anchors: [] };
      }
      const evidence = await api.persistenceDocumentAnchors(binding.projectId, binding.documentId, read.revision.id, signal);
      const blocks = parseMarkdownBlocks(read.revision.markdown, (() => {
        let index = 0;
        return () => `pg-block-${binding.documentId}-${++index}`;
      })());
      const anchors = evidence.anchors.flatMap(({ anchor, quote, mentions, assertions }) => {
        if (!quote) return [];
        const block = blocks.find((item) => anchor.fromUtf16 >= item.from && anchor.fromUtf16 <= item.to)
          ?? blocks[0];
        if (!block) return [];
        const confirmed = mentions.find((item) => item.link.status === "confirmed" && item.node?.status === "confirmed");
        const target = confirmed?.node ? { id: confirmed.node.id, label: confirmed.node.name } : undefined;
        const candidates = mentions.flatMap(({ link, node }) =>
          link.status === "rejected" || !node || (link.status === "confirmed" && node.status === "confirmed")
            ? [] : [{ id: node.id, label: node.name }]);
        const assertionReferences = assertions.flatMap(({ link, assertion }) => assertion ? [{
          id: assertion.id,
          label: assertionLabel(assertion),
          role: link.role,
          status: assertion.status,
        }] : []);
        return [{
          id: anchor.id,
          blockId: block.id,
          from: anchor.fromUtf16,
          to: anchor.toUtf16,
          quote,
          ...(target ? { target } : {}),
          ...(candidates.length ? { candidates } : {}),
          ...(assertionReferences.length ? { assertions: assertionReferences } : {}),
          revisionId: anchor.revisionId,
          status: anchor.status === "confirmed" ? "current" as const : anchor.status,
        } satisfies TextAnchor];
      });
      return { revisionId: read.revision.id, markdown: read.revision.markdown, blocks, anchors };
    },

    async save(identity, request, signal): Promise<EditorPersistenceSaveResult> {
      const binding = resolveBinding(identity);
      if (!binding) throw new Error("このEditor原稿にはPostgreSQLの保存先が割り当てられていません。");
      const changes = composeTextChanges(request.baseMarkdown, [], request.changes);
      if (applyTextChanges(request.baseMarkdown, changes) !== request.markdown) {
        throw new Error("CodeMirror ChangeSetと保存する原稿が一致しません。");
      }
      const saved = await api.savePersistenceDocument(binding.projectId, binding.documentId, {
        baseRevisionId: identity.revisionId as RevisionId,
        changes: changes.map((change) => ({ fromUtf16: change.from, toUtf16: change.to, insert: change.insert })),
        resultingSha256: await sha256(request.markdown),
        idempotencyKey: request.idempotencyKey,
        clientId: request.clientId || clientId,
      }, signal);
      return { revisionId: saved.revision.id, markdown: saved.revision.markdown };
    },
  };
}

function assertionLabel(assertion: { modality: string; proposition: Record<string, unknown> }): string {
  const proposition = JSON.stringify(assertion.proposition);
  const summary = proposition.length > 140 ? `${proposition.slice(0, 137)}…` : proposition;
  return `${assertion.modality}: ${summary}`;
}

function applyTextChanges(source: string, changes: readonly TextChange[]): string {
  let result = source;
  for (const change of [...changes].reverse()) result = `${result.slice(0, change.from)}${change.insert}${result.slice(change.to)}`;
  return result;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
