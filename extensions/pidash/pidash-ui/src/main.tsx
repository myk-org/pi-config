import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyTheme, loadTheme } from "./lib/theme";
import { createLogger } from "./lib/create-logger";
import "./styles.css";

// Before paint: index.html ships class="dark", so this only has to undo it for
// users who chose light — no stylesheet duplication, no flash of the wrong theme.
const log = createLogger("Bootstrap");
const bootTheme = loadTheme();
applyTheme(bootTheme);
log.info("pidash ui booting", { theme: bootTheme });

createRoot(document.getElementById("root")!).render(<App />);
