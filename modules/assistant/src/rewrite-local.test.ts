import assert from "node:assert/strict";
import test from "node:test";
import { buildRewriteLocalSuggestions } from "./rewrite-local.js";

test("buildRewriteLocalSuggestions splits at the first source-priority connective", () => {
  const result = buildRewriteLocalSuggestions("彼は息を整え、窓を見たが、しかし外には誰もいなかった。");

  assert.equal(result.sentenceSplit?.text, "彼は息を整え、窓を見たが。しかし外には誰もいなかった。");
  assert.ok(result.sentenceSplit.rationale.trim());
  assert.equal(result.tellToShow, undefined);
});

test("buildRewriteLocalSuggestions enforces source sentence-split minimums", () => {
  assert.deepEqual(buildRewriteLocalSuggestions("短いが、これも短い。"), {});
  const suggestion = buildRewriteLocalSuggestions("これは十分に長い前半、そして後半も十分に長い文です。");
  assert.equal(suggestion.sentenceSplit?.text, "これは十分に長い前半。そして後半も十分に長い文です。");
});

test("buildRewriteLocalSuggestions prefers the first corpus action only for recognized tell expressions", () => {
  const corpus = ["彼女は袖口を握り、うつむいた。", "別の所作。"];
  const suggestion = buildRewriteLocalSuggestions("彼女は悲しかった。", corpus).tellToShow;
  assert.equal(suggestion?.source, "corpus");
  assert.equal(suggestion.text, corpus[0]);
  assert.deepEqual(buildRewriteLocalSuggestions("彼女は廊下を歩いた。", ["無関係な所作。"]), {});
});

test("heuristic suggestions turn supported emotions into distinct physical descriptions", () => {
  const cases = [
    ["悲しかった", /喉.*落ちた/u],
    ["悲しい", /喉.*落ちる/u],
    ["怒っていた", /拳.*込めていた/u],
    ["怒った", /拳.*込めた/u],
    ["怖かった", /背筋.*止められた/u],
    ["怖い", /背筋.*止められる/u],
    ["嬉しかった", /頬.*こぼれた/u],
    ["嬉しい", /頬.*こぼれる/u],
    ["緊張していた", /指先.*込んでいた/u],
    ["緊張した", /指先.*込んだ/u],
  ] as const;

  for (const [emotion, bodyCue] of cases) {
    const suggestion = buildRewriteLocalSuggestions(`青子は${emotion}！`).tellToShow;
    assert.equal(suggestion?.source, "heuristic", emotion);
    assert.match(suggestion.text, bodyCue, emotion);
    assert.equal(suggestion.text.startsWith("青子は"), true, emotion);
    assert.equal(suggestion.text.endsWith("！"), true, emotion);
    assert.equal(suggestion.text.includes(emotion), false, emotion);
  }
});

test("several emotions are rewritten in place without changing surrounding text or punctuation", () => {
  const suggestion = buildRewriteLocalSuggestions("彼女はとても悲しかった。	彼は怒っていた！").tellToShow;
  assert.equal(suggestion?.source, "heuristic");
  const [first, second] = suggestion.text.split("	");
  assert.match(first ?? "", /^彼女はとても.*喉.*。$/u);
  assert.match(second ?? "", /^彼は.*拳.*！$/u);

  const trimmed = buildRewriteLocalSuggestions("  彼女は廊下を歩いた。  ").tellToShow;
  assert.equal(trimmed?.source, "heuristic");
  assert.equal(trimmed.text, "彼女は廊下を歩いた。");
});
