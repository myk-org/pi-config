/**
 * Project-level settings — loads .pi/pi-config-settings.json with env var fallback.
 *
 * Resolution order:
 * 1. Project .pi/pi-config-settings.json (wins if set)
 * 2. Global ~/.pi/pi-config-settings.json (fallback for all projects)
 * 3. Env var (PI_COMMIT_TRAILER, PI_USE_WORKTREES, PI_DREAM_INTERVAL_HOURS, PI_DCO,
 *    ACPX_AGENTS, CLI_AGENTS, PI_PIDASH_ENABLE, PI_PIDIFF_ENABLE, PI_PIDASH_PORT, PI_IMAGE_MODEL,
 *    PI_INTERNAL_OPERATIONS_PROVIDER, PI_INTERNAL_OPERATIONS_MODEL, PI_REVIEW_LOOP_MAX_CYCLES)
 * 4. Default (dream_interval_hours defaults to 3; acpx_agents/cli_agents to []; pidash_enable/pidiff_enable to true; pidash_port to 19190;
 *    review_loop_max_cycles to 3)
 *
 * review_loop_max_cycles accepts JSON integers 1-10, or digit strings "1"-"10" only (after trim).
 * Rejects out-of-range values and non-digit forms ("01", "10.0", "1e1", "0b1010", "inf", Infinity, …) —
 * those fall through to the next resolution layer / default (3). Disable the review loop via
 * review_loop_enforcement: false — not via max_cycles.
 */

import { existsSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveRepoRoot } from "./utils.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface ProjectSettings {
  commit_trailer?: boolean | string;
  allow_push_to_protected_branches?: boolean;
  use_worktrees?: boolean;
  dream_interval_hours?: number;
  dco?: boolean;
  comment_signature?: boolean;
  review_loop_enforcement?: boolean;
  /** Block orchestrator from using edit and write tools directly (must delegate to subagents). Default: false. */
  orchestrator_edit_write_block?: boolean;
  acpx_agents?: string | string[];
  /** CLI-backed providers to register as cli-${agent} (claude, gemini, cursor). */
  cli_agents?: string | string[];
  pidash_enable?: boolean;
  pidiff_enable?: boolean;
  pidash_port?: number;
  image_model?: string;
  /** Provider for detached LLM async children when parent is acpx (must-async / dream). */
  internal_operations_provider?: string;
  /** Model id for detached LLM async children when parent is acpx. */
  internal_operations_model?: string;
  /** Max review-loop cycles injected into the rules prompt. Integer 1-10 only. */
  review_loop_max_cycles?: number;
  /** Default provider for all subagents. */
  agent_provider?: string;
  /** Default model for all subagents. */
  agent_model?: string;
  /** Per-agent provider/model overrides. null = use parent model (skip global agent_provider/agent_model). */
  agent_overrides?: Record<string, { provider?: string | null; model?: string | null }>;
}

const SETTINGS_FILENAME = "pi-config-settings.json";

function getSettingsPath(cwd: string): string {
  return join(resolveRepoRoot(cwd), ".pi", SETTINGS_FILENAME);
}

