import assert from "node:assert/strict";
import test from "node:test";
import { splitIntoSentenceOffsets, type MorphologyAnalysis } from "@codexia/module-nlp";
import { analyzeDiagnostics } from "./analysis.js";
import { DEFAULT_PLOT_LEXICON } from "./plot/types.js";
import { DEFAULT_TONE_LEXICON } from "./tone/types.js";

const text = "空を見た。彼を待った。扉が開いた。";
const morphology: MorphologyAnalysis = {
  text,
  tokens: [],
  sentences: splitIntoSentenceOffsets(text).map(({ start, end }) => ({
    start,
    end,
    text: text.slice(start, end),
    tokens: [],
  })),
};

async function analyze(severity: NonNullable<Parameters<typeof analyzeDiagnostics>[0]["lintConfig"]["severity"]>) {
  return analyzeDiagnostics({
    text,
    knownTerms: [],
    morphology,
    lintConfig: { rules: [], severity },
    toneLexicon: DEFAULT_TONE_LEXICON,
    plotLexicon: DEFAULT_PLOT_LEXICON,
  });
}

test("configured infoMin suppresses low-count rhythm findings while defaults retain them", async () => {
  const defaultResult = await analyze({ rhythm: { infoMin: 3, mediumMin: 5 } });
  assert.equal(defaultResult.analysis.rhythmWarnings[0]?.count, 3);
  assert.deepEqual(defaultResult.issues.filter(({ kind }) => kind === "rhythm").map(({ severity }) => severity), ["info"]);

  const raisedInfoThreshold = await analyze({ rhythm: { infoMin: 4, mediumMin: 5 } });
  assert.equal(raisedInfoThreshold.analysis.rhythmWarnings[0]?.count, 3);
  assert.deepEqual(raisedInfoThreshold.issues.filter(({ kind }) => kind === "rhythm"), []);

  const loweredMediumThreshold = await analyze({ rhythm: { infoMin: 2, mediumMin: 3 } });
  assert.deepEqual(loweredMediumThreshold.issues.filter(({ kind }) => kind === "rhythm").map(({ severity }) => severity), ["medium"]);
});
