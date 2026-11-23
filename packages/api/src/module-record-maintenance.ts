import {
  convertPublishingEpisodesYaml, convertPublishingShareGrantJsonl,
  NLP_FEATURE_SETTINGS_KEY, NLP_LEGACY_FEATURE_SETTINGS_PATH, parseNlpFeatureSettings,
  PRIVATE_PUBLISHING_PATHS, PUBLISHING_EPISODES_KEY, PUBLISHING_SHARE_GRANTS_KEY,
} from "@codexia/contracts";
import type { JsonObject, Persistence, PersistenceReader, ProjectId } from "@codexia/persistence-contracts";

const legacyModule = "core.artifacts";
const [legacyEpisodesPath, legacyShareGrantsPath] = PRIVATE_PUBLISHING_PATHS;
const publishingRecords = [
  { path: legacyEpisodesPath, key: PUBLISHING_EPISODES_KEY, convert: convertPublishingEpisodesYaml },
  { path: legacyShareGrantsPath, key: PUBLISHING_SHARE_GRANTS_KEY, convert: convertPublishingShareGrantJsonl },
] as const;
const nlpRecords = [{
  path: NLP_LEGACY_FEATURE_SETTINGS_PATH,
  key: NLP_FEATURE_SETTINGS_KEY,
  convert(content: string) {
    const saved = JSON.parse(content, (_key, value: unknown) => {
      if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Unrepresentable JSON number");
      return value;
    }) as JsonObject;
    return parseNlpFeatureSettings(saved);
  },
}];

interface RecordFormat {
  path: string;
  key: string;
  convert(content: string): JsonObject;
}

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

function assertJsonbTextIsRepresentable(value: JsonObject): void {
  // PostgreSQL JSONB rejects NUL and unpaired surrogates in both keys and values.
  const unsupportedText = /[\u0000\uD800-\uDFFF]/u;
  JSON.stringify(value, (key, item: unknown) => {
    if (unsupportedText.test(key) || (typeof item === "string" && unsupportedText.test(item))) {
      throw new TypeError("Record contains text that PostgreSQL JSONB cannot represent");
    }
    return item;
  });
}

async function plannedRecords(
  reader: PersistenceReader, projectId: ProjectId, moduleId: string, label: string, recordFormats: readonly RecordFormat[],
) {
  const plan: Array<{ path: string; key: string; legacyVersion: number; value: JsonObject }> = [];
  for (const { path, key, convert } of recordFormats) {
    const legacy = await reader.getModuleRecord(projectId, legacyModule, path);
    if (!legacy || legacy.value.deleted === true) continue;
    if (await reader.getModuleRecord(projectId, moduleId, key)) {
      throw new Error(`Project ${projectId} contains both source and canonical ${label} records for ${key}`);
    }
    let value: JsonObject;
    try {
      value = convert(artifactText(legacy.value));
      assertJsonbTextIsRepresentable(value);
    } catch { throw new Error(`Project ${projectId} cannot convert its ${label} source record for ${key}`); }
    plan.push({ path, key, legacyVersion: legacy.version, value });
  }
  return plan;
}

type RecordMaintenanceMode = "check" | "apply";

/** Validate first, then replace the project’s current source rows in a single transaction. */
async function maintainRecords(
  persistence: Persistence, projectId: ProjectId, mode: RecordMaintenanceMode,
  moduleId: string, label: string, recordFormats: readonly RecordFormat[],
): Promise<{ pending: number; migrated: number }> {
  if (mode === "check") {
    const plan = await persistence.read(reader => plannedRecords(reader, projectId, moduleId, label, recordFormats));
    return { pending: plan.length, migrated: 0 };
  }
  return persistence.transaction(async tx => {
    await tx.assertProjectVersion(projectId);
    const plan = await plannedRecords(tx, projectId, moduleId, label, recordFormats);
    for (const { path, key, legacyVersion, value } of plan) {
      await tx.saveModuleRecord({ projectId, moduleId, key, value, expectedVersion: null });
      await tx.saveModuleRecord({ projectId, moduleId: legacyModule, key: path, value: { deleted: true }, expectedVersion: legacyVersion });
    }
    return { pending: 0, migrated: plan.length };
  });
}

export function maintainPublishingRecords(persistence: Persistence, projectId: ProjectId, mode: RecordMaintenanceMode) {
  return maintainRecords(persistence, projectId, mode, "publishing", "Publishing", publishingRecords);
}

export function maintainNlpFeatureSettings(persistence: Persistence, projectId: ProjectId, mode: RecordMaintenanceMode) {
  return maintainRecords(persistence, projectId, mode, "nlp", "NLP feature settings", nlpRecords);
}
