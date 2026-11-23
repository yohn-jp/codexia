import { CONTRACT_VERSION, type ModuleDefinition, type ModuleManifest } from "@codexia/contracts";
import { createAssistantActions } from "./actions.js";

/** Local analysis and MCP-oriented prompt preparation; no in-process model provider. */
export const assistantManifest: ModuleManifest = {
  id: "assistant",
  version: "0.1.0",
  contractVersion: CONTRACT_VERSION,
  dependencies: ["story", "nlp", "diagnostics", "semantic", "speaker"],
  provides: [],
  requires: [],
  optionalRequires: [],
  serverEntry: "./dist/index.js",
  browserEntry: "./dist/browser.js",
  statePaths: [],
  locality: "local",
};

export async function createModule(): Promise<ModuleDefinition> {
  return {
    manifest: assistantManifest,
    actions: createAssistantActions(),
    ui: [
      { id: "assistant.rewrite", module: "assistant", slot: "dock", title: "ローカル言い換え", action: "assistant.rewrite" },
      { id: "assistant.aspect-review", module: "assistant", slot: "review", title: "章のローカルレビュー", action: "assistant.aspect.review" },
      { id: "assistant.context", module: "assistant", slot: "dock", title: "外部AI向けコンテキスト", action: "assistant.context.preview" },
    ],
    async dispose() {},
  };
}

export { createAssistantActions } from "./actions.js";
