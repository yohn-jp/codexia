import { createRoot } from "react-dom/client";
import { applyThemeMode, loadThemeMode } from "./theme";
import "../styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing React root");
const theme = loadThemeMode();
applyThemeMode(theme);

let remembered: string | null = null;
try { remembered = localStorage.getItem("scriptorium:ui-mode"); } catch { /* The picker works without local storage. */ }
if (remembered === "desktop" || remembered === "mobile") {
  const search = new URLSearchParams(window.location.search);
  search.delete("store");
  window.location.replace(`/${remembered}${search.size ? `?${search}` : ""}${window.location.hash}`);
} else {
  createRoot(root).render(<InterfaceChoice />);
}

function InterfaceChoice() {
  const choose = (mode: "desktop" | "mobile") => {
    try { localStorage.setItem("scriptorium:ui-mode", mode); } catch { /* Direct links remain usable. */ }
    const search = new URLSearchParams(window.location.search);
    search.delete("store");
    window.location.assign(`/${mode}${search.size ? `?${search}` : ""}${window.location.hash}`);
  };
  return <section className="empty-state" aria-labelledby="interface-title">
    <p className="eyebrow">Codexia</p>
    <h1 id="interface-title">執筆画面を選ぶ</h1>
    <p>作品はPostgreSQLへ保存されます。</p>
    <p><button type="button" onClick={() => choose("desktop")}>Desktop — キーボードで執筆</button></p>
    <p><button type="button" onClick={() => choose("mobile")}>Mobile — タッチで執筆</button></p>
  </section>;
}