function parseSettingsFile(filePath: string): ProjectSettings {
  if (!existsSync(filePath)) return {};
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    const result: ProjectSettings = {};
    if (typeof raw.commit_trailer === "boolean" || typeof raw.commit_trailer === "string") result.commit_trailer = raw.commit_trailer;
    if (typeof raw.allow_push_to_protected_branches === "boolean") result.allow_push_to_protected_branches = raw.allow_push_to_protected_branches;
    if (typeof raw.use_worktrees === "boolean") result.use_worktrees = raw.use_worktrees;
    if (typeof raw.dream_interval_hours === "number" && Number.isFinite(raw.dream_interval_hours)) {
      result.dream_interval_hours = raw.dream_interval_hours;
    }
    if (typeof raw.dco === "boolean") result.dco = raw.dco;
    if (typeof raw.comment_signature === "boolean") result.comment_signature = raw.comment_signature;
    if (typeof raw.review_loop_enforcement === "boolean") result.review_loop_enforcement = raw.review_loop_enforcement;
    if (typeof raw.orchestrator_edit_write_block === "boolean") result.orchestrator_edit_write_block = raw.orchestrator_edit_write_block;
    if (typeof raw.pidash_enable === "boolean") result.pidash_enable = raw.pidash_enable;
    if (typeof raw.pidiff_enable === "boolean") result.pidiff_enable = raw.pidiff_enable;
    if (typeof raw.pidash_port === "number" && Number.isInteger(raw.pidash_port) && raw.pidash_port > 0 && raw.pidash_port <= 65535) {
      result.pidash_port = raw.pidash_port;
    }
    if (typeof raw.image_model === "string" && raw.image_model.trim()) {
      result.image_model = raw.image_model.trim();
    }
    if (typeof raw.internal_operations_provider === "string" && raw.internal_operations_provider.trim()) {
      result.internal_operations_provider = raw.internal_operations_provider.trim();
    }
    if (typeof raw.internal_operations_model === "string" && raw.internal_operations_model.trim()) {
      result.internal_operations_model = raw.internal_operations_model.trim();
    }
    const parsedMaxCycles = parseReviewLoopMaxCycles(raw.review_loop_max_cycles);
    if (parsedMaxCycles !== undefined) {
      result.review_loop_max_cycles = parsedMaxCycles;
    }
    if (typeof raw.acpx_agents === "string") {
      result.acpx_agents = raw.acpx_agents;
    } else if (Array.isArray(raw.acpx_agents)) {
      result.acpx_agents = raw.acpx_agents;
    }
    if (typeof raw.cli_agents === "string") {
      result.cli_agents = raw.cli_agents;
    } else if (Array.isArray(raw.cli_agents)) {
      result.cli_agents = raw.cli_agents;
    }
    if (typeof raw.agent_provider === "string") {
      result.agent_provider = raw.agent_provider.trim();
    }
    if (typeof raw.agent_model === "string") {
      result.agent_model = raw.agent_model.trim();
    }
    if (typeof raw.agent_overrides === "object" && raw.agent_overrides !== null && !Array.isArray(raw.agent_overrides)) {
      const overrides: Record<string, { provider?: string | null; model?: string | null }> = {};
      for (const [name, val] of Object.entries(raw.agent_overrides)) {
        if (typeof val === "object" && val !== null && !Array.isArray(val)) {
          const v = val as { provider?: unknown; model?: unknown };
          const entry: { provider?: string | null; model?: string | null } = {};
          if (v.provider === null || (typeof v.provider === "string")) entry.provider = v.provider === null ? null : v.provider.trim() || undefined;
          if (v.model === null || (typeof v.model === "string")) entry.model = v.model === null ? null : v.model.trim() || undefined;
          if (entry.provider !== undefined || entry.model !== undefined) overrides[name] = entry;
        }
      }
      if (Object.keys(overrides).length > 0) result.agent_overrides = overrides;
    }
    return result;
  } catch (e: any) {
    console.debug(`[project-settings] failed to parse ${filePath}:`, e?.message?.slice(0, 100));
    return {};
  }
}

function loadProjectSettings(cwd: string): ProjectSettings {
  return parseSettingsFile(getSettingsPath(cwd));
}

/** Override global settings path for testing. When set, loadGlobalSettings reads from this instead of ~/.pi/. */
let globalSettingsPathOverride: string | null = null;

/** Set a custom global settings path (for tests). Pass null to restore default. Clears cache immediately. */
export function setGlobalSettingsPath(path: string | null): void {
  globalSettingsPathOverride = path;
  clearSettingsCache();
}

function loadGlobalSettings(): ProjectSettings {
  const globalPath = globalSettingsPathOverride ?? join(homedir(), ".pi", SETTINGS_FILENAME);
  return parseSettingsFile(globalPath);
}

function projectSettingsFileHasKey(cwd: string, key: string): boolean {
  const filePath = getSettingsPath(cwd);
  if (!existsSync(filePath)) return false;
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    return typeof raw === "object" && raw !== null && !Array.isArray(raw) && key in raw;
  } catch (e: any) {
    console.debug(`[project-settings] failed to check key in ${filePath}:`, e?.message?.slice(0, 100));
    return false;
  }
}

function parseDisabledEnv(name: string): boolean | undefined {
  const val = process.env[name];
  if (val === undefined || val === "") return undefined;
  return ["false", "0", "no", "off"].includes(val.toLowerCase());
}

