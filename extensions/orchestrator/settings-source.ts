import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import stripJsonComments from "strip-json-comments";

export interface SettingsKeyDef {
  description: string;
  type: string;
  env?: string;
  default: unknown;
  min?: number;
  max?: number;
  strict_digits?: boolean;
  per_key_resolution?: boolean;
  enum?: string[];
}

export const SETTINGS_FILENAMES = ["pi-config-settings.jsonc", "pi-config-settings.json"];

export const SETTINGS_KEYS: Record<string, SettingsKeyDef> = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "settings-keys.json"), "utf8"),
);

export function findSettingsFile(dir: string): string | null {
  for (const name of SETTINGS_FILENAMES) {
    const file = join(dir, name);
    if (existsSync(file)) return file;
  }
  return null;
}

export function readSettingsObject(file: string | null): Record<string, unknown> {
  if (!file) return {};
  try {
    const value = JSON.parse(stripJsonComments(readFileSync(file, "utf8")));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function getStandaloneSetting(cwd: string, key: string): unknown {
  const project = readSettingsObject(findSettingsFile(join(cwd, ".pi")));
  if (key in project) return project[key];
  const global = readSettingsObject(findSettingsFile(join(homedir(), ".pi")));
  if (key in global) return global[key];
  const definition = SETTINGS_KEYS[key];
  return definition?.env && process.env[definition.env] !== undefined
    ? process.env[definition.env]
    : definition?.default;
}
