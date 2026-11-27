import { createLogger } from "./create-logger";
import type { SettingsKey } from "@/types";

const log = createLogger("settings-edit");

/** Parse a raw text draft into a typed setting value (#968 G settings page). */
export function parseTypedSetting(raw: string, def: SettingsKey): { value: unknown; error?: string } {
  const t = def.type;
  if (t === "bool" || t === "bool_enable" || t === "bool_or_string") {
    if (raw === "true") return { value: true };
    if (raw === "false") return { value: false };
    if (t === "bool_or_string") return { value: raw };
    return { value: null, error: "must be true/false" };
  }
  if (t === "int" || t === "number") {
    // Strict numeric syntax — parseInt("12abc") would silently save 12 for
    // input the user never intended as a number, and "1.5" is not an int
    // (Qodo R1).
    const pattern = t === "int" ? /^-?\d+$/ : /^-?\d+(\.\d+)?$/;
    if (!pattern.test(raw.trim())) return { value: null, error: "not a number" };
    const n = t === "int" ? Number.parseInt(raw, 10) : Number(raw);
    if (!Number.isFinite(n)) return { value: null, error: "not a number" };
    if (def.min !== undefined && n < def.min) return { value: null, error: `min ${def.min}` };
    if (def.max !== undefined && n > def.max) return { value: null, error: `max ${def.max}` };
    return { value: n };
  }
  if (t === "port") {
    if (!/^\d+$/.test(raw.trim())) {
      log.debug("port draft rejected — not a number", { raw: raw.slice(0, 20) });
      return { value: null, error: "not a number" };
    }
    const p = Number(raw);
    if (p < 1 || p > 65535) {
      log.debug("port draft rejected — out of range", { port: p });
      return { value: null, error: "must be 1-65535" };
    }
    return { value: p };
  }
  if (t === "string_list") {
    const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
    return { value: list };
  }
  if (t === "agent_overrides" || t === "lsp_servers" || t === "tool_permissions") {
    // Structured object settings must parse as a JSON object — sending raw
    // text would report a successful save while persisting an ignored string
    // (Qodo R1).
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return {
          value: null,
          error:
            t === "lsp_servers"
              ? 'must be a JSON object: {"id": {"command": "...", "extensions": [".ext"]}}'
              : t === "tool_permissions"
                ? 'must be a JSON object: {"fetch_content": {"*": "ask", "github.com": "allow"}}'
                : 'must be a JSON object: {"agent": {"model": "..."}}',
        };
      }
      return { value: parsed };
    } catch {
      return { value: null, error: "invalid JSON object" };
    }
  }
  if (def.enum?.length && !def.enum.includes(raw)) return { value: null, error: `must be one of: ${def.enum.join(", ")}` };
  return { value: raw };
}

/** Format a stored setting value for the editor input. */
export function displaySettingValue(v: unknown): string {
  if (v === undefined) return "";
  if (v === null) return "null";
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "object") return JSON.stringify(v, null, 2);
  return String(v);
}

export interface SettingsCategoryGroup {
  name: string;
  keys: SettingsKey[];
}

/** Group settings keys into sidebar categories while preserving schema order. */
export function buildSettingsCategories(keys: readonly SettingsKey[]): SettingsCategoryGroup[] {
  const byGroup = new Map<string, SettingsKey[]>();
  for (const k of keys) {
    const group = k.group || "Other";
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group)!.push(k);
  }
  return [...byGroup.entries()].map(([name, groupKeys]) => ({ name, keys: groupKeys }));
}

/** Cross-category search over key name, category/group label, and description. */
export function filterSettingsKeys(keys: readonly SettingsKey[], query: string): SettingsKey[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...keys];

  const exact: SettingsKey[] = [];
  const prefix: SettingsKey[] = [];
  const rest: SettingsKey[] = [];

  for (const k of keys) {
    const keyLower = k.key.toLowerCase();
    const groupLower = (k.group || "Other").toLowerCase();
    const descLower = (k.description || "").toLowerCase();
    if (keyLower === q || groupLower === q) {
      exact.push(k);
    } else if (keyLower.startsWith(q) || keyLower.includes(`_${q}`) || groupLower.startsWith(q)) {
      prefix.push(k);
    } else if (keyLower.includes(q) || groupLower.includes(q) || descLower.includes(q)) {
      rest.push(k);
    }
  }
  return [...exact, ...prefix, ...rest];
}

/** Resolve the copyable text representation for a setting row (draft > stored > effective > default). */
export function getCopyableSettingValue(def: SettingsKey, hasDraft: boolean, draftValue?: unknown): string {
  const raw = hasDraft
    ? draftValue
    : def.stored !== undefined
      ? def.stored
      : def.effective !== undefined
        ? def.effective
        : def.default;
  if (raw === undefined || raw === null) return "";
  if (typeof raw === "string") return raw;
  if (typeof raw === "boolean" || typeof raw === "number") return String(raw);
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}
