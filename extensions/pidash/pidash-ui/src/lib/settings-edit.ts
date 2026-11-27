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
    const allowedZero = def.allow_zero === true && n === 0;
    if (!allowedZero) {
      if (def.min !== undefined && n < def.min) {
        return { value: null, error: def.allow_zero ? `0 or ${def.min}-${def.max ?? "∞"}` : `min ${def.min}` };
      }
      if (def.max !== undefined && n > def.max) {
        return {
          value: null,
          error: def.allow_zero && def.min !== undefined ? `0 or ${def.min}-${def.max}` : `max ${def.max}`,
        };
      }
    }
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
