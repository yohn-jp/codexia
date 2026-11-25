import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import type { McpActionClient } from '../api-client.js';
import { byteLength, errorResult, guarded, invoke, scopedClient, toolOutputSchema } from './shared.js';

const projectId = z.string().min(1).max(256).optional().describe('Registered project ID');
const uuid = z.string().uuid();
const limit = (max: number, fallback: number) =>
  z.number().int().min(1).max(max).optional().describe(`Maximum result count (default ${fallback})`);
const object = z
  .record(z.string(), z.unknown())
  .refine(value => Object.keys(value).length <= 128 && byteLength(value) <= 64_000, 'JSON object exceeds the native MCP input bound');
const nullableVersion = z.number().int().positive().safe().nullable();
const scope = { projectId: uuid };
const ordinaryOperations = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('knowledge.node.save'),
      command: z
        .object({
          ...scope,
          id: uuid,
          type: z.string().min(1).max(512),
          name: z.string().min(1).max(512),
          attributes: object,
          status: z.enum(['proposed', 'confirmed', 'retired']),
          expectedVersion: nullableVersion,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('knowledge.alias.save'),
      command: z
        .object({
          ...scope,
          id: uuid,
          nodeId: uuid,
          surface: z.string().min(1).max(512),
          normalized: z.string().min(1).max(512),
          scope: z.string().min(1).max(512).nullable(),
          status: z.enum(['proposed', 'confirmed', 'ambiguous', 'retired']),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('knowledge.relation.save'),
      command: z
        .object({
          ...scope,
          id: uuid,
          sourceId: uuid,
          targetId: uuid,
          type: z.string().min(1).max(512),
          attributes: object,
          validity: object,
          status: z.enum(['proposed', 'confirmed', 'rejected', 'retired']),
          expectedVersion: nullableVersion,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('evidence.anchor.save'),
      command: z
        .object({
          ...scope,
          id: uuid,
          documentId: uuid,
          revisionId: uuid,
          fromUtf16: z.number().int().min(0),
          toUtf16: z.number().int().positive(),
          quoteSha256: z.string().regex(/^[0-9a-f]{64}$/u),
          status: z.enum(['proposed', 'confirmed', 'needs_review', 'orphaned']),
          expectedVersion: nullableVersion,
        })
        .strict()
        .refine(command => command.toUtf16 > command.fromUtf16, 'Evidence range must be non-empty'),
    })
    .strict(),
  z
    .object({
      type: z.literal('evidence.mention.save'),
      command: z
        .object({
          ...scope,
          evidenceId: uuid,
          nodeId: uuid,
          status: z.enum(['proposed', 'confirmed', 'ambiguous', 'rejected']),
          source: z.string().min(1).max(512),
          confidence: z.number().min(0).max(1).nullable(),
          extractorVersion: z.string().max(512).nullable(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('evidence.assertion.save'),
      command: z
        .object({
          ...scope,
          id: uuid,
          proposition: object,
          modality: z.string().min(1).max(512),
          perspective: z.string().min(1).max(512),
          narrativeTime: object,
          confidence: z.number().min(0).max(1).nullable(),
          status: z.enum(['proposed', 'confirmed', 'rejected', 'retired']),
          expectedVersion: nullableVersion,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('evidence.assertion.link'),
      command: z
        .object({ ...scope, assertionId: uuid, evidenceId: uuid, role: z.enum(['supports', 'contradicts', 'quotes', 'context']) })
        .strict(),
    })
    .strict(),
]);

async function invokeNative(client: McpActionClient, project: string | undefined, actionId: string, input: Record<string, unknown>) {
  const scoped = scopedClient(client, project);
  if (!(await scoped.listActions()).some(action => action.id === actionId))
    return errorResult('ACTION_UNAVAILABLE', `Native Knowledge Action is unavailable: ${actionId}`);
  return invoke(scoped, actionId, input);
}

/** Register the bounded Knowledge, Evidence, ChangeSet and merge Action adapters. */
export function registerKnowledgeTools(server: McpServer, baseClient: McpActionClient): void {
  server.registerTool(
    'knowledge.nodes.list',
    {
      description: 'List native Knowledge nodes in the selected project snapshot',
      inputSchema: z.object({
        project_id: projectId,
        project_version: z.number().int().positive().safe().optional(),
        limit: limit(500, 100),
      }),
      outputSchema: toolOutputSchema,
    },
    guarded(async ({ project_id, project_version, limit: count }) =>
      invokeNative(baseClient, project_id, 'core.knowledge.nodes.list', {
        ...(project_version === undefined ? {} : { projectVersion: project_version }),
        ...(count === undefined ? {} : { limit: count }),
      }),
    ),
  );
  server.registerTool(
    'knowledge.node.get',
    {
      description: 'Get a Knowledge node with bounded aliases and relationships',
      inputSchema: z.object({
        project_id: projectId,
        node_id: uuid,
        project_version: z.number().int().positive().safe().optional(),
        related_limit: limit(1000, 500),
      }),
      outputSchema: toolOutputSchema,
    },
    guarded(async ({ project_id, node_id, project_version, related_limit }) =>
      invokeNative(baseClient, project_id, 'core.knowledge.node.get', {
        nodeId: node_id,
        ...(project_version === undefined ? {} : { projectVersion: project_version }),
        ...(related_limit === undefined ? {} : { relatedLimit: related_limit }),
      }),
    ),
  );
  server.registerTool(
    'knowledge.aliases.list',
    {
      description: 'List aliases attached to a native Knowledge node',
      inputSchema: z.object({
        project_id: projectId,
        node_id: uuid,
        project_version: z.number().int().positive().safe().optional(),
        limit: limit(1000, 500),
      }),
      outputSchema: toolOutputSchema,
    },
    guarded(async ({ project_id, node_id, project_version, limit: count }) =>
      invokeNative(baseClient, project_id, 'core.knowledge.aliases.list', {
        nodeId: node_id,
        ...(project_version === undefined ? {} : { projectVersion: project_version }),
        ...(count === undefined ? {} : { limit: count }),
      }),
    ),
  );
  server.registerTool(
    'knowledge.relations.list',
    {
      description: 'List relationships attached to a native Knowledge node',
      inputSchema: z.object({
        project_id: projectId,
        node_id: uuid,
        project_version: z.number().int().positive().safe().optional(),
        limit: limit(1000, 500),
      }),
      outputSchema: toolOutputSchema,
    },
    guarded(async ({ project_id, node_id, project_version, limit: count }) =>
      invokeNative(baseClient, project_id, 'core.knowledge.relations.list', {
        nodeId: node_id,
        ...(project_version === undefined ? {} : { projectVersion: project_version }),
        ...(count === undefined ? {} : { limit: count }),
      }),
    ),
  );

  server.registerTool(
    'evidence.anchor.get',
    {
      description: 'Get a revision-bound evidence anchor, quote, links and bounded history',
      inputSchema: z.object({
        project_id: projectId,
        evidence_id: uuid,
        project_version: z.number().int().positive().safe().optional(),
        history_limit: limit(1000, 500),
      }),
      outputSchema: toolOutputSchema,
    },
    guarded(async ({ project_id, evidence_id, project_version, history_limit }) =>
      invokeNative(baseClient, project_id, 'core.evidence.anchor.get', {
        evidenceId: evidence_id,
        ...(project_version === undefined ? {} : { projectVersion: project_version }),
        ...(history_limit === undefined ? {} : { historyLimit: history_limit }),
      }),
    ),
  );
  server.registerTool(
    'evidence.document.list',
    {
      description: 'List revision-bound evidence for a document',
      inputSchema: z.object({
        project_id: projectId,
        document_id: uuid,
        revision_id: uuid.optional(),
        project_version: z.number().int().positive().safe().optional(),
        limit: limit(500, 200),
      }),
      outputSchema: toolOutputSchema,
    },
    guarded(async ({ project_id, document_id, revision_id, project_version, limit: count }) =>
      invokeNative(baseClient, project_id, 'core.evidence.document.list', {
        documentId: document_id,
        ...(revision_id === undefined ? {} : { revisionId: revision_id }),
        ...(project_version === undefined ? {} : { projectVersion: project_version }),
        ...(count === undefined ? {} : { limit: count }),
      }),
    ),
  );
  server.registerTool(
    'evidence.node.list',
    {
      description: 'List evidence linked to a native Knowledge node',
      inputSchema: z.object({
        project_id: projectId,
        node_id: uuid,
        project_version: z.number().int().positive().safe().optional(),
        limit: limit(500, 200),
      }),
      outputSchema: toolOutputSchema,
    },
    guarded(async ({ project_id, node_id, project_version, limit: count }) =>
      invokeNative(baseClient, project_id, 'core.evidence.node.list', {
        nodeId: node_id,
        ...(project_version === undefined ? {} : { projectVersion: project_version }),
        ...(count === undefined ? {} : { limit: count }),
      }),
    ),
  );
  server.registerTool(
    'evidence.assertion.get',
    {
      description: 'Get a native assertion and its evidence links',
      inputSchema: z.object({
        project_id: projectId,
        assertion_id: uuid,
        project_version: z.number().int().positive().safe().optional(),
        evidence_limit: limit(1000, 500),
      }),
      outputSchema: toolOutputSchema,
    },
    guarded(async ({ project_id, assertion_id, project_version, evidence_limit }) =>
      invokeNative(baseClient, project_id, 'core.evidence.assertion.get', {
        assertionId: assertion_id,
        ...(project_version === undefined ? {} : { projectVersion: project_version }),
        ...(evidence_limit === undefined ? {} : { evidenceLimit: evidence_limit }),
      }),
    ),
  );
  server.registerTool(
    'evidence.assertion.list',
    {
      description: 'List evidence linked to a native assertion',
      inputSchema: z.object({
        project_id: projectId,
        assertion_id: uuid,
        project_version: z.number().int().positive().safe().optional(),
        limit: limit(1000, 500),
      }),
      outputSchema: toolOutputSchema,
    },
    guarded(async ({ project_id, assertion_id, project_version, limit: count }) =>
      invokeNative(baseClient, project_id, 'core.evidence.assertion.list', {
        assertionId: assertion_id,
        ...(project_version === undefined ? {} : { projectVersion: project_version }),
        ...(count === undefined ? {} : { limit: count }),
      }),
    ),
  );

  server.registerTool(
    'knowledge.propose',
    {
      description: 'Submit bounded typed native Knowledge and Evidence operations for author review',
      inputSchema: z.object({
        project_id: projectId,
        project_version: z.number().int().positive().safe(),
        idempotency_key: z.string().min(1).max(200),
        operations: z
          .array(ordinaryOperations)
          .min(1)
          .max(50)
          .refine(value => byteLength(value) <= 256_000, 'Native ChangeSet exceeds the 256 KiB MCP input bound'),
      }),
      outputSchema: toolOutputSchema,
    },
    guarded(async ({ project_id, project_version, idempotency_key, operations }) =>
      invokeNative(baseClient, project_id, 'core.knowledge.propose', {
        projectVersion: project_version,
        idempotencyKey: idempotency_key,
        operations,
      }),
    ),
  );
  server.registerTool(
    'changesets.list',
    {
      description: 'List native ChangeSets pending or completed author review',
      inputSchema: z.object({ project_id: projectId, limit: limit(100, 50) }),
      outputSchema: toolOutputSchema,
    },
    guarded(async ({ project_id, limit: count }) =>
      invokeNative(baseClient, project_id, 'core.changesets.list', { ...(count === undefined ? {} : { limit: count }) }),
    ),
  );
  server.registerTool(
    'changeset.get',
    {
      description: 'Get one native ChangeSet and its application receipt',
      inputSchema: z.object({ project_id: projectId, change_set_id: uuid }),
      outputSchema: toolOutputSchema,
    },
    guarded(async ({ project_id, change_set_id }) =>
      invokeNative(baseClient, project_id, 'core.changeset.get', { changeSetId: change_set_id }),
    ),
  );
  server.registerTool(
    'knowledge.merge.preview',
    {
      description: 'Preview a native Knowledge merge against one selected project snapshot',
      inputSchema: z.object({
        project_id: projectId,
        source_id: uuid,
        target_id: uuid,
        project_version: z.number().int().positive().safe().optional(),
      }),
      outputSchema: toolOutputSchema,
    },
    guarded(async ({ project_id, source_id, target_id, project_version }) =>
      invokeNative(baseClient, project_id, 'core.knowledge.merge.preview', {
        sourceId: source_id,
        targetId: target_id,
        ...(project_version === undefined ? {} : { projectVersion: project_version }),
      }),
    ),
  );
  server.registerTool(
    'knowledge.merge.propose',
    {
      description: 'Submit the exact merge preview for native author review; approval and application remain author-only',
      inputSchema: z.object({
        project_id: projectId,
        source_id: uuid,
        target_id: uuid,
        project_version: z.number().int().positive().safe(),
        preview_digest: z.string().regex(/^[0-9a-f]{64}$/u),
        idempotency_key: z.string().min(1).max(200),
      }),
      outputSchema: toolOutputSchema,
    },
    guarded(async ({ project_id, source_id, target_id, project_version, preview_digest, idempotency_key }) =>
      invokeNative(baseClient, project_id, 'core.knowledge.merge.propose', {
        sourceId: source_id,
        targetId: target_id,
        projectVersion: project_version,
        previewDigest: preview_digest,
        idempotencyKey: idempotency_key,
      }),
    ),
  );
}