function parseBoolEnv(name: string): boolean | undefined {
  const val = process.env[name];
  if (val === undefined || val === "") return undefined;
  return ["true", "1", "yes", "on"].includes(val.toLowerCase());
}

function parsePortEnv(name: string): number | undefined {
  const val = process.env[name];
  if (val === undefined || val === "") return undefined;
  const port = parseInt(val, 10);
  return Number.isFinite(port) && port > 0 && port <= 65535 ? port : undefined;
}

/** Parse agent name lists (acpx_agents / cli_agents) — comma-separated string or JSON array. */
export function parseAgentNameList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  const parts = Array.isArray(value)
    ? value.map((a) => (typeof a === "string" ? a.trim().toLowerCase() : ""))
    : value.split(",").map((a) => a.trim().toLowerCase());
  const filtered = parts.filter((a) => /^[a-z0-9_-]+$/.test(a));
  return [...new Set(filtered)];
}

/**
 * Coerce a getSetting result to string[].
 * Mixed/stale ~/.pi installs may pair a new provider with an older project-settings
 * that returns `false` for unknown keys — never assume .filter/.map is safe.
 */
export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === "string");
}

/** @deprecated Use parseAgentNameList — kept for existing imports. */
export function parseAcpxAgentList(value: string | string[] | undefined): string[] {
  return parseAgentNameList(value);
}

