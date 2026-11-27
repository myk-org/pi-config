/**
 * Structured LLM settings tools (`settings_get` and `settings_set`).
 *
 * - `settings_get` (`exposure: "codemode"`, `namespace: runtime`, read-only):
 *   returns exact effective value, per-scope values (`env`, `project`, `global`, `default`),
 *   active `source`, `global_only`, and `description`.
 * - `settings_set` (`exposure: "model-only"`, `destructiveHint: true` — NEVER callable
 *   from QuickJS codemode scripts): validates strictly against `settings-keys.json`,
 *   enforces `global_only`, fails closed without an interactive UI (`!ctx.hasUI` or
 *   subagents), requires code-enforced user approval via `bridgedUi.select(...,
 *   { blockedKind: "permission" })`, and persists atomically via `updateSetting()`.
 */

import type { ExtensionAPI, ToolAnnotations } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createLogger } from "../shared/logger.js";
import { READ_ONLY_LOCAL_ANNOTATIONS, TOOL_NAMESPACES } from "../shared/tool-namespaces.js";
import { createBridgedUi } from "../shared/ui-bridge.js";
import {
  SETTINGS_KEYS,
  type SettingSource,
  type SettingsKeyDef,
  type SettingsScope,
  cloneDefaultValue,
  getCachedSettingsLayers,
  getFilePathForScope,
  getSettingEnvValue,
  readSettingsFile,
  resolveSetting,
  updateSetting,
  validateSetting,
} from "./project-settings.js";
import { CATEGORIES, maskSettingValue } from "./settings-tui-helpers.js";

const log = createLogger("settings_tools");

const DESTRUCTIVE_LOCAL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

export const SETTINGS_APPROVAL_DENY = "Deny";
export const SETTINGS_APPROVAL_APPROVE = "Approve";

/** Security-sensitive keys that trigger an explicit warning banner in the approval prompt. */
export const PROTECTED_SETTING_KEYS: ReadonlySet<string> = new Set([
  "dangerous_command_allowlist",
  "restricted_folders",
  "tool_permissions",
  "lsp_enabled",
  "lsp_servers",
  "orchestrator_edit_write_block",
  "allow_push_to_protected_branches",
  "secret_obfuscation",
]);

export interface SettingBreakdown {
  key: string;
  category: string;
  type: string;
  description: string;
  global_only: boolean;
  env_var: string | null;
  source: SettingSource;
  effective: unknown;
  scopes: {
    env: unknown;
    project: unknown;
    global: unknown;
    default: unknown;
  };
  set_in: Array<"project" | "global" | "env">;
}

function formatPromptValue(key: string, value: unknown, def: SettingsKeyDef, isSet: boolean): string {
  if (!isSet) return "(unset)";
  const masked = maskSettingValue(key, value, def);
  if (typeof masked === "string") return masked === "" ? '""' : JSON.stringify(masked);
  if (typeof masked === "boolean" || typeof masked === "number") return String(masked);
  try {
    const json = JSON.stringify(masked);
    return json.length > 160 ? `${json.slice(0, 157)}...` : json;
  } catch {
    return String(masked);
  }
}

