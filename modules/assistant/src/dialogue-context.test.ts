import assert from "node:assert/strict";
import test from "node:test";
import { buildDialogueSketchSpeakerContext } from "./dialogue-context.js";

function fingerprint(entityId: string) {
  return {
    entityId,
    dialogueCount: 23,
    firstPersonDist: { z: 0.5, a: 0.5, middle: 0.25 },
    endingBigramDist: { "だ|よ": 0.75, "です|ね": 0.25 },
    politeRatio: 0.35,
    avgDialogueLength: 18.6,
    exclamationRate: 0.1,
    questionRate: 0.2,
  };
}

test("builds source-shaped voice, fingerprint, notes, blank headings, and high-confidence examples", () => {
  const result = buildDialogueSketchSpeakerContext({
    entityId: "character-a",
    name: "A",
    raw: {
      voicePatterns: {
        firstPerson: [" 私 ", "私"],
        sentenceEndings: ["ます"],
        tone: "淡々としている",
      },
      voice: {
        first_person: [{ name: "僕", reading: "ぼく" }],
        duality: {
          outer: {
            first_person: { name: "わたし" },
            second_person: { form: "あなた", note: "親しい相手" },
            tone: "静かな口調",
            register: "丁寧",
            sentence_endings: [
              { example: "かな", note: "親しい場面" },
              { note: "柔らかい語尾" },
            ],
          },
        },
      },
      voice_profiles: [
        {
          id: "informal",
          context_trigger: { type: "match_metadata", key: "relationship", value: "friend" },
          firstPerson: ["俺"],
          sentenceEndings: ["だよ", "ね"],
        },
        { id: "first-person-only", firstPerson: ["ぼく"] },
        { id: "invalid", sentenceEndings: [] },
      ],
      notes: {
        lead: [{ type: "paragraph", text: "人物概要" }],
        sections: [
          { heading: "未記入", body: [], children: [] },
          {
            heading: "記入済み",
            body: [{ type: "paragraph", text: "設定メモ" }],
            children: [{ heading: "子の未記入", body: [], children: [] }],
          },
          {
            heading: "分類のみ空",
            body: [{ type: "definitions", items: [{ term: "", description: " " }] }],
            children: [],
          },
          {
            heading: "Meta",
            body: [{ type: "paragraph", text: "同ディレクトリの voice.yaml を参照" }],
            children: [],
          },
        ],
      },
    },
    speakerDialogues: {
      characterId: "character-a",
      count: 9,
      minConfidence: "high",
      lines: [
        { text: "old", sceneId: "s0", sceneName: "S0", sentenceIndex: 1, confidence: "high", reason: "rule" },
        { text: "ignore-low", sceneId: "s1", sceneName: "S1", sentenceIndex: 1, confidence: "low", reason: "rule" },
        ...Array.from({ length: 7 }, (_, index) => ({
          text: `high-${index + 1}`,
          sceneId: `s${index + 1}`,
          sceneName: `S${index + 1}`,
          sentenceIndex: index + 1,
          confidence: "high" as const,
          reason: "preceding-narration",
        })),
      ],
    },
    speakerProfiles: { fingerprints: [fingerprint("other-character"), fingerprint("character-a")] },
  });

  assert.equal(result.entityId, "character-a");
  assert.equal(result.name, "A");
  const voice = result.voiceProfileExcerpt ?? "";
  assert.match(voice, /一人称: 私、俺、ぼく、僕、わたし/u);
  assert.match(voice, /静かな口調/u, "the explicit voice definition wins over the generic pattern");
  assert.doesNotMatch(voice, /淡々としている|invalid/u);
  for (const feature of ["ます", "あなた", "親しい相手", "かな", "柔らかい語尾", "丁寧", "relationship=friend", "だよ、ね"]) {
    assert.ok(voice.includes(feature), `voice context carries ${feature}`);
  }
  assert.equal(result.fingerprintSummary?.entityId, "character-a");
  assert.equal(result.fingerprintSummary?.dialogueCount, 23);
  assert.deepEqual(result.fingerprintSummary?.topFirstPersons, ["a", "z", "middle"]);
  assert.deepEqual(result.fingerprintSummary?.topEndings, ["だよ", "ですね"]);
  assert.equal(result.fingerprintSummary?.politeRatio, 0.35);
  assert.equal(result.fingerprintSummary?.avgDialogueLength, 18.6);
  assert.equal(result.fingerprintSummary?.exclamationRate, 0.1);
  assert.equal(result.fingerprintSummary?.questionRate, 0.2);
  assert.match(result.notesExcerpt ?? "", /人物概要[\s\S]*未記入[\s\S]*記入済み[\s\S]*設定メモ[\s\S]*分類のみ空[\s\S]*Meta/u);
  assert.doesNotMatch(result.notesExcerpt ?? "", /参照/u);
  assert.deepEqual(result.exampleDialogues, ["high-2", "high-3", "high-4", "high-5", "high-6", "high-7"]);
  assert.deepEqual(result.blankHeadings, ["未記入", "子の未記入", "分類のみ空"]);
});

test("supports missing public speaker data and rejects data for a different character", () => {
  const result = buildDialogueSketchSpeakerContext({
    entityId: "character-a",
    raw: {},
    speakerDialogues: {
      characterId: "character-b",
      count: 1,
      minConfidence: "high",
      lines: [{ text: "wrong speaker", sceneId: "s1", sceneName: "S1", sentenceIndex: 1, confidence: "high", reason: "rule" }],
    },
    speakerProfiles: { fingerprints: [fingerprint("character-b")] },
  });

  assert.deepEqual(result, {
    entityId: "character-a",
    name: "character-a",
    voiceProfileExcerpt: null,
    fingerprintSummary: null,
    notesExcerpt: null,
    exampleDialogues: [],
    blankHeadings: [],
  });
});

test("clips voice and notes excerpts to source bounds and accepts legacy notes", () => {
  const large = "x".repeat(1_300);
  const result = buildDialogueSketchSpeakerContext({
    entityId: "character-a",
    raw: {
      voicePatterns: { tone: large },
      notes: {
        lead: `${large}\n\n- 秘密: omitted from paragraph excerpt`,
        sections: [{ heading: "旧形式", body: [{ text: "旧形式ノート" }], children: [] }],
      },
    },
  });

  assert.equal(result.voiceProfileExcerpt?.length, 1_200);
  assert.ok(result.voiceProfileExcerpt?.endsWith("…"));
  assert.equal(result.notesExcerpt?.length, 801);
  assert.ok(result.notesExcerpt?.endsWith("…"));
  assert.deepEqual(result.blankHeadings, []);
});
