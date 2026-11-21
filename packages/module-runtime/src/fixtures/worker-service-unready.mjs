import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.on("SIGTERM", () => {});
// The test validates this PID and timestamp before checking delayed termination.
writeFileSync(join(tmpdir(), `codexia-unready-worker-${process.pid}-${randomUUID()}`), `initialized:${process.pid}:${Date.now()}`, { flag: "wx", mode: 0o600 });
setInterval(() => {}, 1000);
