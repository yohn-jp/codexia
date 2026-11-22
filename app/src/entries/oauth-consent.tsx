import { createRoot } from "react-dom/client";
import { OAuthConsentPage } from "../OAuthConsentPage";
import { applyThemeMode, loadThemeMode } from "../theme";
import "../oauth.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing React root");
applyThemeMode(loadThemeMode());
createRoot(root).render(<OAuthConsentPage />);
