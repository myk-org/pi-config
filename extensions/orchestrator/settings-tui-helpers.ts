/**
 * Settings TUI helpers — pure functions extracted for testability.
 * No pi-coding-agent or pi-tui dependencies.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import stripJsonComments from "strip-json-comments";
import {
  type SettingsKeyDef,
  getSettingsPath,
  getGlobalSettingsPath,
} from "./project-settings.js";

// ── Category grouping ───────────────────────────────────────────────

export interface CategoryDef {
  label: string;
  keys: string[];
}

export const CATEGORIES: CategoryDef[] = [
  {
    label: "Git",
    keys: [
      "dco",
      "commit_trailer",
      "use_worktrees",
      "allow_push_to_protected_branches",
      "comment_signature",
    ],
  },
  {
    label: "Review",
    keys: [
      "review_loop_enforcement",
      "review_loop_max_cycles",
    ],
  },
  {
    label: "Memory",
    keys: [
      "dream_interval_hours",
    ],
  },
  {
    label: "Dashboard",
    keys: [
      "pidash_enable",
      "pidiff_enable",
      "pidash_port",
    ],
  },
  {
    label: "Provider",
    keys: [
      "agent_provider",
      "agent_model",
      "internal_operations_provider",
      "internal_operations_model",
      "image_model",
      "vertex_claude_1m",
      "acpx_agents",
      "cli_agents",
      "agent_overrides",
    ],
  },
  {
    label: "Coms (P2P)",
    keys: [
      "coms_max_hops",
      "coms_timeout_ms",
      "coms_ping_interval_ms",
      "coms_dir",
    ],
  },
  {
    label: "Coms (Net)",
    keys: [
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
    ],
  },
  {
    label: "Debug",
    keys: [
      "orchestrator_edit_write_block",
      "async_debug",
      "sidecar_log_level",
      "enforcement_allowed_commands",
    ],
  },
];

// ── Source detection ─────────────────────────────────────────────────

export type SettingSource = "P" | "G" | "E" | "D";

export function detectSource(key: string, def: SettingsKeyDef, cwd: string): SettingSource {
  // Check project settings file
  const projectPath = getSettingsPath(cwd);
  if (existsSync(projectPath)) {
    try {
      const raw = JSON.parse(stripJsonComments(readFileSync(projectPath, "utf-8")));
      if (typeof raw === "object" && raw !== null && key in raw) return "P";
    } catch {}
  }

  // Check global settings file (honors setGlobalSettingsPath for tests)
  const globalPath = getGlobalSettingsPath();
  if (existsSync(globalPath)) {
    try {
      const raw = JSON.parse(stripJsonComments(readFileSync(globalPath, "utf-8")));
      if (typeof raw === "object" && raw !== null && key in raw) return "G";
    } catch {}
  }

  // Check env var
  if (def.env && process.env[def.env] !== undefined && process.env[def.env] !== "") return "E";

  return "D";
}

// ── Value formatting ────────────────────────────────────────────────

export function formatValue(key: string, value: unknown, def: SettingsKeyDef): string {
  if (value === undefined || value === null) return String(def.default);

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
      return value === "" ? "(empty)" : String(value);
    case "agent_list":
      if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "(empty)";
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

// ── Parse raw value for saving ──────────────────────────────────────

export function parseRawValue(key: string, rawValue: string, def: SettingsKeyDef): unknown {
  switch (def.type) {
    case "bool":
    case "bool_enable":
      return rawValue === "true";

    case "bool_or_string":
      if (rawValue === "true") return true;
      if (rawValue === "false") return false;
      return rawValue;

    case "int":
    case "port": {
      const n = parseInt(rawValue, 10);
      return Number.isFinite(n) ? n : def.default;
    }

    case "number": {
      const n = parseFloat(rawValue);
      return Number.isFinite(n) ? n : def.default;
    }

    case "string":
      return rawValue === "(empty)" ? "" : rawValue;

    case "agent_list":
      if (!rawValue || rawValue === "(empty)") return [];
      return rawValue.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

    default:
      return rawValue;
  }
}

// ── Scope-aware file read/write ─────────────────────────────────────

export function getFilePathForScope(scope: "project" | "global", cwd: string): string {
  if (scope === "project") {
    return getSettingsPath(cwd);
  }
  return getGlobalSettingsPath();
}

export function readSettingsFile(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  try {
    const raw = JSON.parse(stripJsonComments(readFileSync(filePath, "utf-8")));
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) return raw;
  } catch {}
  return {};
}

export function writeSettingsFile(filePath: string, data: Record<string, unknown>): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}
