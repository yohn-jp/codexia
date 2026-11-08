import "../../styles.css";
import { createRoot } from "react-dom/client";
import { SharedApplication } from "../App";
import { installNativeSelectCspCompatibility } from "../browser/nativeSelect";
import { PersistenceEntry } from "../persistence/PersistenceEntry";
import { DesktopShell } from "../shells/desktop/DesktopShell";
import { applyThemeMode, loadThemeMode } from "../theme";

const root = document.getElementById("root");
if (!root) throw new Error("Missing React root");
const theme = loadThemeMode();
applyThemeMode(theme);
installNativeSelectCspCompatibility(document);
const application = <SharedApplication mode="desktop" Shell={DesktopShell} initialTheme={theme} />;
createRoot(root).render(new URLSearchParams(window.location.search).get("store") === "postgres"
  ? <PersistenceEntry mode="desktop" fallback={application} />
  : application);
