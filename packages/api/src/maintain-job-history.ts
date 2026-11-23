import { JobHistoryError, maintainJobHistory } from "./job-history-store.js";

async function main(): Promise<void> {
  const [mode] = process.argv.slice(2);
  if ((mode !== "--check" && mode !== "--apply") || process.argv.length !== 3) {
    throw new JobHistoryError("job_history_usage", "Usage: maintain-job-history --check|--apply");
  }
  const usageDirectory = process.env.CODEXIA_USAGE_DIR;
  if (!usageDirectory?.trim()) {
    throw new JobHistoryError("job_history_path_invalid", "CODEXIA_USAGE_DIR is required for job history maintenance");
  }
  const report = await maintainJobHistory(usageDirectory, mode === "--check" ? "check" : "apply");
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.status === "maintenance_required") process.exitCode = 2;
}

main().catch((error: unknown) => {
  const message = error instanceof JobHistoryError ? error.message : "Host job history maintenance failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
