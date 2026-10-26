import type { SettingsKey } from "@/types";

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
  if (t === "string_list") {
    const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
    return { value: list };
  }
  if (t === "agent_overrides") {
    // The settings parser accepts agent_overrides only as an object mapping
    // agent name -> {provider?, model?} — sending the raw text would report a
    // successful save while persisting an ignored string (Qodo R1).
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { value: null, error: "must be a JSON object: {\"agent\": {\"model\": \"...\"}}" };
      }
      return { value: parsed };
    } catch {
      return { value: null, error: "invalid JSON object" };
    }
  }
  if (t === "agent_list") {
    // Stored as string or array of strings — send an array.
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
  if (typeof v === "object") return JSON.stringify(v, null, 2);
  return String(v);
}
