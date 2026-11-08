import "../../styles.css";
import { createRoot } from "react-dom/client";
import { IonReactRouter } from "@ionic/react-router";
import { SharedApplication } from "../App";
import { installNativeSelectCspCompatibility } from "../browser/nativeSelect";
import { PersistenceEntry } from "../persistence/PersistenceEntry";
import { MobileShell } from "../shells/mobile/MobileShell";
import { applyThemeMode, loadThemeMode } from "../theme";

const root = document.getElementById("root");
if (!root) throw new Error("Missing React root");
const theme = loadThemeMode();
applyThemeMode(theme);
installNativeSelectCspCompatibility(document);
const application = <PersistenceEntry
  mode="mobile"
  fallback={<SharedApplication mode="mobile" Shell={MobileShell} initialTheme={theme} />}
/>;
createRoot(root).render(<IonReactRouter>{new URLSearchParams(window.location.search).get("store") === "postgres"
  ? application
  : <SharedApplication mode="mobile" Shell={MobileShell} initialTheme={theme} />}</IonReactRouter>);
