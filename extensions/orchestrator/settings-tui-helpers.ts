/**
 * Settings TUI presentation & picker helpers — pure functions with no
 * pi-coding-agent or pi-tui dependencies.
 *
 * Persistence, validation, source detection, and caching live in `project-settings.ts`.
 */

import {
  EMPTY_VALUE_SENTINEL,
  SETTINGS_KEYS,
  getFilePathForScope,
  isImageGenModelId,
  parseSettingInput,
  readSettingsFile,
  type SettingsKeyDef,
} from "./project-settings.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("settings_tui");

export { EMPTY_VALUE_SENTINEL };

// ── Category grouping ───────────────────────────────────────────────

export interface CategoryDef {
  label: string;
  keys: string[];
}

// Build CATEGORIES dynamically from schema `group` field.
// Preserves insertion order from settings-keys.json — groups appear
// in the order their first key is declared.
export const CATEGORIES: CategoryDef[] = (() => {
  const groupMap = new Map<string, string[]>();
  for (const [key, def] of Object.entries(SETTINGS_KEYS)) {
    const group = def.group || "Other";
    if (!groupMap.has(group)) groupMap.set(group, []);
    groupMap.get(group)!.push(key);
  }
  return [...groupMap.entries()].map(([label, keys]) => ({ label, keys }));
})();

// ── Value formatting ────────────────────────────────────────────────

export function formatValue(key: string, value: unknown, def: SettingsKeyDef): string {
  if (value === undefined || value === null) return String(def.default);

  // Mask secret-like keys
  const SECRET_PATTERNS = /token|secret|password|auth/i;
  const looksSecret = SECRET_PATTERNS.test(key) || (typeof def.env === "string" && SECRET_PATTERNS.test(def.env));
  if (def.type === "string" && looksSecret && typeof value === "string" && value !== "") {
    return value.length > 4 ? "••••" + value.slice(-4) : "••••••••";
  }

  switch (def.type) {
    case "bool":
    case "bool_enable":
      return value ? "true" : "false";
    case "bool_or_string":
      if (typeof value === "boolean") return value ? "true" : "false";
      return String(value);
    case "int":
    case "port":
    case "number":
      return String(value);
    case "string":
      return value === "" ? EMPTY_VALUE_SENTINEL : String(value);
    case "string_list":
      if (Array.isArray(value)) return value.length > 0 ? `${value.length} pattern(s)` : EMPTY_VALUE_SENTINEL;
      return String(value);
    case "agent_overrides":
      if (typeof value === "object" && value !== null) {
        const entries = Object.entries(value);
        return entries.length > 0 ? `${entries.length} override(s)` : "(none)";
      }
      return "(none)";
    default:
      return String(value);
  }
}

// ── Thin TUI string parser delegating to unified schema validator ───

export function parseRawValue(key: string, rawValue: string, _def?: SettingsKeyDef): unknown {
  const parsed = parseSettingInput(key, rawValue);
  if (!parsed.ok) {
    log.debug("parseRawValue rejected invalid input", { key, error: parsed.error });
    return undefined;
  }
  return parsed.value;
}

// ── Secret submit guard (extracted for testability) ─────────────────

/** Check if a secret input should be treated as "no change" (cancel). */
export function isSecretNoChange(val: string | undefined, scopeHasValue: boolean): boolean {
  if (scopeHasValue) return false; // value exists in scope — user is editing, not creating
  return val === undefined || val?.trim() === "" || val?.trim() === EMPTY_VALUE_SENTINEL;
}

/** Resolve the prefill value for a secret key from the current scope's file only. */
export function resolveSecretPrefill(
  key: string,
  editScope: "project" | "global",
  cwd: string,
  preloadedScopeData?: Record<string, unknown> | null,
): { scopeValue: string | null; prefill: string; hint: string } {
  const scopeData = preloadedScopeData !== undefined
    ? preloadedScopeData
    : readSettingsFile(getFilePathForScope(editScope, cwd));
  const scopeValue = scopeData && typeof scopeData[key] === "string" ? (scopeData[key] as string) : null;
  // Never prefill with the raw secret — always start empty to avoid exposing it on screen.
  const prefill = "";
  const hint = scopeValue !== null
    ? "Value set in this scope — enter new value or empty to clear"
    : "Enter new value (not set in this scope)";
  return { scopeValue, prefill, hint };
}

// ── Provider-filtered model items ───────────────────────────────────

export type ModelSelectItem = {
  value: string;
  label: string;
  description?: string;
  /** Registry input modalities when present (vision ≠ image generation). */
  input?: string[];
  /** Registry output modalities when present (`image` = image-generation capable). */
  output?: string[];
};

/** Image-gen picker: prefer `output` includes `image`; else id pattern. Not `input` (vision). */
export function isImageCapablePickerItem(item: ModelSelectItem): boolean {
  if (Array.isArray(item.output) && item.output.includes("image")) {
    log.debug("isImageCapablePickerItem", { id: item.value, via: "output" });
    return true;
  }
  return isImageGenModelId(item.value);
}

export type ModelPickerPairedSettings = {
  agent_provider?: string;
  internal_operations_provider?: string;
};

