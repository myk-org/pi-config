/**
 * Shared widget collapse/expand state, shortcut validation/registration, and toggle-all bridge.
 *
 * State lives on `globalThis[WIDGET_VISIBILITY_SYMBOL]` so active display modes survive
 * `/reload` and stay consistent across separately loaded extension bundles (`pitasks`,
 * `coms`, `orchestrator`).
 *
 * Widgets always keep their 1-line header visible (never hidden to 0 lines) so users always
 * see the widget exists along with its `[<key> collapse]` / `[<key> expand]` hint.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type KeyId } from "@earendil-works/pi-tui";
import { getSetting } from "../orchestrator/project-settings.js";
import { createLogger } from "./logger.js";

const log = createLogger("widget-visibility");

export type WidgetId = "tasks" | "coms";
export type WidgetMode = "expanded" | "collapsed";
export type WidgetCommandAction = WidgetMode | "toggle";
export type WidgetShortcutSettingKey =
  | "widget_tasks_shortcut"
  | "widget_coms_shortcut"
  | "widget_all_shortcut";

export const WIDGET_MODE_ORDER: readonly WidgetMode[] = ["expanded", "collapsed"];
export const TOGGLE_ALL_WIDGETS_EVENT = "ui:toggle-all-widgets";
export const WIDGET_MODE_CHANGED_EVENT = "ui:widget-mode-changed";
export const WIDGET_VISIBILITY_SYMBOL = Symbol.for("pi-config.widgetVisibility");

export interface ToggleAllWidgetsEvent {
  modes: Record<WidgetId, WidgetMode>;
}

export interface WidgetModeChangedEvent {
  widget: WidgetId;
  mode: WidgetMode;
}

interface WidgetVisibilityStore {
  modes: Partial<Record<WidgetId, WidgetMode>>;
  toggleAllSnapshot: Record<WidgetId, WidgetMode> | null;
}

function getStore(): WidgetVisibilityStore {
  const g = globalThis as Record<symbol, unknown>;
  let store = g[WIDGET_VISIBILITY_SYMBOL] as WidgetVisibilityStore | undefined;
  if (!store || typeof store !== "object" || !store.modes) {
    store = { modes: {}, toggleAllSnapshot: null };
    g[WIDGET_VISIBILITY_SYMBOL] = store;
  }
  return store;
}

/** Reset persisted widget visibility state (for tests). */
export function resetWidgetVisibilityState(): void {
  const g = globalThis as Record<symbol, unknown>;
  delete g[WIDGET_VISIBILITY_SYMBOL];
}

export function nextWidgetMode(current: WidgetMode): WidgetMode {
  return current === "expanded" ? "collapsed" : "expanded";
}

/**
 * Normalize a configured/stored mode string to `"expanded" | "collapsed"`.
 * Accepts friendly/legacy aliases (`show`/`expand` → `expanded`, `compact`/`hide`/`hidden` → `collapsed`).
 */
export function normalizeWidgetMode(raw: unknown, fallback: WidgetMode = "expanded"): WidgetMode {
  if (typeof raw === "string") {
    const lower = raw.trim().toLowerCase();
    if (lower === "expanded" || lower === "expand" || lower === "show") return "expanded";
    if (lower === "collapsed" || lower === "collapse" || lower === "compact" || lower === "hide" || lower === "hidden") {
      return "collapsed";
    }
  }
  if (raw !== undefined && raw !== null && raw !== "") {
    log.warn("invalid_widget_mode", { value: String(raw), fallback });
  }
  return fallback;
}

/** Parse `/tasks widget [expand|collapse|toggle]` or `/coms widget [...]` arg (plus show/hide aliases). */
export function parseWidgetCommandAction(raw: string | undefined): WidgetCommandAction | null {
  if (raw === undefined || raw.trim() === "") return "toggle";
  const lower = raw.trim().toLowerCase();
  if (lower === "toggle" || lower === "cycle") return "toggle";
  if (lower === "expand" || lower === "expanded" || lower === "show") return "expanded";
  if (lower === "collapse" || lower === "collapsed" || lower === "compact" || lower === "hide" || lower === "hidden") {
    return "collapsed";
  }
  return null;
}

