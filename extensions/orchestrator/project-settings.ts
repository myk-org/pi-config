/**
 * Project-level settings — loads .pi/pi-config-settings.jsonc (or .json) with env var fallback.
 *
 * Resolution order:
 * 1. Project .pi/pi-config-settings.jsonc or .json (wins if set, .jsonc preferred)
 * 2. Global ~/.pi/pi-config-settings.jsonc or .json (fallback for all projects)
 * 3. Env var (PI_COMMIT_TRAILER, PI_USE_WORKTREES, PI_DREAM_INTERVAL_HOURS, PI_DCO,
 *    ACPX_AGENTS, CLI_AGENTS, PI_PIDASH_ENABLE, PI_PIDIFF_ENABLE, PI_PIDASH_PORT, PI_IMAGE_MODEL,
 *    PI_INTERNAL_OPERATIONS_PROVIDER, PI_INTERNAL_OPERATIONS_MODEL, PI_REVIEW_LOOP_MAX_CYCLES,
 *    PI_ASYNC_DEBUG, PI_ENFORCEMENT_ALLOWED_COMMANDS, VERTEX_CLAUDE_1M, PI_SIDECAR_LOG_LEVEL,
 *    PI_COMS_MAX_HOPS, PI_COMS_TIMEOUT_MS, PI_COMS_PING_INTERVAL_MS, PI_COMS_DIR,
 *    PI_COMS_NET_PORT, PI_COMS_NET_HOST, PI_COMS_NET_AUTH_TOKEN, PI_COMS_NET_PUBLIC_URL,
 *    PI_COMS_NET_SERVER_URL, PI_COMS_NET_MAX_HOPS, PI_COMS_NET_MESSAGE_TTL_MS, PI_COMS_NET_MAX_INBOX,
 *    PI_COMS_NET_HEARTBEAT_MS, PI_COMS_NET_STALE_AFTER_MS, PI_COMS_NET_OFFLINE_AFTER_MS,
 *    PI_COMS_NET_LOG_HEARTBEAT, PI_COMS_NET_LOG_QUIET)
 * 4. Default (dream_interval_hours defaults to 3; acpx_agents/cli_agents to []; pidash_enable/pidiff_enable to true; pidash_port to 19190;
 *    review_loop_max_cycles to 3)
 *
 * review_loop_max_cycles accepts JSON integers 1-10, or digit strings "1"-"10" only (after trim).
 * Rejects out-of-range values and non-digit forms ("01", "10.0", "1e1", "0b1010", "inf", Infinity, …) —
 * those fall through to the next resolution layer / default (3). Disable the review loop via
 * review_loop_enforcement: false — not via max_cycles.
 */

import { existsSync, statSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import stripJsonComments from "strip-json-comments";
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
  /** Enable 1M context window variants for Vertex Claude models. */
  vertex_claude_1m?: boolean;
  /** Log level for pi-sidecar (debug, info, warn, error). */
  sidecar_log_level?: string;
  /** Enable debug logging for async agents. */
  async_debug?: boolean;
  /** Colon-separated command allowlist for enforcement. Empty = allow all. */
  enforcement_allowed_commands?: string;
  /** Max hops for P2P coms message relay. */
  coms_max_hops?: number;
  /** P2P coms message response timeout in ms. */
  coms_timeout_ms?: number;
  /** P2P coms peer ping interval in ms. */
  coms_ping_interval_ms?: number;
  /** P2P coms data directory. Empty = ~/.pi/coms. */
  coms_dir?: string;
  /** Coms-net server listen port. 0 = random. */
  coms_net_port?: number;
  /** Coms-net server bind host. */
  coms_net_host?: string;
  /** Coms-net auth token. */
  coms_net_auth_token?: string;
  /** Coms-net public URL for remote access. */
  coms_net_public_url?: string;
  /** Coms-net remote server URL to connect to. */
  coms_net_server_url?: string;
  /** Coms-net max message relay hops. */
  coms_net_max_hops?: number;
  /** Coms-net message TTL in ms. */
  coms_net_message_ttl_ms?: number;
  /** Coms-net max queued messages per agent. */
  coms_net_max_inbox?: number;
  /** Coms-net heartbeat interval in ms. */
  coms_net_heartbeat_ms?: number;
  /** Coms-net stale peer threshold in ms. */
  coms_net_stale_after_ms?: number;
  /** Coms-net offline peer threshold in ms. */
  coms_net_offline_after_ms?: number;
  /** Log coms-net heartbeat noise. */
  coms_net_log_heartbeat?: boolean;
  /** Suppress coms-net logs except startup/shutdown. */
  coms_net_log_quiet?: boolean;
}