/** Build a structured per-scope breakdown for a single known setting key. */
export function buildSettingBreakdown(
  cwd: string,
  key: string,
  layers?: { global: Record<string, unknown>; project: Record<string, unknown> },
): SettingBreakdown | null {
  const def = SETTINGS_KEYS[key];
  if (!def) return null;

  const resolvedLayers = layers ?? (getCachedSettingsLayers(cwd, { verifyFresh: true }) as {
    global: Record<string, unknown>;
    project: Record<string, unknown>;
  });

  const hasProject = !def.global_only && resolvedLayers.project[key] !== undefined;
  const hasGlobal = resolvedLayers.global[key] !== undefined;
  const envRaw = getSettingEnvValue(key);
  const hasEnv = envRaw !== undefined;
  const defaultVal = cloneDefaultValue(def);

  let source: SettingSource;
  let effectiveRaw: unknown;
  if (hasProject) {
    source = "P";
    effectiveRaw = resolvedLayers.project[key];
  } else if (hasGlobal) {
    source = "G";
    effectiveRaw = resolvedLayers.global[key];
  } else if (hasEnv) {
    source = "E";
    effectiveRaw = envRaw;
  } else {
    source = "D";
    effectiveRaw = defaultVal;
  }

  const setIn: Array<"project" | "global" | "env"> = [];
  if (hasProject) setIn.push("project");
  if (hasGlobal) setIn.push("global");
  if (hasEnv) setIn.push("env");

  return {
    key,
    category: def.group || "Other",
    type: def.type,
    description: def.description,
    global_only: def.global_only === true,
    env_var: def.env ?? null,
    source,
    effective: maskSettingValue(key, effectiveRaw, def),
    scopes: {
      env: hasEnv ? maskSettingValue(key, envRaw, def) : null,
      project: hasProject ? maskSettingValue(key, resolvedLayers.project[key], def) : null,
      global: hasGlobal ? maskSettingValue(key, resolvedLayers.global[key], def) : null,
      default: maskSettingValue(key, defaultVal, def),
    },
    set_in: setIn,
  };
}

/** Build the user-facing permission prompt for `settings_set`. */
export function buildSettingsApprovalPrompt(params: {
  action: "set" | "reset";
  key: string;
  scope: SettingsScope;
  scopeFile: string;
  def: SettingsKeyDef;
  hadOld: boolean;
  oldValue: unknown;
  newValue: unknown;
}): string {
  const { action, key, scope, scopeFile, def, hadOld, oldValue, newValue } = params;
  const oldStr = formatPromptValue(key, oldValue, def, hadOld);
  const newStr =
    action === "reset"
      ? "(unset — inherit/default)"
      : formatPromptValue(key, newValue, def, true);

  const lines: string[] = [];
  if (PROTECTED_SETTING_KEYS.has(key)) {
    lines.push("⚠️ SECURITY-SENSITIVE SETTING CHANGE — review carefully before approving");
  }
  lines.push(`Allow ${action === "reset" ? "resetting" : "updating"} pi-config setting?`);
  lines.push(`Key:    ${key} (${def.group || "Other"})`);
  lines.push(`Scope:  ${scope} (${scopeFile})`);
  lines.push(`Action: ${action}`);
  lines.push(`Change: ${oldStr} -> ${newStr}`);
  return lines.join("\n");
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    details: { ok: false, error: message },
    isError: true,
  };
}

