import {
  convertPublishingEpisodesYaml, convertPublishingShareGrantJsonl,
  PRIVATE_PUBLISHING_PATHS, PUBLISHING_EPISODES_KEY, PUBLISHING_SHARE_GRANTS_KEY,
} from "@codexia/contracts";
import type { JsonObject, Persistence, PersistenceReader, ProjectId } from "@codexia/persistence-contracts";

const legacyModule = "core.artifacts";
const nativeModule = "publishing";
const [legacyEpisodesPath, legacyShareGrantsPath] = PRIVATE_PUBLISHING_PATHS;
const recordFormats = [
  { path: legacyEpisodesPath, key: PUBLISHING_EPISODES_KEY, convert: convertPublishingEpisodesYaml },
  { path: legacyShareGrantsPath, key: PUBLISHING_SHARE_GRANTS_KEY, convert: convertPublishingShareGrantJsonl },
] as const;

function artifactText(value: JsonObject): string {
  const { content, encoding = "utf8" } = value;
  if (typeof content !== "string") throw new Error("Artifact content must be text");
  if (encoding === "utf8") return content;
  if (encoding !== "base64") throw new Error("Invalid artifact encoding");
  const encoded = content.replace(/\s/gu, "").replaceAll("-", "+").replaceAll("_", "/");
  const bytes = Buffer.from(encoded, "base64");
  const canonical = bytes.toString("base64");
  if (encoded !== canonical && encoded !== canonical.replace(/=+$/u, "")) throw new Error("Invalid artifact base64");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

async function plannedRecords(reader: PersistenceReader, projectId: ProjectId) {
  const plan: Array<{ path: string; key: string; legacyVersion: number; value: JsonObject }> = [];
  for (const { path, key, convert } of recordFormats) {
    const legacy = await reader.getModuleRecord(projectId, legacyModule, path);
    if (!legacy || legacy.value.deleted === true) continue;
    if (await reader.getModuleRecord(projectId, nativeModule, key)) {
      throw new Error(`Project ${projectId} contains both source and canonical Publishing records for ${key}`);
    }
    let value: JsonObject;
    try { value = convert(artifactText(legacy.value)); }
    catch { throw new Error(`Project ${projectId} cannot convert its Publishing source record for ${key}`); }
    plan.push({ path, key, legacyVersion: legacy.version, value });
  }
  return plan;
}

/** Validate first, then replace the project’s current source rows in a single transaction. */
export async function maintainPublishingRecords(
  persistence: Persistence, projectId: ProjectId, mode: "check" | "apply",
): Promise<{ pending: number; migrated: number }> {
  if (mode === "check") {
    const plan = await persistence.read(reader => plannedRecords(reader, projectId));
    return { pending: plan.length, migrated: 0 };
  }
  return persistence.transaction(async tx => {
    await tx.assertProjectVersion(projectId);
    const plan = await plannedRecords(tx, projectId);
    for (const { path, key, legacyVersion, value } of plan) {
      await tx.saveModuleRecord({ projectId, moduleId: nativeModule, key, value, expectedVersion: null });
      await tx.saveModuleRecord({ projectId, moduleId: legacyModule, key: path, value: { deleted: true }, expectedVersion: legacyVersion });
    }
    return { pending: 0, migrated: plan.length };
  });
}
