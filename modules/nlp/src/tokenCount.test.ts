import assert from "node:assert/strict";
import test from "node:test";
import {
  isSafeHuggingFaceModelId,
  resolveTokenCountConfiguration,
  sourceApproxTokenCount,
  validateTokenCountTexts,
} from "./tokenCount.js";

test("source-approved approximation counts CJK code points and conservatively rounds other text", () => {
  assert.equal(sourceApproxTokenCount(""), 0);
  assert.equal(sourceApproxTokenCount("駅で別れ"), 4);
  assert.equal(sourceApproxTokenCount("abcdef"), 2);
  assert.equal(sourceApproxTokenCount("駅abc"), 2);
});

test("model selection follows explicit model, tokenizer environment, then LLM environment", () => {
  const environment = { ARCADIA_TOKENIZER_MODEL: "env/tokenizer", ARCADIA_LLM_MODEL: "env/llm" };
  assert.equal(resolveTokenCountConfiguration(environment, { modelId: " explicit/model " }).modelId, "explicit/model");
  assert.equal(resolveTokenCountConfiguration(environment).modelId, "env/tokenizer");
  assert.equal(resolveTokenCountConfiguration({ ARCADIA_LLM_MODEL: "env/llm" }).modelId, "env/llm");
  assert.equal(resolveTokenCountConfiguration({}).fallbackReason, "model_unconfigured");
  assert.equal(resolveTokenCountConfiguration({ ARCADIA_TOKENIZER_BACKEND: "approx", ARCADIA_TOKENIZER_MODEL: "env/tokenizer" }).fallbackReason, "backend_approx");
  assert.equal(resolveTokenCountConfiguration({ ARCADIA_TOKENIZER_MODEL: "https://secret.example/tokenizer" }).fallbackReason, "tokenizer_unavailable");
  assert.equal(resolveTokenCountConfiguration({ ARCADIA_TOKENIZER_MODEL: "https://secret.example/tokenizer" }).modelId, undefined);
  assert.equal(isSafeHuggingFaceModelId("Xenova/multilingual-e5-small"), true);
  assert.equal(isSafeHuggingFaceModelId("../../outside"), false);
  assert.equal(isSafeHuggingFaceModelId("https://example.test/model"), false);
});

test("standalone runtime can select a mounted read-only tokenizer cache", () => {
  assert.equal(resolveTokenCountConfiguration({ CODEXIA_TOKENIZER_MODELS_DIR: "/models" }).modelsDir, "/models");
  assert.equal(resolveTokenCountConfiguration({ CODEXIA_TOKENIZER_MODELS_DIR: "/models", ARCADIA_TOKENIZER_MODEL: "env/tokenizer" }).modelId, "env/tokenizer");
});

test("token count batches accept their resource limits and reject the first excess input", () => {
  const perTextLimit = "é".repeat(32_768);
  assert.deepEqual(validateTokenCountTexts([perTextLimit]), [perTextLimit]);
  assert.throws(() => validateTokenCountTexts([perTextLimit + "x"]), /UTF-8 bytes/);

  const halfSizePassage = "x".repeat(32_768);
  const batchLimit = Array.from({ length: 32 }, () => halfSizePassage);
  assert.equal(validateTokenCountTexts(batchLimit).length, 32);
  assert.throws(() => validateTokenCountTexts([...batchLimit, "x"]), /total at most/);

  const itemLimit = Array.from({ length: 128 }, () => "駅");
  assert.equal(validateTokenCountTexts(itemLimit).length, 128);
  assert.throws(() => validateTokenCountTexts([...itemLimit, "駅"]), /between 1 and/);
  assert.throws(() => validateTokenCountTexts([]), /between 1 and/);
});
