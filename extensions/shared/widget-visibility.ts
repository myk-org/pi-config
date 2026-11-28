/**
 * Shared widget collapse/expand state, shortcut validation/registration, and toggle-all bridge.
 *
 * State lives on `globalThis[WIDGET_VISIBILITY_SYMBOL]` keyed by resolved project root so active
 * display modes survive `/reload` within a project without leaking across projects, and stay
 * consistent across separately loaded extension bundles (`pitasks`, `coms`, `orchestrator`).
 *
 * Widgets always keep their 1-line header visible (never hidden to 0 lines) so users always
 * see the widget exists along with its `[<key> collapse]` / `[<key> expand]` hint.
 */

import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type KeyId } from "@earendil-works/pi-tui";
import { getSetting } from "../orchestrator/project-settings.js";
import { resolveRepoRoot } from "../orchestrator/utils.js";
import { createLogger } from "./logger.js";

const log = createLogger("widget-visibility");

export type WidgetId = "tasks" | "coms";
export type WidgetMode = "expanded" | "collapsed";
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
  cwd?: string;
}

export interface WidgetModeChangedEvent {
  widget: WidgetId;
  mode: WidgetMode;
  cwd?: string;
}

interface ProjectWidgetBucket {
  modes: Partial<Record<WidgetId, WidgetMode>>;
  toggleAllSnapshot: Record<WidgetId, WidgetMode> | null;
}

interface WidgetVisibilityStore {
  projects: Record<string, ProjectWidgetBucket>;
  /** Accepted shortcut bindings returned by `registerWidgetShortcut` (never unaccepted keys). */
  registeredShortcuts: Partial<Record<WidgetShortcutSettingKey, KeyId | null>>;
  /** Deduplication keys for invalid-setting warnings so repaints never flood logs. */
  warnedKeys: Set<string>;
}

function getStore(): WidgetVisibilityStore {
  const g = globalThis as Record<symbol, unknown>;
  let store = g[WIDGET_VISIBILITY_SYMBOL] as WidgetVisibilityStore | undefined;
  if (!store || typeof store !== "object" || !store.projects) {
    store = {
      projects: {},
      registeredShortcuts: {},
      warnedKeys: new Set<string>(),
    };
    g[WIDGET_VISIBILITY_SYMBOL] = store;
  } else {
    if (!store.registeredShortcuts) store.registeredShortcuts = {};
    if (!(store.warnedKeys instanceof Set)) store.warnedKeys = new Set<string>();
  }
  return store;
}

function warnOnce(dedupeKey: string, event: string, data: Record<string, unknown>): void {
  const store = getStore();
  if (store.warnedKeys.has(dedupeKey)) return;
  store.warnedKeys.add(dedupeKey);
  log.warn(event, data);
}

function resolveProjectKey(cwd?: string): string {
  const effective = cwd || process.cwd();
  try {
    return resolve(resolveRepoRoot(effective));
  } catch {
    return resolve(effective);
  }
}

function getProjectBucket(cwd?: string): ProjectWidgetBucket {
  const store = getStore();
  const key = resolveProjectKey(cwd);
  let bucket = store.projects[key];
  if (!bucket) {
    bucket = { modes: {}, toggleAllSnapshot: null };
    store.projects[key] = bucket;
  }
  return bucket;
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
    const value = String(raw);
    warnOnce(`invalid_widget_mode:${value}`, "invalid_widget_mode", { value, fallback });
  }
  return fallback;
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
    const msg = err instanceof Error ? err.message : String(err);
    warnOnce(`widget_default_mode_read_failed:${msg}`, "widget_default_mode_read_failed", { error: msg });
    return "expanded";
  }
}

export function getWidgetMode(id: WidgetId, cwd?: string): WidgetMode {
  const bucket = getProjectBucket(cwd);
  return bucket.modes[id] ?? getDefaultWidgetMode(cwd);
}

export function setWidgetMode(id: WidgetId, mode: WidgetMode, cwd?: string): WidgetMode {
  const bucket = getProjectBucket(cwd);
  bucket.modes[id] = mode;
  // Manual change invalidates any pending toggle-all restore snapshot for this project.
  bucket.toggleAllSnapshot = null;
  log.debug("widget_mode_set", { id, mode });
  return mode;
}

export function cycleWidgetMode(id: WidgetId, cwd?: string): WidgetMode {
  const current = getWidgetMode(id, cwd);
  const next = nextWidgetMode(current);
  return setWidgetMode(id, next, cwd);
}