/** Format the header shortcut badge: `[<key> collapse]` when expanded, `[<key> expand]` when collapsed. */
export function formatWidgetShortcutHint(shortcutHint: string | null, mode: WidgetMode): string {
  if (!shortcutHint) return "";
  return `[${shortcutHint} ${mode === "expanded" ? "collapse" : "expand"}]`;
}

export function getDefaultWidgetMode(cwd?: string): WidgetMode {
  try {
    const raw = getSetting(cwd || process.cwd(), "widgets_default_mode");
    return normalizeWidgetMode(raw, "expanded");
  } catch (err: unknown) {
    log.warn("widget_default_mode_read_failed", { error: err instanceof Error ? err.message : String(err) });
    return "expanded";
  }
}

export function getWidgetMode(id: WidgetId, cwd?: string): WidgetMode {
  const store = getStore();
  return store.modes[id] ?? getDefaultWidgetMode(cwd);
}

export function setWidgetMode(id: WidgetId, mode: WidgetMode): WidgetMode {
  const store = getStore();
  store.modes[id] = mode;
  // Manual change invalidates any pending toggle-all restore snapshot.
  store.toggleAllSnapshot = null;
  log.debug("widget_mode_set", { id, mode });
  return mode;
}

export function cycleWidgetMode(id: WidgetId, cwd?: string): WidgetMode {
  const current = getWidgetMode(id, cwd);
  const next = nextWidgetMode(current);
  return setWidgetMode(id, next);
}

export function applyWidgetAction(id: WidgetId, action: WidgetCommandAction, cwd?: string): WidgetMode {
  return action === "toggle" ? cycleWidgetMode(id, cwd) : setWidgetMode(id, action);
}

/**
 * Toggle both widgets together (`widget_all_shortcut`):
 * - If either widget is `expanded`, save their modes and collapse both.
 * - On second press (both collapsed with saved snapshot), restore the previous modes.
 * - If both are already collapsed with no saved snapshot, expand both.
 */
export function toggleAllWidgets(cwd?: string): Record<WidgetId, WidgetMode> {
  const store = getStore();
  const tasks = getWidgetMode("tasks", cwd);
  const coms = getWidgetMode("coms", cwd);

  if (tasks === "expanded" || coms === "expanded") {
    store.toggleAllSnapshot = { tasks, coms };
    store.modes.tasks = "collapsed";
    store.modes.coms = "collapsed";
    log.debug("widget_toggle_all_collapsed", { previous: store.toggleAllSnapshot });
    return { tasks: "collapsed", coms: "collapsed" };
  }

  if (store.toggleAllSnapshot) {
    const restored: Record<WidgetId, WidgetMode> = {
      tasks: store.toggleAllSnapshot.tasks,
      coms: store.toggleAllSnapshot.coms,
    };
    store.modes.tasks = restored.tasks;
    store.modes.coms = restored.coms;
    store.toggleAllSnapshot = null;
    log.debug("widget_toggle_all_restored", { restored });
    return restored;
  }

  store.modes.tasks = "expanded";
  store.modes.coms = "expanded";
  log.debug("widget_toggle_all_expanded", {});
  return { tasks: "expanded", coms: "expanded" };
}

// ── Shortcut validation & registration ───────────────────────────────────

const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);
const SPECIAL_KEYS = new Map<string, string>([
  ["escape", "escape"],
  ["esc", "esc"],
  ["enter", "enter"],
  ["return", "return"],
  ["tab", "tab"],
  ["space", "space"],
  ["backspace", "backspace"],
  ["delete", "delete"],
  ["insert", "insert"],
  ["clear", "clear"],
  ["home", "home"],
  ["end", "end"],
  ["pageup", "pageUp"],
  ["pagedown", "pageDown"],
  ["up", "up"],
  ["down", "down"],
  ["left", "left"],
  ["right", "right"],
  ["f1", "f1"],
  ["f2", "f2"],
  ["f3", "f3"],
  ["f4", "f4"],
  ["f5", "f5"],
  ["f6", "f6"],
  ["f7", "f7"],
  ["f8", "f8"],
  ["f9", "f9"],
  ["f10", "f10"],
  ["f11", "f11"],
  ["f12", "f12"],
]);
const SYMBOL_KEYS = new Set(
  "`-=[]\\;',./!@#$%^&*()_+|~{}:<>?".split(""),
);

/**
 * Validate and normalize a shortcut string into Pi's `KeyId` format.
 * Empty/whitespace string or invalid syntax returns `null`.
 */
