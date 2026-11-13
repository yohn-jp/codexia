import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { McpActionClient } from "../api-client.js";
import { byteLength, errorResult, guarded, invoke, outputResult, scopedClient } from "./shared.js";

const projectIdSchema = z.string().min(1).max(256).optional().describe("Registered project ID");
const AUTHOR_OPERATION_ACTIONS = new Set(["core.approve", "core.checkpoint", "core.reconcile", "core.publish", "core.apply", "core.sync"]);

/** Register project discovery and the bounded generic Action adapter. */
export function registerProjectTools(server: McpServer, baseClient: McpActionClient): void {
  server.tool("list_projects", "List projects registered to the authenticated owner; select a returned project_id for project tools", {}, guarded(async () => {
    if (!baseClient.listProjects) return errorResult("PROJECT_SCOPE_BOUND", "Project discovery is available through the standalone owner API client");
    return outputResult({ projects: await baseClient.listProjects() });
  }));

  server.tool("discover_actions", "List enabled project actions available through this authenticated MCP session", {
    project_id: projectIdSchema,
  }, guarded(async ({ project_id }) => outputResult({ actions: await scopedClient(baseClient, project_id).listActions() })));

  server.tool("invoke_action", "Invoke one enabled read, compute, or proposal action from the authenticated project catalog", {
    project_id: projectIdSchema,
    action_id: z.string().min(1).max(256),
    input: z.record(z.unknown()).default({}),
  }, guarded(async ({ project_id, action_id, input }) => {
    if (AUTHOR_OPERATION_ACTIONS.has(action_id)) return errorResult("FORBIDDEN", "MCP cannot approve, checkpoint, reconcile, apply, or publish author changes");
    if (byteLength(input) > 1_048_576) return errorResult("INVALID_INPUT", "Action input exceeds the 1 MiB MCP limit");
    const client = scopedClient(baseClient, project_id);
    const action = (await client.listActions()).find((candidate) => candidate.id === action_id);
    if (!action) return errorResult("ACTION_UNAVAILABLE", `Action is not enabled: ${action_id}`);
    if (!["read", "compute", "propose"].includes(action.effect)) return errorResult("FORBIDDEN", "MCP can invoke only read, compute, and proposal actions");
    return invoke(client, action_id, input);
  }));
}
