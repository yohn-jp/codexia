import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import type { McpActionClient } from '../api-client.js';
import {
  actionResult,
  byteLength,
  errorResult,
  guarded,
  invoke,
  outputResult,
  scopedClient,
  toolOutputSchema,
  unavailableModuleAction,
} from './shared.js';

const projectIdSchema = z.string().min(1).max(256).optional().describe('Registered project ID');
const sceneIdSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(value => value.trim().length > 0);
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/u, 'sourceFingerprint must be a SHA-256 hex digest');
const eventSchema = z
  .object({
    kind: z.enum(['location', 'acquaintance', 'ownership', 'knowledge', 'attribute']),
    subject: z.string().min(1).max(256),
    object: z.string().min(1).max(256).nullable(),
    payload: z.record(z.string(), z.unknown()).optional(),
    eventId: sceneIdSchema.optional(),
    propositionId: sceneIdSchema.optional(),
    replacesEventId: sceneIdSchema.optional(),
    evidence: z.array(z.record(z.string(), z.unknown())).max(100).optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();
const alternativeSchema = z.object({
  label: z.string().min(1).max(256),
  events: z.array(eventSchema).max(50),
});
const alternativesSchema = z
  .array(alternativeSchema)
  .length(2)
  .refine(value => byteLength(value) <= 1_048_576, 'Scenario input exceeds the 1 MiB MCP limit');

/** Register bounded named adapters for the existing Story action catalog. */
export function registerStoryTools(server: McpServer, baseClient: McpActionClient): void {
  const project = (project_id?: string) => scopedClient(baseClient, project_id);
  const available = async (client: McpActionClient, actionId: string, toolName: string) => {
    const actions = await client.listActions();
    if (actions.some(action => action.id === actionId)) return undefined;
    return unavailableModuleAction(client, 'story', toolName);
  };

  server.registerTool(
    'story.world-state.temporal',
    {
      description: 'Get deterministic world state at a scene from the selected project snapshot',
      inputSchema: z.object({
        project_id: projectIdSchema,
        scene_id: sceneIdSchema.describe('Saved scene ID'),
      }),
      outputSchema: toolOutputSchema,
    },
    guarded(async ({ project_id, scene_id }) => {
      const client = project(project_id);
      const unavailable = await available(client, 'story.world-state.temporal', 'story.world-state.temporal');
      if (unavailable) return unavailable;
      return invoke(client, 'story.world-state.temporal', { sceneId: scene_id });
    }),
  );

  server.registerTool(
    'story.context.package',
    {
      description: 'Get the snapshot-bound Story context package for an explicit perspective',
      inputSchema: z.object({
        project_id: projectIdSchema,
        scene_id: sceneIdSchema.describe('Saved scene ID'),
        scope: z.enum(['author', 'character', 'reader']),
        character_id: z.string().min(1).max(256).optional(),
        budget: z.number().int().min(128).max(200_000).optional().describe('Context budget in UTF-8 bytes (default 12000)'),
      }),
      outputSchema: toolOutputSchema,
    },
    guarded(async ({ project_id, scene_id, scope, character_id, budget }) => {
      if (scope === 'character' && !character_id) return errorResult('INVALID_INPUT', 'character_id is required for character scope');
      if (scope !== 'character' && character_id !== undefined)
        return errorResult('INVALID_INPUT', 'character_id is only valid for character scope');
      const client = project(project_id);
      const unavailable = await available(client, 'story.context.package', 'story.context.package');
      if (unavailable) return unavailable;
      const result = await client.invoke('story.context.package', {
        sceneId: scene_id,
        scope,
        ...(character_id ? { characterId: character_id } : {}),
        ...(budget === undefined ? {} : { budget }),
      });
      if (!result.ok) return actionResult(result);
      // Keep producer fields intact so this adapter remains forward-compatible.
      return outputResult(result.data, result.snapshot);
    }),
  );

  server.registerTool(
    'story.narrative.review',
    {
      description: 'Review narrative findings for the selected scene or project snapshot',
      inputSchema: z.object({
        project_id: projectIdSchema,
        scene_id: sceneIdSchema.optional(),
      }),
      outputSchema: toolOutputSchema,
    },
    guarded(async ({ project_id, scene_id }) => {
      const client = project(project_id);
      const unavailable = await available(client, 'story.narrative.review', 'story.narrative.review');
      if (unavailable) return unavailable;
      return invoke(client, 'story.narrative.review', scene_id ? { sceneId: scene_id } : {});
    }),
  );

  server.registerTool(
    'story.scenario.compare',
    {
      description: 'Compare exactly two hypothetical alternatives against the selected snapshot',
      inputSchema: z.object({
        project_id: projectIdSchema,
        scene_id: sceneIdSchema,
        alternatives: alternativesSchema,
      }),
      outputSchema: toolOutputSchema,
    },
    guarded(async ({ project_id, scene_id, alternatives }) => {
      const client = project(project_id);
      const unavailable = await available(client, 'story.scenario.compare', 'story.scenario.compare');
      if (unavailable) return unavailable;
      return invoke(client, 'story.scenario.compare', { sceneId: scene_id, alternatives });
    }),
  );

  server.registerTool(
    'story.scenario.list',
    {
      description: 'List saved hypothetical scenarios and their snapshot staleness',
      inputSchema: z.object({
        project_id: projectIdSchema,
      }),
      outputSchema: toolOutputSchema,
    },
    guarded(async ({ project_id }) => {
      const client = project(project_id);
      const unavailable = await available(client, 'story.scenario.list', 'story.scenario.list');
      if (unavailable) return unavailable;
      return invoke(client, 'story.scenario.list', {});
    }),
  );

  server.registerTool(
    'story.scenario.save',
    {
      description: 'Submit a hypothetical scenario for author review; this does not apply canon changes',
      inputSchema: z.object({
        project_id: projectIdSchema,
        scene_id: sceneIdSchema,
        label: z.string().min(1).max(256),
        source_fingerprint: fingerprintSchema,
        alternatives: alternativesSchema,
        id: z
          .string()
          .regex(/^[A-Za-z0-9_-]{1,128}$/u)
          .optional(),
        operation_id: z
          .string()
          .regex(/^[A-Za-z0-9._:-]{1,128}$/u)
          .optional(),
      }),
      outputSchema: toolOutputSchema,
    },
    guarded(async ({ project_id, scene_id, label, source_fingerprint, alternatives, id, operation_id }) => {
      const client = project(project_id);
      const unavailable = await available(client, 'story.scenario.save', 'story.scenario.save');
      if (unavailable) return unavailable;
      return invoke(client, 'story.scenario.save', {
        sceneId: scene_id,
        label,
        sourceFingerprint: source_fingerprint,
        alternatives,
        ...(id ? { id } : {}),
        ...(operation_id ? { operation_id } : {}),
      });
    }),
  );

  server.registerTool(
    'story.scenario.adopt',
    {
      description: 'Propose adoption of one saved hypothetical alternative for author review',
      inputSchema: z.object({
        project_id: projectIdSchema,
        id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
        alternative_index: z.number().int().min(0).max(1),
        source_fingerprint: fingerprintSchema,
        operation_id: z
          .string()
          .regex(/^[A-Za-z0-9._:-]{1,128}$/u)
          .optional(),
      }),
      outputSchema: toolOutputSchema,
    },
    guarded(async ({ project_id, id, alternative_index, source_fingerprint, operation_id }) => {
      const client = project(project_id);
      const unavailable = await available(client, 'story.scenario.adopt', 'story.scenario.adopt');
      if (unavailable) return unavailable;
      return invoke(client, 'story.scenario.adopt', {
        id,
        alternativeIndex: alternative_index,
        sourceFingerprint: source_fingerprint,
        ...(operation_id ? { operation_id } : {}),
      });
    }),
  );
}
