import { AsyncLocalStorage } from "node:async_hooks";
import type { ActionResult } from "@codexia/contracts";
import { McpApiError, type McpActionClient } from "../api-client.js";
import { McpWritingContextInputError } from "../context-manifest.js";

export type JsonRecord = Record<string, unknown>;
type ToolResponse = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content: Array<{ type: "text"; text: string }>;
};
export const toolCancellation = new AsyncLocalStorage<AbortSignal>();

export class ToolFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ToolFailure";
  }
}

export function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function errorResult(code: string, message: string, details?: unknown) {
  const error = { code, message: message.slice(0, 512), ...(details === undefined ? {} : { details }) };
  return { isError: true, structuredContent: { error }, content: [{ type: "text" as const, text: JSON.stringify(error) }] };
}

export async function unavailableModuleAction(client: McpActionClient, moduleId: string, toolName: string) {
  const actions = await client.listActions();
  const installed = actions.some((action) => action.module === moduleId);
  return errorResult(installed ? "ACTION_UNAVAILABLE" : "MODULE_UNAVAILABLE", installed
    ? `The ${moduleId} module does not currently expose the source capability for ${toolName}`
    : `Enable the ${moduleId} module to use ${toolName}`);
}

export function outputResult(data: unknown, snapshot?: unknown, proposals?: unknown[]) {
  const output = { ...(snapshot === undefined ? {} : { snapshot }), data, ...(proposals?.length ? { proposals } : {}) };
  return { structuredContent: output, content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }] };
}

export function actionResult(result: ActionResult) {
  if (!result.ok) return errorResult(result.error.code, result.error.message);
  return outputResult(result.data, result.snapshot, result.proposals);
}

export function requireSameSnapshot(left: unknown, right: unknown): void {
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new ToolFailure("STALE_PRECONDITION", "Project snapshot changed while the MCP tool was running");
  }
}

function apiError(error: unknown) {
  if (error instanceof McpApiError) return errorResult(error.code, error.message);
  if (error instanceof ToolFailure) return errorResult(error.code, error.message);
  if (error instanceof McpWritingContextInputError) return errorResult("INVALID_INPUT", error.message);
  return errorResult("INTERNAL_ERROR", "MCP tool failed");
}

export function guarded<TArgs>(handler: (args: TArgs) => Promise<ToolResponse>) {
  return async (args: TArgs, extra: { signal: AbortSignal }) => toolCancellation.run(extra.signal, async () => {
    try { return await handler(args); }
    catch (error) {
      if (extra.signal.aborted) throw error;
      return apiError(error);
    }
  });
}

export function signalAwareClient(client: McpActionClient): McpActionClient {
  const signal = () => toolCancellation.getStore();
  const wrapped: McpActionClient = {
    get projectId() { return client.projectId; },
    listActions: () => client.listActions(signal()),
    invoke: (actionId, input) => client.invoke(actionId, input, signal()),
    propose: (operations, evidence, proposalId) => client.propose(operations, evidence, proposalId, signal()),
    forProject(projectId) {
      if (!client.forProject) {
        if (client.projectId && client.projectId !== projectId) throw new ToolFailure("PROJECT_SCOPE_MISMATCH", "The requested project does not match this MCP session");
        return wrapped;
      }
      return signalAwareClient(client.forProject(projectId));
    },
  };
  if (client.listProjects) wrapped.listProjects = () => client.listProjects!(signal());
  return wrapped;
}

export function scopedClient(client: McpActionClient, requestedProjectId?: string): McpActionClient {
  const projectId = requestedProjectId || client.projectId;
  if (!projectId) throw new ToolFailure("INVALID_PROJECT", "Pass project_id or set CODEXIA_PROJECT_ID");
  if (client.forProject) return client.forProject(projectId);
  if (client.projectId && client.projectId !== projectId) throw new ToolFailure("PROJECT_SCOPE_MISMATCH", "The requested project does not match this MCP session");
  return client;
}

export function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

export async function invoke(client: McpActionClient, actionId: string, input: unknown) {
  return actionResult(await client.invoke(actionId, input));
}

export function structuredRecord(record: Record<string, unknown>) {
  return { structuredContent: record, content: [{ type: "text" as const, text: JSON.stringify(record, null, 2) }] };
}
