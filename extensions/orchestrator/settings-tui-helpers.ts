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

// ── Secret detection & masking ──────────────────────────────────────

const SECRET_KEY_PATTERN = /token|secret|password|auth/i;

/** Return true when a key or its env var looks like a secret that should be masked. */
export function isSecretSettingKey(key: string, def?: SettingsKeyDef): boolean {
  return SECRET_KEY_PATTERN.test(key) || (typeof def?.env === "string" && SECRET_KEY_PATTERN.test(def.env));
}

/** Mask secret-like string values while leaving non-secret values untouched. */
export function maskSettingValue(key: string, value: unknown, def?: SettingsKeyDef): unknown {
  if (def?.type === "string" && isSecretSettingKey(key, def) && typeof value === "string" && value !== "") {
    return value.length > 4 ? "••••" + value.slice(-4) : "••••••••";
  }
  return value;
}

const INLINE_CREDENTIAL_RULES: ReadonlyArray<[RegExp, string]> = [
  // Embedded URL credentials: scheme://user:<redacted>@host
  [/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s:@]+:)([^/\s@]+)(@)/g, "$1[REDACTED]$3"],
  // Authorization headers / bearer / basic tokens
  [/(\b(?:Bearer|Basic|Token)\s+)([A-Za-z0-9._~+/=-]{6,})/gi, "$1[REDACTED]"],
  // Well-known API key / PAT prefixes
  [/\b(?:ghp|gho|ghu|ghs|ghr|glpat|npm)_[A-Za-z0-9_]{8,}\b/g, "[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{12,}\b/g, "[REDACTED]"],
  [/\b(?:sk-[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g, "[REDACTED]"],
  // Env / query / key=value credential assignments
  [/(\b[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|AUTH|CREDENTIAL)[A-Za-z0-9_]*=)(?:'[^']*'|"[^"]*"|[^\s;&|'"]+)/gi, "$1[REDACTED]"],
  // CLI flags like --token value / --password=value / -p=...
  [/(--?(?:token|password|passwd|secret|api-key|apikey|auth)(?:=|\s+))(?:'[^']*'|"[^"]*"|[^\s;&|'"]+)/gi, "$1[REDACTED]"],
  // curl -u user:pass
  [/(\s-u\s+[^\s:'"]+:)(?:'[^']*'|"[^"]*"|[^\s;&|'"]+)/g, "$1[REDACTED]"],
];

/** Redact inline credentials from command patterns or free-text values before returning to the LLM. */
export function redactInlineCredentials(text: string): string {
  let out = text;
  for (const [pattern, replacement] of INLINE_CREDENTIAL_RULES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Sanitize a setting value for model-visible tool output:
 * - masks secret-named string keys completely
 * - redacts inline credentials inside strings, string arrays (e.g. dangerous_command_allowlist),
 *   and nested object values (e.g. tool_permissions, agent_overrides)
 * Persistence paths must never pass their write payloads through this function.
 */
export function sanitizeSettingValueForModel(key: string, value: unknown, def?: SettingsKeyDef): unknown {
  if (def?.type === "string" && isSecretSettingKey(key, def)) {
    return maskSettingValue(key, value, def);
  }
  if (typeof value === "string") {
    return redactInlineCredentials(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) =>
      typeof entry === "string" ? redactInlineCredentials(entry) : sanitizeSettingValueForModel(key, entry),
    );
  }
  if (value !== null && typeof value === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      sanitized[k] = sanitizeSettingValueForModel(k, v);
    }
    return sanitized;
  }
  return value;
}

/** Return the schema category label for a setting key. */
export function getCategoryLabelForKey(key: string): string {
  return SETTINGS_KEYS[key]?.group || "Other";
}

/** Compute the visible slice `[start, end)` of a scrollable category sidebar. */
export function computeSidebarWindow(
  total: number,
  selectedIndex: number,
  maxVisible: number,
): { start: number; end: number } {
  if (total <= 0 || maxVisible <= 0) return { start: 0, end: 0 };
  if (total <= maxVisible) return { start: 0, end: total };
  const clamped = Math.max(0, Math.min(total - 1, selectedIndex));
  const half = Math.floor(maxVisible / 2);
  const start = Math.max(0, Math.min(clamped - half, total - maxVisible));
  return { start, end: Math.min(total, start + maxVisible) };
}

/** Cross-category search matcher over setting keys, category names, and descriptions. */
export function filterSettingsAcrossCategories<T extends { id: string; description?: string }>(
  items: readonly T[],
  query: string,
  getCategoryLabel: (id: string) => string = getCategoryLabelForKey,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];

  const exactId: T[] = [];
  const prefixOrWordId: T[] = [];
  const substringMatch: T[] = [];
  const fuzzyMatch: T[] = [];

  for (const item of items) {
    const idLower = item.id.toLowerCase();
    const catLower = getCategoryLabel(item.id).toLowerCase();
    const descLower = (item.description || "").toLowerCase();

    if (idLower === q || catLower === q) {
      exactId.push(item);
    } else if (idLower.startsWith(q) || idLower.includes(`_${q}`) || catLower.startsWith(q)) {
      prefixOrWordId.push(item);
    } else if (idLower.includes(q) || catLower.includes(q) || descLower.includes(q)) {
      substringMatch.push(item);
    } else {
      // Subsequence fuzzy fallback on key + category
      const hay = `${idLower} ${catLower}`;
      let qi = 0;
      for (let hi = 0; hi < hay.length && qi < q.length; hi++) {
        if (hay[hi] === q[qi]) qi++;
      }
      if (qi === q.length) fuzzyMatch.push(item);
    }
  }

  return [...exactId, ...prefixOrWordId, ...substringMatch, ...fuzzyMatch];
}

// ── Value formatting ────────────────────────────────────────────────

export function formatValue(key: string, value: unknown, def: SettingsKeyDef): string {
  if (value === undefined || value === null) return String(def.default);

  // Mask secret-like keys
  if (def.type === "string" && isSecretSettingKey(key, def) && typeof value === "string" && value !== "") {
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
    case "lsp_servers":
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        const entries = Object.entries(value);
        return entries.length > 0 ? `${entries.length} server(s)` : "(none)";
      }
      return "(none)";
    case "tool_permissions":
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        const entries = Object.entries(value);
        return entries.length > 0 ? `${entries.length} rule(s)` : "(none)";
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
};

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

/** Registry provider used to filter the model picker for a settings key. */
export function resolveModelPickerProvider(
  key: string,
  paired: ModelPickerPairedSettings = {},
): string | undefined {
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
    if (qualified.length > 0) {
      qualified.unshift({
        value: "",
        label: "(inherit session model)",
        description: "Use the active session model",
      });
    }
    log.debug("resolveModelPickerItems advisor_model", { count: qualified.length });
    return qualified;
  }
  const filtered = filterModelsByProvider(allModels, provider);
  const result = filtered.length > 0 ? filtered : allModels;
  log.debug("resolveModelPickerItems", { key, provider, count: result.length });
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
  if (key === "advisor_model" && models.length === 0) {
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
