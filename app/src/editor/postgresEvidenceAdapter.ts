import type { RevisionId } from '@codexia/persistence-contracts';
import { api } from '../api';
import {
  applyTextChanges,
  composeTextChanges,
  type EditorEvidenceIdentity,
  type EditorEvidenceSnapshot,
  type EditorPersistenceSave,
  type EditorPersistenceSaveResult,
  parseMarkdownBlocks,
  type TextAnchor,
} from './evidence';

/** Connects CodeMirror evidence and saves to the authenticated PostgreSQL API. */
export function createPostgresEditorEvidenceAdapter() {
  const clientId = crypto.randomUUID();
  return {
    async read(
      { projectId, documentId, revisionId, markdown }: EditorEvidenceIdentity,
      signal: AbortSignal,
    ): Promise<EditorEvidenceSnapshot> {
      const read = await api.persistenceDocument(projectId, documentId, signal, revisionId);
      if (!read.revision) throw new Error('PostgreSQL にこの原稿Revisionがありません。');
      if (markdown !== undefined && read.revision.markdown !== markdown) {
        return { revisionId: read.revision.id, markdown: read.revision.markdown, blocks: [], anchors: [] };
      }
      const evidence = await api.persistenceDocumentAnchors(projectId, documentId, read.revision.id, signal);
      const blocks = parseMarkdownBlocks(
        read.revision.markdown,
        (() => {
          let index = 0;
          return () => `pg-block-${documentId}-${++index}`;
        })(),
      );
      const anchors = evidence.anchors.flatMap(({ anchor, quote, mentions, assertions }) => {
        const block =
          anchor.status === 'orphaned' || !quote
            ? undefined
            : blocks.find(item => anchor.fromUtf16 >= item.from && anchor.fromUtf16 < item.to && anchor.toUtf16 <= item.to);
        const targets = mentions.flatMap(({ link, node }) =>
          link.status === 'confirmed' && node?.status === 'confirmed' ? [{ id: node.id, label: node.name }] : [],
        );
        const target = targets.length === 1 ? targets[0] : undefined;
        const candidates = mentions.flatMap(({ link, node }) =>
          link.status === 'rejected' || !node || (link.status === 'confirmed' && node.status === 'confirmed')
            ? []
            : [{ id: node.id, label: node.name }],
        );
        const assertionReferences = assertions.flatMap(({ link, assertion }) =>
          assertion
            ? [
                {
                  id: assertion.id,
                  label: assertionLabel(assertion),
                  role: link.role,
                  status: assertion.status,
                },
              ]
            : [],
        );
        return [
          {
            id: anchor.id,
            blockId: block?.id ?? null,
            from: anchor.fromUtf16,
            to: anchor.toUtf16,
            quote,
            ...(target ? { target } : {}),
            ...(targets.length ? { targets } : {}),
            ...(candidates.length ? { candidates } : {}),
            ...(assertionReferences.length ? { assertions: assertionReferences } : {}),
            revisionId: anchor.revisionId,
            status:
              anchor.status === 'orphaned'
                ? ('orphaned' as const)
                : !quote
                  ? ('revision_conflict' as const)
                  : anchor.status === 'confirmed'
                    ? ('current' as const)
                    : anchor.status,
          } satisfies TextAnchor,
        ];
      });
      return { revisionId: read.revision.id, markdown: read.revision.markdown, blocks, anchors };
    },

    async save(
      { projectId, documentId, revisionId }: EditorEvidenceIdentity,
      request: EditorPersistenceSave,
      signal: AbortSignal,
    ): Promise<EditorPersistenceSaveResult> {
      const changes = composeTextChanges(request.baseMarkdown, [], request.changes);
      if (applyTextChanges(request.baseMarkdown, changes) !== request.markdown) {
        throw new Error('CodeMirror ChangeSetと保存する原稿が一致しません。');
      }
      const saved = await api.savePersistenceDocument(
        projectId,
        documentId,
        {
          baseRevisionId: revisionId as RevisionId,
          changes: changes.map(change => ({ fromUtf16: change.from, toUtf16: change.to, insert: change.insert })),
          resultingSha256: await sha256(request.markdown),
          idempotencyKey: request.idempotencyKey,
          clientId: request.clientId || clientId,
        },
        signal,
      );
      return { revisionId: saved.revision.id, markdown: saved.revision.markdown, document: saved.document, revision: saved.revision };
    },
  };
}

function assertionLabel(assertion: { modality: string; proposition: Record<string, unknown> }): string {
  const proposition = JSON.stringify(assertion.proposition);
  const summary = proposition.length > 140 ? `${proposition.slice(0, 137)}…` : proposition;
  return `${assertion.modality}: ${summary}`;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