export function normalizeShortcut(raw: unknown): KeyId | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const mods: string[] = [];
  const seenMods = new Set<string>();
  let rest = trimmed;

  // Peel valid `modifier+` prefixes from the left so `ctrl++` preserves `+` as the base key.
  while (true) {
    const plusIdx = rest.indexOf("+");
    if (plusIdx <= 0) break;
    const candidate = rest.slice(0, plusIdx).toLowerCase();
    if (!MODIFIERS.has(candidate)) break;
    if (seenMods.has(candidate)) return null;
    seenMods.add(candidate);
    mods.push(candidate);
    rest = rest.slice(plusIdx + 1);
  }

  if (!rest) return null;

  let baseKey: string | null = null;
  const lowerRest = rest.toLowerCase();
  if (/^[a-z0-9]$/.test(lowerRest)) {
    baseKey = lowerRest;
  } else if (SPECIAL_KEYS.has(lowerRest)) {
    baseKey = SPECIAL_KEYS.get(lowerRest)!;
  } else if (rest.length === 1 && SYMBOL_KEYS.has(rest)) {
    baseKey = rest;
  }

  if (!baseKey) return null;
  return (mods.length > 0 ? `${mods.join("+")}+${baseKey}` : baseKey) as KeyId;
}

/** Read and validate a configured widget shortcut setting. Empty string disables quietly. */
export function getConfiguredShortcut(cwd: string, settingKey: WidgetShortcutSettingKey): KeyId | null {
  let raw: unknown;
  try {
    raw = getSetting(cwd || process.cwd(), settingKey);
  } catch (err: unknown) {
    log.warn("widget_shortcut_setting_read_failed", {
      settingKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return null;
  const normalized = normalizeShortcut(trimmed);
  if (!normalized) {
    log.warn("invalid_widget_shortcut", { settingKey, value: trimmed });
    return null;
  }
  return normalized;
}

/**
 * Register a configurable widget shortcut on `pi` if configured and valid.
 * Returns the normalized `KeyId` when registered, or `null` when disabled/invalid.
 */
export function registerWidgetShortcut(
  pi: ExtensionAPI,
  settingKey: WidgetShortcutSettingKey,
  cwd: string,
  description: string,
  handler: (ctx: ExtensionContext) => Promise<void> | void,
): KeyId | null {
  const key = getConfiguredShortcut(cwd, settingKey);
  if (!key) {
    log.debug("widget_shortcut_disabled", { settingKey });
    return null;
  }
  if (typeof (pi as { registerShortcut?: unknown }).registerShortcut !== "function") {
    log.debug("widget_shortcut_api_unavailable", { settingKey, key });
    return key;
  }
  try {
    pi.registerShortcut(key, { description, handler });
    log.debug("widget_shortcut_registered", { settingKey, key });
    return key;
  } catch (err: unknown) {
    log.warn("widget_shortcut_register_failed", {
      settingKey,
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ── Shared COMS header formatters (expanded top border + 1-line collapsed header) ─

export interface ComsTopBorderInput {
  width: number;
  identity?: { name: string; color: string } | null;
  pendingCount: number;
  shortcutHint: string | null;
  theme: Pick<Theme, "fg">;
  colorizeName?: (color: string, text: string) => string;
}

export interface ComsCollapsedHeaderInput extends ComsTopBorderInput {
  peerCount: number;
  busyCount: number;
}

function renderComsHeaderLine(
  input: ComsTopBorderInput & { mode: WidgetMode; peerCount?: number; busyCount?: number },
): string {
  const { width, identity, pendingCount, shortcutHint, theme, colorizeName, mode, peerCount, busyCount } = input;
  const safeWidth = Math.max(0, width);
  if (safeWidth < 12) return theme.fg("dim", "━".repeat(safeWidth));

  const left = theme.fg("dim", "┏━") + theme.fg("border", " coms ");
  const leftFill = theme.fg("dim", "━");
  const pendingSuffix = ` (${pendingCount} pending)`;
  const nameLen = identity ? identity.name.length + pendingSuffix.length : 0;
  const rightTagVisLen = identity ? nameLen + 3 : 0;

  const hintLabel = formatWidgetShortcutHint(shortcutHint, mode);
  const hintVisLen = hintLabel ? hintLabel.length + 1 : 0;

  const hasCounts = peerCount !== undefined && busyCount !== undefined;
  const peerPlain = hasCounts ? `${peerCount} ${peerCount === 1 ? "peer" : "peers"}` : "";
  const busyPlain = hasCounts ? `(${busyCount} busy)` : "";
  const countsPlain = hasCounts ? `· ${peerPlain} ${busyPlain} ` : "";
  const countsVisLen = countsPlain.length;
  const countsStyled = hasCounts
    ? theme.fg("dim", "· ") +
      theme.fg("accent", peerPlain) +
      " " +
      (busyCount! > 0 ? theme.fg("warning", busyPlain) : theme.fg("dim", busyPlain)) +
      " "
    : "";

  const buildRightTag = (): string => {
    if (!identity) return "";
    const pendingPart = pendingCount > 0 ? theme.fg("warning", pendingSuffix) : theme.fg("dim", pendingSuffix);
    const styledName = colorizeName ? colorizeName(identity.color, identity.name) : theme.fg("accent", identity.name);
    return theme.fg("dim", " ") + styledName + pendingPart + theme.fg("dim", " ━");
  };

  // Try progressively narrower combinations while keeping exact safeWidth alignment:
  // 1) hint + counts + identity, 2) counts + identity, 3) hint + identity, 4) identity only.
  if (identity) {
    const candidates: Array<{ showHint: boolean; showCounts: boolean }> = [
      { showHint: Boolean(hintLabel), showCounts: hasCounts },
      ...(hintLabel && hasCounts ? [{ showHint: false, showCounts: true }] : []),
      ...(hintLabel && hasCounts ? [{ showHint: true, showCounts: false }] : []),
      { showHint: false, showCounts: false },
    ];
    for (const c of candidates) {
      const extraLen = (c.showHint ? hintVisLen : 0) + (c.showCounts ? countsVisLen : 0);
      const remaining = safeWidth - 9 /* "┏━ coms ━" */ - extraLen - rightTagVisLen - 1 /* "┓" */;
      if (remaining >= 1) {
        const hintPart = c.showHint ? theme.fg("dim", `${hintLabel} `) : "";
        const countsPart = c.showCounts ? countsStyled : "";
        const middle = theme.fg("dim", "━".repeat(remaining));
        return left + hintPart + countsPart + leftFill + middle + buildRightTag() + theme.fg("dim", "┓");
      }
    }
  }

  // Fallback without identity tag (narrow terminal or no identity)
  const fallbackCandidates: Array<{ showHint: boolean; showCounts: boolean }> = [
    { showHint: Boolean(hintLabel), showCounts: hasCounts },
    ...(hintLabel && hasCounts ? [{ showHint: false, showCounts: true }] : []),
    ...(hintLabel ? [{ showHint: true, showCounts: false }] : []),
    { showHint: false, showCounts: false },
  ];
  for (const c of fallbackCandidates) {
    const extraLen = (c.showHint ? hintVisLen : 0) + (c.showCounts ? countsVisLen : 0);
    const fallbackRemaining = safeWidth - 2 /* "┏━" */ - 6 /* " coms " */ - extraLen - 1 /* "┓" */;
    if (fallbackRemaining >= 1 || (!c.showHint && !c.showCounts)) {
      const hintPart = c.showHint ? theme.fg("dim", `${hintLabel} `) : "";
      const countsPart = c.showCounts ? countsStyled : "";
      return truncateToWidth(
        left + hintPart + countsPart + theme.fg("dim", "━".repeat(Math.max(0, fallbackRemaining)) + "┓"),
        safeWidth,
      );
    }
  }
  return truncateToWidth(left + theme.fg("dim", "┓"), safeWidth);
}

/** Render the expanded COMS top border: `┏━ coms [<key> collapse] ━━━ <self> (Y pending) ━┓`. */
export function formatComsTopBorder(input: ComsTopBorderInput): string {
  return renderComsHeaderLine({ ...input, mode: "expanded" });
}

/** Render the 1-line collapsed COMS header: `┏━ coms [<key> expand] · N peers (X busy) ━━━ <self> (Y pending) ━┓`. */
export function formatComsCollapsedHeader(input: ComsCollapsedHeaderInput): string {
  return renderComsHeaderLine({ ...input, mode: "collapsed" });
}
