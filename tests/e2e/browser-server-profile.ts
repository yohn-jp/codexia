import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ModuleId, ModuleManifest } from "@codexia/contracts";
import type { ModuleLoader, ModuleRuntimeOptions } from "@codexia/module-runtime";

/** The CI group validates the same-run, same-source receipt before launching the shard. */
export function hasRestoredBrowserProfile(profile: string): boolean {
  return process.env.CI === "true" && process.env.CODEXIA_CI_PROFILE_RESTORE === "success" &&
    process.env.CODEXIA_E2E_PROFILE === profile;
}

export async function browserServerProfile(profile: string, cacheDirectory: string): Promise<{
  profile: string;
  runtimeOptions?: ModuleRuntimeOptions;
}> {
  if (profile === "core") return { profile };
  const generatedPath = resolve(fileURLToPath(new URL("../../", import.meta.url)), "profiles", profile, "generated", "server.mjs");
  const composition = await import(pathToFileURL(generatedPath).href) as {
    profile: string;
    moduleManifests: ModuleManifest[];
    moduleLoaders: Partial<Record<ModuleId, ModuleLoader>>;
    moduleDirectories: ModuleRuntimeOptions["moduleDirectories"];
    moduleWorkerEntries: ModuleRuntimeOptions["workerEntries"];
  };
  if (composition.profile !== profile) throw new Error(`Generated E2E module profile does not match ${profile}`);
  return { profile, runtimeOptions: {
    manifests: composition.moduleManifests,
    enabled: composition.moduleManifests.map((manifest) => manifest.id),
    loaders: composition.moduleLoaders,
    moduleDirectories: composition.moduleDirectories,
    workerEntries: composition.moduleWorkerEntries,
    cacheDirectory,
  } };
}
