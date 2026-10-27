/**
 * Light/dark theme — a switcher over the EXISTING token layer, not a second
 * stylesheet. `styles.css` already defines both palettes (`:root` is light,
 * `.dark` overrides it), and every component styles itself through those
 * variables, so flipping one class on <html> restyles the whole app.
 *
 * Dark stays the default: `index.html` ships `class="dark"` so the first paint
 * is already dark, and this module only overrides it when the user chose light.
 */

import { createLogger } from "@/lib/create-logger";

const log = createLogger("Theme");

export type Theme = "dark" | "light";

const STORAGE_KEY = "pidash-theme";

export function loadTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    const theme: Theme = stored === "light" ? "light" : "dark";
    log.debug("theme loaded", { stored, theme });
    return theme;
  } catch (error) {
    log.warn("theme storage unavailable, defaulting to dark", { error: String(error) });
    return "dark";
  }
}

/** Apply a theme to the document (idempotent, safe before first render). */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  log.debug("theme applied", { theme });
  root.classList.toggle("dark", theme === "dark");
  // Keep form controls, scrollbars and the browser's own chrome in step.
  root.style.colorScheme = theme;
}

export function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
    log.debug("theme persisted", { theme });
  } catch (error) {
    log.warn("theme could not be persisted", { theme, error: String(error) });
    // Private mode / blocked storage: the theme still applies for this page.
  }
}

export function setTheme(theme: Theme): void {
  applyTheme(theme);
  saveTheme(theme);
}
