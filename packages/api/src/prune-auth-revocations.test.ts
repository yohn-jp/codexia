import assert from "node:assert/strict";
import test from "node:test";
import { assertAuthMigrationDatabaseIdentity } from "./migrate-auth.js";
import { requireExplicitPrune } from "./prune-auth-revocations.js";

function identityPool(row: { schema_name: string | null; role_name: string; owns_schema: boolean }) {
  return { async query() { return { rows: [row] }; } };
}

test("auth revocation prune requires the explicit apply flag", () => {
  assert.throws(() => requireExplicitPrune([]), /explicit --apply/u);
  assert.throws(() => requireExplicitPrune(["--apply", "extra"]), /explicit --apply/u);
  assert.doesNotThrow(() => requireExplicitPrune(["--apply"]));
});

test("auth maintenance requires the runtime role to own and use the auth schema", async () => {
  await assertAuthMigrationDatabaseIdentity(identityPool({ schema_name: "codexia_auth", role_name: "codexia_auth_runtime", owns_schema: true }) as never);
  await assert.rejects(
    assertAuthMigrationDatabaseIdentity(identityPool({ schema_name: "public", role_name: "codexia_auth_runtime", owns_schema: true }) as never),
    /requires role codexia_auth_runtime to own codexia_auth/u,
  );
  await assert.rejects(
    assertAuthMigrationDatabaseIdentity(identityPool({ schema_name: "codexia_auth", role_name: "app_runtime", owns_schema: false }) as never),
    /requires role codexia_auth_runtime to own codexia_auth/u,
  );
});