/** Key definition from settings-keys.json — single source of truth for env names + defaults. */
interface SettingsKeyDef {
  type: string;
  env?: string;
  default: unknown;
  min?: number;
  max?: number;
  strict_digits?: boolean;
  per_key_resolution?: boolean;
}

const SETTINGS_FILENAMES = ["pi-config-settings.jsonc", "pi-config-settings.json"];

/** Find the first existing settings file in a directory (.jsonc preferred over .json). */
function findSettingsFile(dir: string): string | null {
  for (const name of SETTINGS_FILENAMES) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

const SETTINGS_KEYS: Record<string, SettingsKeyDef> = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "settings-keys.json"), "utf-8"),
);

/** Dev-time check: every ProjectSettings field must have a JSON definition. */
const PROJECT_SETTINGS_KEYS: (keyof ProjectSettings)[] = [
  "commit_trailer",
  "allow_push_to_protected_branches",
  "use_worktrees",
  "dream_interval_hours",
  "dco",
  "comment_signature",
  "review_loop_enforcement",
  "orchestrator_edit_write_block",
  "acpx_agents",
  "cli_agents",
  "pidash_enable",
  "pidiff_enable",
  "pidash_port",
  "image_model",
  "internal_operations_provider",
  "internal_operations_model",
  "review_loop_max_cycles",
  "agent_provider",
  "agent_model",
  "agent_overrides",
  "vertex_claude_1m",
  "sidecar_log_level",
  "async_debug",
  "enforcement_allowed_commands",
  "coms_max_hops",
  "coms_timeout_ms",
  "coms_ping_interval_ms",
  "coms_dir",
  "coms_net_port",
  "coms_net_host",
  "coms_net_auth_token",
  "coms_net_public_url",
  "coms_net_server_url",
  "coms_net_max_hops",
  "coms_net_message_ttl_ms",
  "coms_net_max_inbox",
  "coms_net_heartbeat_ms",
  "coms_net_stale_after_ms",
  "coms_net_offline_after_ms",
  "coms_net_log_heartbeat",
  "coms_net_log_quiet",
];
for (const key of PROJECT_SETTINGS_KEYS) {
  if (!(key in SETTINGS_KEYS)) {
    throw new Error(`[project-settings] settings-keys.json missing key: ${key}`);
  }
}

function getSettingsPath(cwd: string): string {
  const piDir = join(resolveRepoRoot(cwd), ".pi");
  return findSettingsFile(piDir) ?? join(piDir, SETTINGS_FILENAMES[0]);
}

function parseSettingsFile(filePath: string): ProjectSettings {
  if (!existsSync(filePath)) return {};
  try {
    const raw = JSON.parse(stripJsonComments(readFileSync(filePath, "utf-8")));
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
          if (v.provider === null) entry.provider = null;
          else if (typeof v.provider === "string") entry.provider = v.provider.trim() || undefined;
          if (v.model === null) entry.model = null;
          else if (typeof v.model === "string") entry.model = v.model.trim() || undefined;
          if (entry.provider !== undefined || entry.model !== undefined) overrides[name] = entry;
        }
      }
      if (Object.keys(overrides).length > 0) result.agent_overrides = overrides;
    }

    // Data-driven parsing for simple settings that follow standard type patterns
    const SIMPLE_BOOL_KEYS: (keyof ProjectSettings)[] = [
      "vertex_claude_1m", "async_debug", "coms_net_log_heartbeat", "coms_net_log_quiet",
    ];
    for (const k of SIMPLE_BOOL_KEYS) {
      if (typeof raw[k] === "boolean") result[k] = raw[k] as any;
    }

    const SIMPLE_STRING_KEYS: (keyof ProjectSettings)[] = [
      "sidecar_log_level", "enforcement_allowed_commands", "coms_dir",
      "coms_net_host", "coms_net_auth_token", "coms_net_public_url", "coms_net_server_url",
    ];
    for (const k of SIMPLE_STRING_KEYS) {
      if (typeof raw[k] === "string") {
        // Store even empty strings — some settings use empty as meaningful ("allow all", "use default dir")
        result[k] = (raw[k] as string).trim() as any;
      }
    }

    const SIMPLE_INT_KEYS: (keyof ProjectSettings)[] = [
      "coms_max_hops", "coms_timeout_ms", "coms_ping_interval_ms",
      "coms_net_port", "coms_net_max_hops", "coms_net_message_ttl_ms",
      "coms_net_max_inbox", "coms_net_heartbeat_ms", "coms_net_stale_after_ms",
      "coms_net_offline_after_ms",
    ];
    for (const k of SIMPLE_INT_KEYS) {
      if (typeof raw[k] === "number" && Number.isInteger(raw[k]) && raw[k] >= 0) {
        const keyDef = SETTINGS_KEYS[k];
        if (keyDef) {
          const min = keyDef.min ?? 0;
          const max = keyDef.max ?? Number.MAX_SAFE_INTEGER;
          if (raw[k] >= min && raw[k] <= max) result[k] = raw[k] as any;
        } else {
          result[k] = raw[k] as any;
        }
      }
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
  const globalPath = globalSettingsPathOverride ?? findSettingsFile(join(homedir(), ".pi")) ?? join(homedir(), ".pi", SETTINGS_FILENAMES[0]);
  return parseSettingsFile(globalPath);
}