/** Filter model SelectItems by provider. Returns all models if provider is empty/undefined. */
export function filterModelsByProvider(
  allModels: ModelSelectItem[],
  provider?: string,
): ModelSelectItem[] {
  if (!provider) return allModels;
  return allModels.filter((m) => m.description === provider);
}

/** Registry provider hardwired for image_model picker (no image_provider setting). */
export const IMAGE_MODEL_PROVIDER = "google";

/**
 * Registry provider used to filter the model picker for a settings key.
 * image_model is hardwired to IMAGE_MODEL_PROVIDER (no image_provider setting).
 */
export function resolveModelPickerProvider(
  key: string,
  paired: ModelPickerPairedSettings = {},
): string | undefined {
  if (key === "image_model") {
    log.debug("resolveModelPickerProvider", { key, provider: IMAGE_MODEL_PROVIDER });
    return IMAGE_MODEL_PROVIDER;
  }
  if (key === "agent_model") {
    const p = paired.agent_provider?.trim();
    log.debug("resolveModelPickerProvider", { key, provider: p || undefined });
    return p || undefined;
  }
  if (key === "internal_operations_model") {
    const p = paired.internal_operations_provider?.trim();
    log.debug("resolveModelPickerProvider", { key, provider: p || undefined });
    return p || undefined;
  }
  log.debug("resolveModelPickerProvider", { key, provider: undefined });
  return undefined;
}

/**
 * Models shown in the settings TUI picker for a key.
 * image_model: IMAGE_MODEL_PROVIDER + image-capable only — never falls back to all providers.
 * advisor_model: formats items as explicit `provider/model-id` pairs across all providers,
 *   with a leading empty option to inherit the session model.
 * agent_model / internal_operations_model: fall back to all models when filter is empty.
 */
export function resolveModelPickerItems(
  key: string,
  allModels: ModelSelectItem[],
  provider?: string,
  currentValue?: string,
): ModelSelectItem[] {
  if (key === "advisor_model") {
    const normalizedCurrent =
      currentValue === undefined || currentValue === EMPTY_VALUE_SENTINEL ? "" : currentValue.trim();
    const qualified: ModelSelectItem[] = [];
    const seen = new Set<string>();
    for (const m of allModels) {
      const prov = m.description?.trim();
      const id = m.value?.trim();
      if (!prov || !id) continue;
      const ref = `${prov}/${id}`;
      if (seen.has(ref)) continue;
      seen.add(ref);
      qualified.push({ value: ref, label: ref, description: prov });
    }
    if (normalizedCurrent !== "" && !seen.has(normalizedCurrent)) {
      qualified.push({
        value: normalizedCurrent,
        label: normalizedCurrent,
        description: "configured",
      });
    }
    qualified.sort((a, b) => a.value.localeCompare(b.value));
    if (qualified.length > 0 && normalizedCurrent === "") {
      qualified.unshift({
        value: "",
        label: "(inherit session model)",
        description: "Use the active session model",
      });
    }
    log.debug("resolveModelPickerItems advisor_model", { count: qualified.length });
    return qualified;
  }
  const effectiveProvider = key === "image_model" ? IMAGE_MODEL_PROVIDER : provider;
  const filtered = filterModelsByProvider(allModels, effectiveProvider);
  if (key === "image_model") {
    const imageCapable = filtered.filter(isImageCapablePickerItem);
    log.debug("resolveModelPickerItems image_model", {
      googleCount: filtered.length,
      imageCapableCount: imageCapable.length,
    });
    return imageCapable;
  }
  const result = filtered.length > 0 ? filtered : allModels;
  log.debug("resolveModelPickerItems", { key, provider: effectiveProvider, count: result.length });
  return result;
}

export type ModelKeySubmenu =
  | { mode: "picker"; models: ModelSelectItem[]; provider?: string }
  | { mode: "input"; provider?: string };

export function resolveModelKeySubmenu(
  key: string,
  allModels: ModelSelectItem[],
  paired: ModelPickerPairedSettings = {},
  currentValue?: string,
): ModelKeySubmenu {
  const provider = resolveModelPickerProvider(key, paired);
  const models = resolveModelPickerItems(key, allModels, provider, currentValue);
  if ((key === "image_model" || key === "advisor_model") && models.length === 0) {
    log.debug("resolveModelKeySubmenu", { key, mode: "input", provider });
    return { mode: "input", provider };
  }
  log.debug("resolveModelKeySubmenu", { key, mode: "picker", count: models.length, provider });
  return { mode: "picker", models, provider };
}

// ── Source glyph (colored) ──────────────────────────────────────────

export function sourceGlyph(
  source: string,
  theme: { fg: (color: "success" | "accent" | "warning" | "dim", text: string) => string },
): string {
  switch (source) {
    case "P": return theme.fg("success", "P");
    case "G": return theme.fg("accent", "G");
    case "E": return theme.fg("warning", "E");
    case "D": return theme.fg("dim", "D");
    default:  return theme.fg("dim", "?");
  }
}

// ── Registration helper (testable without pi-coding-agent) ──────────

export function registerSettingsTuiCommand(
  pi: { registerCommand: (name: string, opts: { description: string; handler: (...args: any[]) => any }) => void },
  handler: (args: string, ctx: any) => Promise<void>,
): void {
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

  pi.registerCommand("pi-config-settings", {
    description: "Interactive settings editor for pi-config",
    handler,
  });
}