/**
 * Toggle both widgets together (`widget_all_shortcut`) for the given project:
 * - If either widget is `expanded`, save their modes and collapse both.
 * - On second press (both collapsed with saved snapshot), restore the previous modes.
 * - If both are already collapsed with no saved snapshot, expand both.
 */
export function toggleAllWidgets(cwd?: string): Record<WidgetId, WidgetMode> {
  const bucket = getProjectBucket(cwd);
  const tasks = getWidgetMode("tasks", cwd);
  const coms = getWidgetMode("coms", cwd);

  if (tasks === "expanded" || coms === "expanded") {
    bucket.toggleAllSnapshot = { tasks, coms };
    bucket.modes.tasks = "collapsed";
    bucket.modes.coms = "collapsed";
    log.debug("widget_toggle_all_collapsed", { previous: bucket.toggleAllSnapshot });
    return { tasks: "collapsed", coms: "collapsed" };
  }

  if (bucket.toggleAllSnapshot) {
    const restored: Record<WidgetId, WidgetMode> = {
      tasks: bucket.toggleAllSnapshot.tasks,
      coms: bucket.toggleAllSnapshot.coms,
    };
    bucket.modes.tasks = restored.tasks;
    bucket.modes.coms = restored.coms;
    bucket.toggleAllSnapshot = null;
    log.debug("widget_toggle_all_restored", { restored });
    return restored;
  }

  bucket.modes.tasks = "expanded";
  bucket.modes.coms = "expanded";
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
    const msg = err instanceof Error ? err.message : String(err);
    warnOnce(`widget_shortcut_read_failed:${settingKey}:${msg}`, "widget_shortcut_setting_read_failed", {
      settingKey,
      error: msg,
    });
    return null;
  }
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return null;
  const normalized = normalizeShortcut(trimmed);
  if (!normalized) {
    warnOnce(`invalid_widget_shortcut:${settingKey}:${trimmed}`, "invalid_widget_shortcut", {
      settingKey,
      value: trimmed,
    });
    return null;
  }
  return normalized;
}

/** Return the shortcut key actually bound by `registerWidgetShortcut` (never an unbound setting). */
export function getRegisteredWidgetShortcut(settingKey: WidgetShortcutSettingKey): KeyId | null {
  const store = getStore();
  return store.registeredShortcuts[settingKey] ?? null;
}

/**
 * Register a configurable widget shortcut on `pi` if configured and valid.
 * Records the accepted binding (or `null` if disabled/invalid/rejected) in the shared store
 * so widget headers only ever advertise a key that is actually bound.
 */
export function registerWidgetShortcut(
  pi: ExtensionAPI,
  settingKey: WidgetShortcutSettingKey,
  cwd: string,
  description: string,
  handler: (ctx: ExtensionContext) => Promise<void> | void,
): KeyId | null {
  const store = getStore();
  const key = getConfiguredShortcut(cwd, settingKey);
  if (!key) {
    store.registeredShortcuts[settingKey] = null;
    log.debug("widget_shortcut_disabled", { settingKey });
    return null;
  }
  try {
    pi.registerShortcut(key, { description, handler });
    store.registeredShortcuts[settingKey] = key;
    log.debug("widget_shortcut_registered", { settingKey, key });
    return key;
  } catch (err: unknown) {
    store.registeredShortcuts[settingKey] = null;
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
  const nameVisLen = identity ? visibleWidth(identity.name) + visibleWidth(pendingSuffix) : 0;
  const rightTagVisLen = identity ? nameVisLen + 3 : 0;

  const hintLabel = formatWidgetShortcutHint(shortcutHint, mode);
  const hintVisLen = hintLabel ? visibleWidth(hintLabel) + 1 : 0;

  const hasCounts = peerCount !== undefined && busyCount !== undefined;
  const peerPlain = hasCounts ? `${peerCount} ${peerCount === 1 ? "peer" : "peers"}` : "";
  const busyPlain = hasCounts ? `(${busyCount} busy)` : "";
  const countsPlain = hasCounts ? `· ${peerPlain} ${busyPlain} ` : "";
  const countsVisLen = visibleWidth(countsPlain);
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

  // Try progressively narrower combinations while keeping exact safeWidth column alignment:
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
        return truncateToWidth(
          left + hintPart + countsPart + leftFill + middle + buildRightTag() + theme.fg("dim", "┓"),
          safeWidth,
        );
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
