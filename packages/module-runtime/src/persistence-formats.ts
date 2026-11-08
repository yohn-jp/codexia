/**
 * Current module-owned durable formats under `meta/codexia/modules`.
 *
 * The IDs map to existing module readers, writers, and migration paths. Most
 * files predate an in-file format marker, so version 1 names the format the
 * current code reads and writes. Explicit version markers are still checked
 * by the hosted runtime scanner. Opaque migration archives are reported for
 * status visibility, but they do not establish rollback compatibility.
 */
export interface ModulePersistencePath {
  /** Match only this file path. */
  kind: "exact";
  path: string;
}

export interface ModulePersistencePrefix {
  /** Match files below this slash-terminated prefix. */
  kind: "prefix";
  path: string;
}

export interface ModulePersistenceFormat {
  moduleId: string;
  formatId: string;
  version: number;
  paths: readonly (ModulePersistencePath | ModulePersistencePrefix)[];
  content: "json" | "jsonl" | "text" | "binary" | "opaque";
  readable: boolean;
  writable: boolean;
  /** This family is preserved by migration code without semantic parsing. */
  preserveOnly?: true;
}

const format = (
  moduleId: string,
  name: string,
  path: string,
  content: ModulePersistenceFormat["content"],
  readable: boolean,
  writable: boolean,
  options: { prefix?: true; preserveOnly?: true } = {},
): ModulePersistenceFormat => ({
  moduleId,
  formatId: `codexia.module-${moduleId}.${name}`,
  version: 1,
  paths: [{ kind: options.prefix ? "prefix" : "exact", path }],
  content,
  readable,
  writable,
  ...(options.preserveOnly ? { preserveOnly: true } : {}),
});

const preserved = (moduleId: string, name: string, path: string): ModulePersistenceFormat =>
  format(moduleId, name, path, "opaque", false, false, { prefix: true, preserveOnly: true });

/**
 * One shared source for RuntimeStatus scans and build CompositionManifest
 * declarations. `readable`/`writable` reflect packaged code support; callers
 * must not infer support from a module being selected or a path being known.
 */
export const MODULE_PERSISTENCE_FORMATS: readonly ModulePersistenceFormat[] = [
  format("assistant", "model-settings", "meta/codexia/modules/assistant/model-settings.json", "json", true, true),
  format("assistant", "usage", "meta/codexia/modules/assistant/usage.jsonl", "jsonl", true, true),
  preserved("assistant", "legacy-files", "meta/codexia/modules/assistant/legacy/files/"),

  format("diagnostics", "lint-rules", "meta/codexia/modules/diagnostics/lint-rules.yaml", "text", true, true),
  format("diagnostics", "tone-lexicon", "meta/codexia/modules/diagnostics/tone-lexicon.yaml", "text", true, true),
  format("diagnostics", "plot-lexicon", "meta/codexia/modules/diagnostics/plot-lexicon.yaml", "text", true, true),
  preserved("diagnostics", "legacy-files", "meta/codexia/modules/diagnostics/legacy/files/"),

  format("nlp", "synonyms", "meta/codexia/modules/nlp/synonyms.yaml", "text", true, true),
  format("nlp", "candidate-ignore-list", "meta/codexia/modules/nlp/candidate-ignore-list.yaml", "text", true, true),
  format("nlp", "feature-settings", "meta/codexia/modules/nlp/feature-settings.json", "json", true, true),
  preserved("nlp", "legacy-files", "meta/codexia/modules/nlp/legacy/files/"),

  format("publishing", "episodes", "meta/codexia/modules/publishing/episodes.yaml", "text", true, true),
  format("publishing", "share-grants", "meta/codexia/modules/publishing/share-grants.jsonl", "jsonl", true, true),
  format("publishing", "cover", "meta/codexia/modules/publishing/assets/cover.jpg", "binary", true, false),
  preserved("publishing", "legacy-files", "meta/codexia/modules/publishing/legacy/files/"),
  format("publishing", "legacy-share-grants", "meta/codexia/modules/publishing/legacy/share-grants.jsonl", "jsonl", true, false),

  format("semantic", "settings", "meta/codexia/modules/semantic/settings.json", "json", true, true),
  format("semantic", "contradiction-dismissals", "meta/codexia/modules/semantic/contradiction-dismissals.jsonl", "jsonl", true, true),
  preserved("semantic", "legacy-files", "meta/codexia/modules/semantic/legacy/files/"),

  format("speaker", "corrections", "meta/codexia/modules/speaker/corrections.jsonl", "jsonl", true, true),
  format("speaker", "adopted-model", "meta/codexia/modules/speaker/adopted-model.json", "json", true, true),
  preserved("speaker", "legacy-files", "meta/codexia/modules/speaker/legacy/files/"),

  format("story", "series", "meta/codexia/modules/story/v1/series.json", "json", true, true),
  format("story", "state-proposals", "meta/codexia/modules/story/state-proposals.jsonl", "jsonl", true, true),
  format("story", "zukan-suggestions", "meta/codexia/modules/story/zukan-suggestions.jsonl", "jsonl", true, true),
  preserved("story", "change-sets", "meta/codexia/modules/story/change-sets/"),
  preserved("story", "local-snapshots", "meta/codexia/modules/story/local-snapshots/"),
  preserved("story", "legacy-sqlite", "meta/codexia/modules/story/legacy/sqlite/"),
  preserved("story", "legacy-files", "meta/codexia/modules/story/legacy/files/"),
];