/** Register `settings_get` (codemode, runtime) and `settings_set` (model-only, approval-gated). */
export function registerSettingsTools(pi: ExtensionAPI): void {
  const bridgedUi = createBridgedUi(pi);

  pi.registerTool({
    name: "settings_get",
    label: "Get Settings",
    exposure: "codemode",
    namespace: TOOL_NAMESPACES.runtime,
    annotations: READ_ONLY_LOCAL_ANNOTATIONS,
    description:
      "Inspect pi-config settings (effective value, per-scope env/project/global/default breakdown, active source P/G/E/D, global_only flag, and description). Query a single key, filter by category, or pass only_overrides=true to list all non-default overrides.",
    parameters: Type.Object({
      key: Type.Optional(
        Type.String({
          description: "Specific setting key to inspect (e.g. 'dco', 'advisor_enabled', 'lsp_enabled').",
        }),
      ),
      category: Type.Optional(
        Type.String({
          description: "Filter settings by category name (case-insensitive, e.g. 'Git', 'Enforcement', 'Session').",
        }),
      ),
      only_overrides: Type.Optional(
        Type.Boolean({
          description: "When true, return only settings whose active source is not default (P, G, or E).",
        }),
      ),
    }),
    async execute(_callId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd || process.cwd();
      const layers = getCachedSettingsLayers(cwd, { verifyFresh: true }) as {
        global: Record<string, unknown>;
        project: Record<string, unknown>;
      };

      if (params.key !== undefined) {
        const key = params.key.trim();
        if (!(key in SETTINGS_KEYS)) {
          log.debug("settings_get_unknown_key", { key });
          return errorResult(`Unknown setting key "${key}". Use settings_get() without a key to list valid keys.`);
        }
        const entry = buildSettingBreakdown(cwd, key, layers)!;
        if (params.only_overrides && entry.source === "D") {
          const payload = { scope_files: { project: getFilePathForScope("project", cwd), global: getFilePathForScope("global", cwd) }, settings: [] };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
            details: payload,
          };
        }
        const payload = {
          scope_files: {
            project: getFilePathForScope("project", cwd),
            global: getFilePathForScope("global", cwd),
          },
          setting: entry,
        };
        log.debug("settings_get", { key, source: entry.source });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          details: payload,
        };
      }

      const categoryFilter = params.category?.trim().toLowerCase();
      if (categoryFilter) {
        const validCategories = CATEGORIES.map((c) => c.label);
        const matchedCat = validCategories.find((c) => c.toLowerCase() === categoryFilter);
        if (!matchedCat) {
          log.debug("settings_get_unknown_category", { category: params.category });
          return errorResult(
            `Unknown category "${params.category}". Valid categories: ${validCategories.join(", ")}.`,
          );
        }
      }

      const results: SettingBreakdown[] = [];
      for (const key of Object.keys(SETTINGS_KEYS)) {
        const entry = buildSettingBreakdown(cwd, key, layers);
        if (!entry) continue;
        if (categoryFilter && entry.category.toLowerCase() !== categoryFilter) continue;
        if (params.only_overrides && entry.source === "D") continue;
        results.push(entry);
      }

      const payload = {
        count: results.length,
        scope_files: {
          project: getFilePathForScope("project", cwd),
          global: getFilePathForScope("global", cwd),
        },
        settings: results,
      };
      log.debug("settings_get", {
        category: params.category ?? null,
        only_overrides: Boolean(params.only_overrides),
        count: results.length,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        details: payload,
      };
    },
  });

  pi.registerTool({
    name: "settings_set",
    label: "Update Setting",
    exposure: "model-only",
    annotations: DESTRUCTIVE_LOCAL_ANNOTATIONS,
    description:
      "Update ('set') or clear ('reset') a pi-config setting in 'global' or 'project' scope with code-enforced user approval. Direct edits to pi-config-settings.json remain blocked; always use this tool when the user asks to change a setting. Fails closed in headless/subagent sessions.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("set"), Type.Literal("reset")], {
        description: "'set' to store a validated value in the target scope; 'reset' to remove the key from the target scope.",
      }),
      key: Type.String({
        description: "Setting key defined in settings-keys.json (e.g. 'dco', 'advisor_enabled').",
      }),
      scope: Type.Union([Type.Literal("global"), Type.Literal("project")], {
        description: "Target scope: 'global' (~/.pi/pi-config-settings.json) or 'project' (.pi/pi-config-settings.json).",
      }),
      value: Type.Optional(
        Type.Unknown({
          description: "New value to store (required for action='set'; omit for action='reset').",
        }),
      ),
    }),
    async execute(_callId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd || process.cwd();
      const action = params.action;
      const scope = params.scope;
      const key = typeof params.key === "string" ? params.key.trim() : "";

      if (action !== "set" && action !== "reset") {
        return errorResult(`Invalid action "${String(action)}". Must be "set" or "reset".`);
      }
      if (scope !== "global" && scope !== "project") {
        return errorResult(`Invalid scope "${String(scope)}". Must be "global" or "project".`);
      }

      const def = SETTINGS_KEYS[key];
      if (!def) {
        log.warn("settings_set_unknown_key", { key });
        return errorResult(`Unknown setting key "${key}". Call settings_get() to inspect valid keys.`);
      }

      if (def.global_only && scope === "project") {
        log.warn("settings_set_global_only_rejected", { key, scope });
        return errorResult(`Refused: "${key}" is global-only and cannot be modified in project scope. Use scope="global".`);
      }

      let validatedValue: unknown;
      if (action === "set") {
        if (params.value === undefined || params.value === null) {
          return errorResult(`Invalid value: "value" is required when action="set" (use action="reset" to unset "${key}").`);
        }
        const validated = validateSetting(key, params.value);
        if (!validated.ok) {
          log.warn("settings_set_validation_failed", { key, scope, error: validated.error });
          return errorResult(`Invalid value for "${key}": ${validated.error}`);
        }
        validatedValue = validated.value;
      } else if (params.value !== undefined) {
        return errorResult(`Invalid parameters: "value" must be omitted when action="reset".`);
      }

      // Fail closed when no interactive UI is available (headless peers, RPC without UI, subagents).
      if (!ctx.hasUI || process.env.PI_SUBAGENT_CHILD === "1") {
        log.warn("settings_set_headless_refused", {
          key,
          scope,
          action,
          hasUI: Boolean(ctx.hasUI),
          subagent: process.env.PI_SUBAGENT_CHILD === "1",
        });
        return errorResult(
          `Refused: settings_set requires an interactive UI for explicit user approval (headless and subagent sessions cannot modify settings).`,
        );
      }

      const scopeFile = getFilePathForScope(scope, cwd);
      const current = readSettingsFile(scopeFile);
      if (current === null) {
        log.warn("settings_set_corrupt_file", { key, scope, scopeFile });
        return errorResult(`Refused: settings file is malformed (${scopeFile}). Fix it before modifying settings.`);
      }

      const hadOld = key in current;
      const oldValue = hadOld ? current[key] : undefined;

      if (action === "reset" && !hadOld) {
        log.debug("settings_set_reset_noop", { key, scope });
        const resolved = resolveSetting(cwd, key);
        const payload = {
          ok: true,
          changed: false,
          action,
          key,
          scope,
          file: scopeFile,
          effective: resolved ? maskSettingValue(key, resolved.value, def) : undefined,
          source: resolved?.source,
          message: `"${key}" is already unset in ${scope} scope — no changes made.`,
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          details: payload,
        };
      }

      const promptTitle = buildSettingsApprovalPrompt({
        action,
        key,
        scope,
        scopeFile,
        def,
        hadOld,
        oldValue,
        newValue: validatedValue,
      });

      const choice = await bridgedUi.select(
        ctx,
        promptTitle,
        [SETTINGS_APPROVAL_DENY, SETTINGS_APPROVAL_APPROVE],
        { blockedKind: "permission" },
      );

      if (choice !== SETTINGS_APPROVAL_APPROVE) {
        log.info("settings_set_denied", { key, scope, action, choice: choice ?? "cancelled" });
        return errorResult(
          `Cancelled: user did not approve ${action} for "${key}" in ${scope} scope (${choice ?? "cancelled"}).`,
        );
      }

      const result = updateSetting(cwd, scope, key, action === "reset" ? undefined : validatedValue);
      if (!result.ok) {
        log.error("settings_set_write_failed", { key, scope, action, reason: result.reason, error: result.error });
        return errorResult(`Failed to ${action} "${key}" in ${scope} scope: ${result.error}`);
      }

      try {
        pi.events.emit("orchestrator:settings-changed", { key, cwd });
      } catch {
        /* ignore listener errors */
      }

      const after = resolveSetting(cwd, key);
      log.info("settings_set_applied", {
        key,
        scope,
        action,
        changed: result.changed !== false,
        protectedKey: PROTECTED_SETTING_KEYS.has(key),
      });

      const payload = {
        ok: true,
        changed: result.changed !== false,
        action,
        key,
        scope,
        file: result.file,
        effective: after ? maskSettingValue(key, after.value, def) : undefined,
        source: after?.source,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        details: payload,
      };
    },
  });
}
