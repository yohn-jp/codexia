import { useState } from "react";
import { PersistenceEntry } from "./persistence/PersistenceEntry";
import { PublicModuleView, publicModuleIdForPath } from "./contributions/PublicModuleView";
import { loadThemeMode, persistThemeMode, type ThemeMode } from "./theme";

export function App({ initialTheme, mode = "desktop" }: { initialTheme?: ThemeMode; mode?: "desktop" | "mobile" }) {
  const [theme, setTheme] = useState(initialTheme ?? loadThemeMode);
  const [error, setError] = useState("");
  const publicModule = publicModuleIdForPath(window.location.pathname);
  if (publicModule) return <PublicModuleView moduleId={publicModule} themeMode={theme} themeError={error} onThemeChange={(next) => { setTheme(next); try { persistThemeMode(next); setError(""); } catch { setError("外観設定を保存できませんでした。"); } }} />;
  return <PersistenceEntry mode={mode} />;
}
export { createPostgresEditorEvidenceAdapter } from "./editor/postgresEvidenceAdapter";
export type { EditorEvidenceAdapter, EditorEvidenceIdentity, EditorEvidenceSnapshot, EditorPersistenceSave, EditorPersistenceSaveResult } from "./editor/evidence";
