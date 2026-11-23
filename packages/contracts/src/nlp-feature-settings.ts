import type { ModuleRecordJsonObject } from "./index.js";

export const NLP_FEATURE_SETTINGS_KEY = "feature-settings";
export const NLP_LEGACY_FEATURE_SETTINGS_PATH = "meta/scriptorium/modules/nlp/feature-settings.json";

export type NlpFeatureSettings = ModuleRecordJsonObject & { externalEnabled: ModuleRecordJsonObject };

export function parseNlpFeatureSettings(value: ModuleRecordJsonObject): NlpFeatureSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("NLP feature settings must be an object");
  }
  const externalEnabled = value.externalEnabled ?? {};
  if (typeof externalEnabled !== "object" || Array.isArray(externalEnabled)) {
    throw new TypeError("NLP externalEnabled must be an object");
  }
  return { ...value, externalEnabled };
}
