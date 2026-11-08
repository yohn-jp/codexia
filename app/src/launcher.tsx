import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyThemeMode, loadThemeMode } from "./theme";
import "../styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing React root");
const theme = loadThemeMode();
applyThemeMode(theme);
const isReader = window.location.pathname.startsWith("/r/");
let remembered: string | null = null;
try { remembered = localStorage.getItem("scriptorium:ui-mode"); } catch { /* A choice remains available without storage. */ }
if (!isReader && (remembered === "desktop" || remembered === "mobile")) {
  const search = new URLSearchParams(window.location.search);
  search.set("store", "postgres");
  window.location.replace(`/${remembered}?${search}${window.location.hash}`);
} else {
  createRoot(root).render(isReader ? <App initialTheme={theme} /> : <InterfaceChoice />);
}

function InterfaceChoice() {
  const modeUrl = (mode: "desktop" | "mobile", storage: "postgres" | "git") => {
    const search = new URLSearchParams(window.location.search);
    if (storage === "postgres") search.set("store", "postgres");
    else search.delete("store");
    return `/${mode}${search.size ? `?${search}` : ""}${window.location.hash}`;
  };
  const choose = (mode: "desktop" | "mobile") => {
    try { localStorage.setItem("scriptorium:ui-mode", mode); } catch { /* Direct links remain usable. */ }
    window.location.assign(modeUrl(mode, "postgres"));
  };
  const chooseGit = (mode: "desktop" | "mobile") => {
    try { localStorage.setItem("scriptorium:ui-mode", mode); } catch { /* Direct links remain usable. */ }
    window.location.assign(modeUrl(mode, "git"));
  };
  return <section className="empty-state" aria-labelledby="interface-title">
    <p className="eyebrow">Codexia</p>
    <h1 id="interface-title">執筆画面を選ぶ</h1>
    <p>新しい作品はPostgreSQLへ保存します。既存のGit作品も別の画面から開けます。</p>
    <p><button type="button" onClick={() => choose("desktop")}>Desktop — PostgreSQL作品</button></p>
    <p><button type="button" onClick={() => choose("mobile")}>Mobile — PostgreSQL作品</button></p>
    <details>
      <summary>Git repository workspace</summary>
      <p><button type="button" onClick={() => chooseGit("desktop")}>Desktop — Git作品</button></p>
      <p><button type="button" onClick={() => chooseGit("mobile")}>Mobile — Git作品</button></p>
    </details>
  </section>;
}