function projectSettingsFileHasKey(cwd: string, key: string): boolean {
  const filePath = getSettingsPath(cwd);
  if (!existsSync(filePath)) return false;
  try {
    const raw = JSON.parse(stripJsonComments(readFileSync(filePath, "utf-8")));
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
      const globalPath = globalSettingsPathOverride ?? findSettingsFile(join(homedir(), ".pi")) ?? join(homedir(), ".pi", SETTINGS_FILENAMES[0]);
      cachedGlobalMtime = existsSync(globalPath) ? statSync(globalPath).mtimeMs : 0;
    } catch { cachedGlobalMtime = 0; }
    lastMtimeCheck = now;
    return cachedSettings;
  }
  // Same cwd — throttle mtime checks
  if (now - lastMtimeCheck < MTIME_CHECK_INTERVAL_MS) return cachedSettings;
  lastMtimeCheck = now;
  const settingsPath = getSettingsPath(cwd);
  const globalPath = globalSettingsPathOverride ?? findSettingsFile(join(homedir(), ".pi")) ?? join(homedir(), ".pi", SETTINGS_FILENAMES[0]);
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
export function getSetting(cwd: string, key: "vertex_claude_1m"): boolean;
export function getSetting(cwd: string, key: "sidecar_log_level"): string;
export function getSetting(cwd: string, key: "async_debug"): boolean;
export function getSetting(cwd: string, key: "enforcement_allowed_commands"): string;
export function getSetting(cwd: string, key: "coms_max_hops"): number;
export function getSetting(cwd: string, key: "coms_timeout_ms"): number;
export function getSetting(cwd: string, key: "coms_ping_interval_ms"): number;
export function getSetting(cwd: string, key: "coms_dir"): string;
export function getSetting(cwd: string, key: "coms_net_port"): number;
export function getSetting(cwd: string, key: "coms_net_host"): string;
export function getSetting(cwd: string, key: "coms_net_auth_token"): string;
export function getSetting(cwd: string, key: "coms_net_public_url"): string;
export function getSetting(cwd: string, key: "coms_net_server_url"): string;
export function getSetting(cwd: string, key: "coms_net_max_hops"): number;
export function getSetting(cwd: string, key: "coms_net_message_ttl_ms"): number;
export function getSetting(cwd: string, key: "coms_net_max_inbox"): number;
export function getSetting(cwd: string, key: "coms_net_heartbeat_ms"): number;
export function getSetting(cwd: string, key: "coms_net_stale_after_ms"): number;
export function getSetting(cwd: string, key: "coms_net_offline_after_ms"): number;
export function getSetting(cwd: string, key: "coms_net_log_heartbeat"): boolean;
export function getSetting(cwd: string, key: "coms_net_log_quiet"): boolean;
export function getSetting(cwd: string, key: string): boolean | string | number | string[] | Record<string, { provider?: string | null; model?: string | null }> {
  const settings = getSettings(cwd);
  const def = SETTINGS_KEYS[key];
  if (!def) return false;

  // Special cases — unique parsing beyond simple settings → env → default
  switch (key) {
    case "commit_trailer": {
      if (settings.commit_trailer !== undefined) return settings.commit_trailer;
      const envStr = def.env ? process.env[def.env] : undefined;
      if (envStr !== undefined && envStr !== "") {
        if (["true", "1", "yes", "on"].includes(envStr.toLowerCase())) return true;
        if (["false", "0", "no", "off"].includes(envStr.toLowerCase())) return false;
        return envStr; // treat as custom trailer string
      }
      return def.default as boolean;
    }
    case "acpx_agents":
    case "cli_agents": {
      const agentKey = key as "acpx_agents" | "cli_agents";
      if (projectSettingsFileHasKey(cwd, agentKey)) {
        const projectValue = loadProjectSettings(cwd)[agentKey];
        // Only override when the raw value parsed as a valid type (string or array).
        // Invalid types (number, object, etc.) are skipped by parseSettingsFile,
        // leaving projectValue undefined — fall through to global/env.
        if (projectValue !== undefined) {
          return parseAgentNameList(projectValue);
        }
      }
      const globalAgents = loadGlobalSettings()[agentKey];
      if (globalAgents !== undefined) {
        return parseAgentNameList(globalAgents);
      }
      if (def.env) {
        const env = process.env[def.env];
        if (env !== undefined && env !== "") {
          return parseAgentNameList(env);
        }
      }
      return parseAgentNameList(def.default as string | string[] | undefined);
    }
    case "pidash_enable":
    case "pidiff_enable": {
      const enableKey = key as "pidash_enable" | "pidiff_enable";
      if (settings[enableKey] !== undefined) return settings[enableKey]!;
      if (def.env) {
        const disabled = parseDisabledEnv(def.env);
        if (disabled !== undefined) return !disabled;
      }
      return def.default as boolean;
    }
    case "pidash_port": {
      if (settings.pidash_port !== undefined) {
        // Defensive: validate even though parseSettingsFile already checks
        if (Number.isInteger(settings.pidash_port) && settings.pidash_port > 0 && settings.pidash_port <= 65535) {
          return settings.pidash_port;
        }
        // Invalid value in merged settings — fall through to env/default
      }
      if (def.env) {
        const envPort = parsePortEnv(def.env);
        if (envPort !== undefined) return envPort;
      }
      return def.default as number;
    }
    case "review_loop_max_cycles": {
      if (settings.review_loop_max_cycles !== undefined) return settings.review_loop_max_cycles;
      if (def.env) {
        const env = parseReviewLoopMaxCyclesEnv(def.env);
        if (env !== undefined) return env;
      }
      return def.default as number;
    }
    case "agent_overrides": {
      return settings.agent_overrides || (def.default as Record<string, { provider?: string | null; model?: string | null }>);
    }
  }

  // Generic handler — simple bool / number / string keys driven by settings-keys.json
  const merged = settings[key as keyof ProjectSettings];
  switch (def.type) {
    case "bool": {
      if (merged !== undefined) return merged as boolean;
      if (def.env) {
        const env = parseBoolEnv(def.env);
        if (env !== undefined) return env;
      }
      return def.default as boolean;
    }
    case "int": {
      if (merged !== undefined) return merged as number;
      if (def.env) {
        const val = process.env[def.env];
        if (val !== undefined && val !== "") {
          const trimmed = val.trim();
          if (/^-?\d+$/.test(trimmed)) {
            const n = Number(trimmed);
            const min = def.min ?? 0;
            const max = def.max ?? Number.MAX_SAFE_INTEGER;
            if (n >= min && n <= max) return n;
          }
        }
      }
      return def.default as number;
    }
    case "port": {
      if (merged !== undefined) {
        const n = merged as number;
        if (Number.isInteger(n) && n >= 0 && n <= 65535) return n;
      }
      if (def.env) {
        const val = process.env[def.env];
        if (val !== undefined && val !== "") {
          const trimmed = val.trim();
          if (/^\d+$/.test(trimmed)) {
            const n = Number(trimmed);
            if (n >= 0 && n <= 65535) return n;
          }
        }
      }
      return def.default as number;
    }
    case "number": {
      if (merged !== undefined) return merged as number;
      if (def.env) {
        const env = parseNumEnv(def.env);
        if (env !== undefined) return env;
      }
      return def.default as number;
    }
    case "string": {
      // Preserve empty strings — some settings use empty as meaningful ("allow all", "use default dir")
      if (merged !== undefined) return merged as string;
      if (def.env) {
        const env = process.env[def.env];
        if (env !== undefined && env !== "") return env.trim();
      }
      return def.default as string;
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

    // Inject settings into process.env for standalone packages that can't call getSetting
    const cwd = ctx.cwd;
    const vertexClaude1m = getSetting(cwd, "vertex_claude_1m");
    if (vertexClaude1m) process.env.VERTEX_CLAUDE_1M = "true";
    else delete process.env.VERTEX_CLAUDE_1M;

    const sidecarLogLevel = getSetting(cwd, "sidecar_log_level");
    if (sidecarLogLevel) process.env.PI_SIDECAR_LOG_LEVEL = sidecarLogLevel;
    else delete process.env.PI_SIDECAR_LOG_LEVEL;

    const acpxAgents = getSetting(cwd, "acpx_agents");
    if (acpxAgents.length > 0) process.env.ACPX_AGENTS = acpxAgents.join(",");
    else delete process.env.ACPX_AGENTS;

    const cliAgents = getSetting(cwd, "cli_agents");
    if (cliAgents.length > 0) process.env.CLI_AGENTS = cliAgents.join(",");
    else delete process.env.CLI_AGENTS;

    const imageModel = getSetting(cwd, "image_model");
    if (imageModel) process.env.PI_IMAGE_MODEL = imageModel;
    else delete process.env.PI_IMAGE_MODEL;
  });
}
