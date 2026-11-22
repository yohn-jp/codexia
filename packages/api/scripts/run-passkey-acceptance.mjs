import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const testFile = fileURLToPath(new URL("../test/passkey-bootstrap.acceptance.test.ts", import.meta.url));
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", testFile], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: { ...process.env, CODEXIA_PASSKEY_ACCEPTANCE: "1" },
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.signal) throw new Error(`Passkey acceptance test terminated by ${result.signal}`);
process.exitCode = result.status ?? 1;
