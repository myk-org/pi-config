/**
 * Light/dark theme — a switcher over the EXISTING token layer, not a second
 * stylesheet. `styles.css` already defines both palettes (`:root` is light,
 * `.dark` overrides it), and every component styles itself through those
 * variables, so flipping one class on <html> restyles the whole app.
 *
 * Dark stays the default: `index.html` ships `class="dark"` so the first paint
 * is already dark, and this module only overrides it when the user chose light.
 */

export type Theme = "dark" | "light";

const STORAGE_KEY = "pidash-theme";

export function loadTheme(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/** Apply a theme to the document (idempotent, safe before first render). */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  // Keep form controls, scrollbars and the browser's own chrome in step.
  root.style.colorScheme = theme;
}

export function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Private mode / blocked storage: the theme still applies for this page.
  }
}

export function setTheme(theme: Theme): void {
  applyTheme(theme);
  saveTheme(theme);
}
