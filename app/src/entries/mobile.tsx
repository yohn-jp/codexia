import "../styles.css";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { installNativeSelectCspCompatibility } from "../browser/nativeSelect";
import { PersistenceEntry } from "../persistence/PersistenceEntry";
import { applyThemeMode, loadThemeMode } from "../theme";

const root = document.getElementById("root");
if (!root) throw new Error("Missing React root");
const theme = loadThemeMode();
applyThemeMode(theme);
installNativeSelectCspCompatibility(document);
createRoot(root).render(<BrowserRouter><PersistenceEntry mode="mobile" /></BrowserRouter>);
