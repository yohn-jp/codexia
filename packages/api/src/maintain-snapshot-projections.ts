import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CoreStore, SNAPSHOT_PROJECTION_EPOCH } from "@codexia/core";
import type { ProjectId } from "@codexia/persistence-contracts";
import { createPostgresPersistence, verifyPostgresSchema } from "@codexia/persistence-postgres";

function maintenanceArguments(args: string[]): { mode: "--check" | "--apply"; projectId?: ProjectId } {
  const [mode, scope, projectId] = args;
  if ((mode !== "--check" && mode !== "--apply") ||
      (args.length !== 1 && (args.length !== 3 || scope !== "--project" ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(projectId ?? "")))) {
    throw new Error("Usage: maintain-snapshot-projections --check|--apply [--project UUID]");
  }
  return projectId === undefined ? { mode } : { mode, projectId: projectId as ProjectId };
}

async function main(): Promise<void> {
  const { mode, projectId } = maintenanceArguments(process.argv.slice(2));
  const databaseUrl = process.env.CODEXIA_DATABASE_URL;
  if (!databaseUrl) throw new Error("CODEXIA_DATABASE_URL is required for snapshot projection maintenance");
  await verifyPostgresSchema(databaseUrl);
  const persistence = createPostgresPersistence(databaseUrl);
  const scope = projectId === undefined ? {} : { projectId };
  try {
    const databaseMode = await persistence.snapshotStartupMode();
    if (projectId && !await persistence.read(reader => reader.getProject(projectId))) {
      throw new Error("Snapshot projection maintenance project was not found");
    }
    if (mode === "--check") {
      const pendingProjectIds = await persistence.findUnprovenCurrentSnapshotProjectIds(SNAPSHOT_PROJECTION_EPOCH, { ...scope, limit: 10 });
      console.log(JSON.stringify({ status: pendingProjectIds.length ? "maintenance_required" : "ready", pendingProjectIds }));
      if (pendingProjectIds.length) process.exitCode = 2;
      return;
    }
    if (databaseMode !== "transition") throw new Error("Snapshot projection maintenance requires the writable PostgreSQL role");

    const store = new CoreStore({ persistence });
    let after: ProjectId | undefined;
    let projectsProcessed = 0;
    for (;;) {
      const pending = await persistence.findUnprovenCurrentSnapshotProjectIds(SNAPSHOT_PROJECTION_EPOCH,
        { ...scope, ...(after === undefined ? {} : { after }) });
      if (pending.length === 0) break;
      for (const id of pending) await store.prepareSnapshotReuse(id);
      projectsProcessed += pending.length;
      after = pending.at(-1);
    }
    const remaining = await persistence.findUnprovenCurrentSnapshotProjectIds(SNAPSHOT_PROJECTION_EPOCH, { ...scope, limit: 1 });
    if (remaining.length) throw new Error("Snapshot projection maintenance still has pending projects");
    console.log(JSON.stringify({ status: "ready", projectsProcessed }));
  } finally {
    await persistence.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Snapshot projection maintenance failed";
    process.stderr.write(message.replace(/\bpostgres(?:ql)?:\/\/\S+/gu, "[redacted database URL]") + "\n");
    process.exitCode = 1;
  });
}
