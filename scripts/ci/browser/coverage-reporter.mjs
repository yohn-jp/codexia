import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeBrowserCoverage } from "./shards.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// Explicit phase steps and fixture/hook timing are observational only;
// nested durations overlap and must never be summed as elapsed CI time.
function timingSteps(steps) {
  return steps.flatMap(step => [
    ...((step.category === "fixture" || step.category === "hook" ||
      (step.category === "test.step" && step.title.startsWith("CI phase: ")))
      ? [{ category: step.category, title: step.title, durationMs: step.duration }] : []),
    ...timingSteps(step.steps ?? []),
  ]);
}

export default class BrowserCoverageReporter {
  constructor({ outputFile }) {
    if (typeof outputFile !== "string" || outputFile.length === 0) {
      throw new Error("The browser coverage reporter requires an outputFile");
    }
    this.outputFile = path.resolve(outputFile);
    this.discovered = [];
  }

  onBegin(_config, suite) {
    this.discovered = suite.allTests();
  }

  async onEnd(result) {
    const outcomes = this.discovered.map((test) => {
      if (test.results.length === 0) return "notRun";
      return test.outcome();
    });
    const profile = process.env.CODEXIA_E2E_PROFILE ?? "";
    const shard = process.env.CODEXIA_E2E_SHARD ?? "";
    const project = process.env.CODEXIA_E2E_PROJECT ?? "";
    const file = process.env.CODEXIA_E2E_TEST_FILE ?? "";
    let summary;
    let error;
    try {
      summary = summarizeBrowserCoverage({ expected: this.discovered.length, outcomes });
      if (summary.executed === 0) error = "No browser case executed";
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    const complete = Boolean(summary)
      && result.status === "passed"
      && summary.executed > 0
      && summary.failed === 0
      && summary.notRun === 0;
    const report = {
      schemaVersion: 1,
      sourceSha: process.env.CODEXIA_EXPECTED_SHA ?? null,
      outcome: complete ? "PASS" : "FAIL",
      runStatus: result.status,
      profile,
      shard,
      project,
      file,
      ...summary,
      ...(error ? { error } : {}),
      tests: this.discovered.map((test, index) => ({
        title: test.titlePath().join(" › "),
        file: path.relative(root, test.location.file),
        line: test.location.line,
        outcome: outcomes[index],
        attempts: test.results.map(attempt => ({
          retry: attempt.retry,
          workerIndex: attempt.workerIndex,
          status: attempt.status,
          durationMs: attempt.duration,
          phases: timingSteps(attempt.steps),
        })),
      })),
    };
    await mkdir(path.dirname(this.outputFile), { recursive: true });
    await writeFile(this.outputFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`BROWSER_COVERAGE ${JSON.stringify(report)}\n`);
    if (!complete) return { status: "failed" };
  }
}
