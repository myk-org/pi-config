import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyTheme, loadTheme } from "./lib/theme";
import "./styles.css";

// Before paint: index.html ships class="dark", so this only has to undo it for
// users who chose light — no stylesheet duplication, no flash of the wrong theme.
applyTheme(loadTheme());

createRoot(document.getElementById("root")!).render(<App />);
