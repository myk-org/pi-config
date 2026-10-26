import type { SettingsKey } from "@/types";

/** Parse a raw text draft into a typed setting value (#968 G settings page). */
export function parseTypedSetting(raw: string, def: SettingsKey): { value: unknown; error?: string } {
  const t = def.type;
  if (t === "bool" || t === "bool_or_string") {
    if (raw === "true") return { value: true };
    if (raw === "false") return { value: false };
    if (t === "bool") return { value: null, error: "must be true/false" };
    return { value: raw };
  }
  if (t === "int" || t === "number") {
    const n = t === "int" ? Number.parseInt(raw, 10) : Number(raw);
    if (!Number.isFinite(n)) return { value: null, error: "not a number" };
    if (def.min !== undefined && n < def.min) return { value: null, error: `min ${def.min}` };
    if (def.max !== undefined && n > def.max) return { value: null, error: `max ${def.max}` };
    return { value: n };
  }
  if (t === "string_list") {
    const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
    return { value: list };
  }
  if (def.enum?.length && !def.enum.includes(raw)) return { value: null, error: `must be one of: ${def.enum.join(", ")}` };
  return { value: raw };
}

/** Format a stored setting value for the editor input. */
export function displaySettingValue(v: unknown): string {
  if (v === undefined) return "";
  if (v === null) return "null";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}
