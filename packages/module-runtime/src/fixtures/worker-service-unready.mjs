import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.on("SIGTERM", () => {});
// The test validates this PID and timestamp before checking delayed termination.
writeFileSync(join(tmpdir(), `codexia-unready-worker-${process.pid}`), `initialized:${process.pid}:${Date.now()}`);
setInterval(() => {}, 1000);