function parseNumEnv(name: string): number | undefined {
  const val = process.env[name];
  if (val === undefined || val === "") return undefined;
  const n = parseFloat(val);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse review_loop_max_cycles from a raw settings-file or env value.
 * Accepts an integer 1-10, or a digit string "1"-"10" only (no exponents/binary/hex/decimals).
 * Returns undefined for anything else (0, negative, >10, NaN, "inf", Infinity, "1e1", "10.0", …) —
 * callers should fall through to the next resolution layer (global settings → env var → default 3).
 */
export function parseReviewLoopMaxCycles(raw: unknown): number | undefined {
  if (typeof raw === "number") {
    return Number.isInteger(raw) && raw >= 1 && raw <= 10 ? raw : undefined;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    // Strict digit strings only — reject "1e1", "0b1010", "10.0", "01", etc.
    if (!/^(?:[1-9]|10)$/.test(trimmed)) return undefined;
    return parseInt(trimmed, 10);
  }
  return undefined;
}

/** Parse PI_REVIEW_LOOP_MAX_CYCLES env var — digit string "1"-"10" only (same rules as parseReviewLoopMaxCycles). */
function parseReviewLoopMaxCyclesEnv(name: string): number | undefined {
  const val = process.env[name];
  if (val === undefined || val === "") return undefined;
  return parseReviewLoopMaxCycles(val);
}

/** Cached settings per cwd */
let cachedCwd = "";
let cachedSettings: ProjectSettings = {};
let cachedMtime = 0;
let cachedGlobalMtime = 0;
let lastMtimeCheck = 0;
const MTIME_CHECK_INTERVAL_MS = 30_000; // Check file mtime at most every 30s

function getSettings(cwd: string): ProjectSettings {
  const now = Date.now();
  // Different cwd — always reload
  if (cwd !== cachedCwd) {
    const projectSettings = loadProjectSettings(cwd);
    const globalSettings = loadGlobalSettings();
    cachedSettings = { ...globalSettings, ...projectSettings };
    cachedCwd = cwd;
    try {
      const settingsPath = getSettingsPath(cwd);
      cachedMtime = existsSync(settingsPath) ? statSync(settingsPath).mtimeMs : 0;
    } catch { cachedMtime = 0; }
    try {
      const globalPath = globalSettingsPathOverride ?? join(homedir(), ".pi", SETTINGS_FILENAME);
      cachedGlobalMtime = existsSync(globalPath) ? statSync(globalPath).mtimeMs : 0;
    } catch { cachedGlobalMtime = 0; }
    lastMtimeCheck = now;
    return cachedSettings;
  }
  // Same cwd — throttle mtime checks
  if (now - lastMtimeCheck < MTIME_CHECK_INTERVAL_MS) return cachedSettings;
  lastMtimeCheck = now;
  const settingsPath = getSettingsPath(cwd);
  const globalPath = globalSettingsPathOverride ?? join(homedir(), ".pi", SETTINGS_FILENAME);
  let mtime = 0;
  let globalMtime = 0;
  try { if (existsSync(settingsPath)) mtime = statSync(settingsPath).mtimeMs; } catch {}
  try { if (existsSync(globalPath)) globalMtime = statSync(globalPath).mtimeMs; } catch {}
  if (mtime === cachedMtime && globalMtime === cachedGlobalMtime) return cachedSettings;
  cachedSettings = { ...loadGlobalSettings(), ...loadProjectSettings(cwd) };
  cachedMtime = mtime;
  cachedGlobalMtime = globalMtime;
  return cachedSettings;
}

/** Clear cache — call after migration or manual edits */
export function clearSettingsCache(): void {
  cachedCwd = "";
  cachedSettings = {};
}

/**
 * Get a setting value. Resolution: project file → global ~/.pi/pi-config-settings.json → env var → default.
 */
export function getSetting(cwd: string, key: "commit_trailer"): boolean | string;
export function getSetting(cwd: string, key: "allow_push_to_protected_branches"): boolean;
export function getSetting(cwd: string, key: "use_worktrees"): boolean;
export function getSetting(cwd: string, key: "dream_interval_hours"): number;
export function getSetting(cwd: string, key: "dco"): boolean;
export function getSetting(cwd: string, key: "comment_signature"): boolean;
export function getSetting(cwd: string, key: "review_loop_enforcement"): boolean;
export function getSetting(cwd: string, key: "orchestrator_edit_write_block"): boolean;
export function getSetting(cwd: string, key: "acpx_agents"): string[];
export function getSetting(cwd: string, key: "cli_agents"): string[];
export function getSetting(cwd: string, key: "pidash_enable"): boolean;
export function getSetting(cwd: string, key: "pidiff_enable"): boolean;
export function getSetting(cwd: string, key: "pidash_port"): number;
export function getSetting(cwd: string, key: "image_model"): string;
export function getSetting(cwd: string, key: "internal_operations_provider"): string;
export function getSetting(cwd: string, key: "internal_operations_model"): string;
export function getSetting(cwd: string, key: "review_loop_max_cycles"): number;
export function getSetting(cwd: string, key: "agent_provider"): string;
export function getSetting(cwd: string, key: "agent_model"): string;
export function getSetting(cwd: string, key: "agent_overrides"): Record<string, { provider?: string | null; model?: string | null }>;
export function getSetting(cwd: string, key: string): boolean | string | number | string[] | Record<string, { provider?: string | null; model?: string | null }> {
  const settings = getSettings(cwd);

  switch (key) {
    case "commit_trailer": {
      if (settings.commit_trailer !== undefined) return settings.commit_trailer;
      const envStr = process.env.PI_COMMIT_TRAILER;
      if (envStr !== undefined && envStr !== "") {
        if (["true", "1", "yes", "on"].includes(envStr.toLowerCase())) return true;
        if (["false", "0", "no", "off"].includes(envStr.toLowerCase())) return false;
        return envStr; // treat as custom trailer string
      }
      return false; // default: disabled
    }
    case "allow_push_to_protected_branches": {
      if (settings.allow_push_to_protected_branches !== undefined) return settings.allow_push_to_protected_branches;
      const env = parseBoolEnv("PI_ALLOW_PUSH_TO_PROTECTED_BRANCHES");
      if (env !== undefined) return env;
      return false; // default: block pushes to protected branches
    }
    case "use_worktrees": {
      if (settings.use_worktrees !== undefined) return settings.use_worktrees;
      const env = parseBoolEnv("PI_USE_WORKTREES");
      if (env !== undefined) return env;
      return false; // default: disabled
    }
    case "dream_interval_hours": {
      if (settings.dream_interval_hours !== undefined) return settings.dream_interval_hours;
      const env = parseNumEnv("PI_DREAM_INTERVAL_HOURS");
      if (env !== undefined) return env;
      return 3; // default: 3 hours
    }
    case "dco": {
      if (settings.dco !== undefined) return settings.dco;
      const env = parseBoolEnv("PI_DCO");
      if (env !== undefined) return env;
      return false; // default: disabled
    }
    case "comment_signature": {
      if (settings.comment_signature !== undefined) return settings.comment_signature;
      return false; // default: disabled
    }
    case "review_loop_enforcement": {
      if (settings.review_loop_enforcement !== undefined) return settings.review_loop_enforcement;
      const env = parseBoolEnv("PI_REVIEW_LOOP_ENFORCEMENT");
      if (env !== undefined) return env;
      return false; // default: disabled (opt-in)
    }
    case "orchestrator_edit_write_block": {
      if (settings.orchestrator_edit_write_block !== undefined) return settings.orchestrator_edit_write_block;
      return false; // default: disabled
    }
    case "acpx_agents": {
      if (projectSettingsFileHasKey(cwd, "acpx_agents")) {
        const projectValue = loadProjectSettings(cwd).acpx_agents;
        // Only override when the raw value parsed as a valid type (string or array).
        // Invalid types (number, object, etc.) are skipped by parseSettingsFile,
        // leaving projectValue undefined — fall through to global/env.
        if (projectValue !== undefined) {
          return parseAgentNameList(projectValue);
        }
      }
      const globalAgents = loadGlobalSettings().acpx_agents;
      if (globalAgents !== undefined) {
        return parseAgentNameList(globalAgents);
      }
      const env = process.env.ACPX_AGENTS;
      if (env !== undefined && env !== "") {
        return parseAgentNameList(env);
      }
      return [];
    }
    case "cli_agents": {
      if (projectSettingsFileHasKey(cwd, "cli_agents")) {
        const projectValue = loadProjectSettings(cwd).cli_agents;
        if (projectValue !== undefined) {
          return parseAgentNameList(projectValue);
        }
      }
      const globalAgents = loadGlobalSettings().cli_agents;
      if (globalAgents !== undefined) {
        return parseAgentNameList(globalAgents);
      }
      const env = process.env.CLI_AGENTS;
      if (env !== undefined && env !== "") {
        return parseAgentNameList(env);
      }
      return [];
    }
    case "pidash_enable": {
      if (settings.pidash_enable !== undefined) return settings.pidash_enable;
      const disabled = parseDisabledEnv("PI_PIDASH_ENABLE");
      if (disabled !== undefined) return !disabled;
      return true;
    }
    case "pidiff_enable": {
      if (settings.pidiff_enable !== undefined) return settings.pidiff_enable;
      const disabled = parseDisabledEnv("PI_PIDIFF_ENABLE");
      if (disabled !== undefined) return !disabled;
      return true;
    }
    case "pidash_port": {
      if (settings.pidash_port !== undefined) {
        // Defensive: validate even though parseSettingsFile already checks
        if (Number.isInteger(settings.pidash_port) && settings.pidash_port > 0 && settings.pidash_port <= 65535) {
          return settings.pidash_port;
        }
        // Invalid value in merged settings — fall through to env/default
      }
      const envPort = parsePortEnv("PI_PIDASH_PORT");
      if (envPort !== undefined) return envPort;
      return 19190;
    }
    case "image_model": {
      if (settings.image_model !== undefined) return settings.image_model;
      const env = process.env.PI_IMAGE_MODEL;
      return env !== undefined && env !== "" ? env : "";
    }
    case "internal_operations_provider": {
      if (settings.internal_operations_provider !== undefined) return settings.internal_operations_provider;
      const env = process.env.PI_INTERNAL_OPERATIONS_PROVIDER;
      return env !== undefined && env !== "" ? env.trim() : "";
    }
    case "internal_operations_model": {
      if (settings.internal_operations_model !== undefined) return settings.internal_operations_model;
      const env = process.env.PI_INTERNAL_OPERATIONS_MODEL;
      return env !== undefined && env !== "" ? env.trim() : "";
    }
    case "review_loop_max_cycles": {
      if (settings.review_loop_max_cycles !== undefined) return settings.review_loop_max_cycles;
      const env = parseReviewLoopMaxCyclesEnv("PI_REVIEW_LOOP_MAX_CYCLES");
      if (env !== undefined) return env;
      return 3; // default: 3 cycles
    }
    case "agent_provider": {
      return settings.agent_provider || "";
    }
    case "agent_model": {
      return settings.agent_model || "";
    }
    case "agent_overrides": {
      return settings.agent_overrides || {};
    }
    default:
      return false;
  }
}

/**
 * Register project settings — runs migration on session_start.
 */
export function registerProjectSettings(pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

  pi.on("session_start", (_event, ctx) => {
    clearSettingsCache();
  });
}
