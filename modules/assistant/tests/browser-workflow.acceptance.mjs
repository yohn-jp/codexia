import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const workspaceRoot = resolve(packageRoot, "../..");
const { createServer } = await import(pathToFileURL(resolve(workspaceRoot, "app/node_modules/vite/dist/node/index.js")).href);
const projectId = "assistant-browser-fixture";
const snapshot = { projectId, projectVersion: 1 };
const calls = [];
const unexpected = [];
const malicious = "<img data-injected onerror=alert(1)>";
const actionData = {
  "assistant.rewrite": {
    text: "夜の駅で彼を見つけた。",
    sentenceIndex: 1,
    suggestions: [
      { text: "暗い駅で彼を見つけた。", strategy: "concise", rationale: "短くする", source: "source-heuristic" },
      { text: malicious, strategy: "contextual", rationale: "安全な表示", source: "source-heuristic" },
    ],
    provider: "local",
  },
  "assistant.rewrite.propose": { proposal: { id: "local-rewrite-proposal" } },
  "assistant.aspect.review": { findings: [{ aspect: "tempo", finding: "間を少し短くできます。" }] },
  "assistant.aspect.review.preview": { prompt: "章レビューのローカルプロンプト" },
  "assistant.context.preview": { parts: [{ kind: "manuscript", value: "実際の原稿" }] },
  "assistant.context.prompt.preview": { system: "根拠に基づきます。", prompt: "ローカルの文脈" },
};

const server = await createServer({ configFile: false, root: packageRoot, logLevel: "error",
  server: { host: "127.0.0.1", port: 0 } });
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CODEXIA_E2E_CHROMIUM ? { executablePath: process.env.CODEXIA_E2E_CHROMIUM } : {}),
  });
  await server.listen();
  const address = server.httpServer.address();
  assert.ok(address && typeof address !== "string");
  const origin = "http://127.0.0.1:" + address.port;
  const page = await browser.newPage();
  const pageErrors = [];
  const outbound = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    if (request.url().includes("/api/") || request.url().includes("provider")) outbound.push(request.url());
  });
  await page.goto(origin + "/tests/browser-workflow.html");
  await page.exposeFunction("assistantInvoke", async (actionId, input) => {
    calls.push({ actionId, input });
    if (!(actionId in actionData)) {
      unexpected.push(actionId);
      throw new Error("unexpected assistant action: " + actionId);
    }
    const data = actionData[actionId];
    return { ok: true, snapshot, data, ...(data.proposal ? { proposals: [data.proposal] } : {}) };
  });
  await page.evaluate(async (base) => {
    const { browserModule } = await import(base + "/src/browser.ts");
    const context = {
      projectId: "assistant-browser-fixture",
      snapshot: { projectId: "assistant-browser-fixture", projectVersion: 1 },
      signal: new AbortController().signal,
      invoke: (id, input) => window.assistantInvoke(id, input),
      propose: async () => { throw new Error("UI may not approve mutations"); },
      refresh: async () => {},
    };
    window.mountAssistant = async (id) => {
      window.unmountAssistant?.();
      window.unmountAssistant = await browserModule.mount(id, document.querySelector("#assistant-root"), context);
    };
  }, origin);

  await page.evaluate(() => window.mountAssistant("assistant.rewrite"));
  await page.getByLabel("シーンID").fill("sc-1");
  await page.getByLabel("対象文").fill("夜の駅で彼を見つけた。");
  await page.getByRole("button", { name: "ローカル候補を表示" }).click();
  await page.getByText("暗い駅で彼を見つけた。").first().waitFor();
  assert.equal(await page.locator("[data-injected]").count(), 0, "untrusted suggestion must be displayed only as text");
  assert.equal(calls.some(({ actionId }) => actionId === "assistant.rewrite.propose"), false);
  await page.getByRole("button", { name: "この候補をレビューへ送る" }).first().click();
  await page.getByText("local-rewrite-proposal").waitFor();
  assert.deepEqual(calls.find((call) => call.actionId === "assistant.rewrite.propose").input, {
    sceneId: "sc-1", selectedText: "夜の駅で彼を見つけた。",
    replacementText: "暗い駅で彼を見つけた。", sentenceIndex: 1,
  });

  await page.getByLabel("シーンID").fill("sc-stale");
  assert.equal(await page.getByRole("button", { name: "この候補をレビューへ送る" }).count(), 0,
    "editing the selected scene must invalidate stale rewrite proposals");

  await page.evaluate(() => window.mountAssistant("assistant.aspect-review"));
  await page.getByLabel("章ID").fill("ch-1");
  await page.getByRole("button", { name: "章をレビュー" }).click();
  await page.getByText("間を少し短くできます。").waitFor();
  await page.getByRole("button", { name: "プロンプトを表示" }).click();
  await page.getByText("章レビューのローカルプロンプト").waitFor();
  assert.deepEqual(calls.find(({ actionId }) => actionId === "assistant.aspect.review").input,
    { chapterId: "ch-1", aspects: ["tempo", "pov-shift", "over-explain"] });

  await page.evaluate(() => window.mountAssistant("assistant.context"));
  await page.getByLabel("シーンID").fill("sc-1");
  await page.getByLabel("質問").fill("駅はどこですか？");
  await page.getByRole("button", { name: "コンテキストを表示" }).click();
  await page.getByText("実際の原稿").waitFor();
  await page.getByRole("button", { name: "プロンプトを表示" }).click();
  await page.getByText("ローカルの文脈").waitFor();
  assert.equal(calls.some(({ actionId }) => actionId === "assistant.context.generate"), false);

  assert.deepEqual(outbound, [], "no direct provider or backend HTTP request is issued by local Assistant UI");
  assert.deepEqual(unexpected, []);
  assert.deepEqual(pageErrors, []);
  await page.evaluate(() => window.unmountAssistant());
  await page.close();
  console.log("PASS: local Assistant panels preserve preview, review, proposal and history without provider HTTP");
} finally {
  await browser?.close();
  await server.close();
}
