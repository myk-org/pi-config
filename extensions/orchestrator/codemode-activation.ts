import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../shared/logger.js";
import { COMS_ALWAYS_AVAILABLE_TOOLS, EXTENSION_NAMESPACE_NAMES } from "../shared/tool-namespaces.js";

const log = createLogger("codemode-activation");

export const CODEMODE_TOOL_NAME = "codemode";
const TOOL_SEARCH_TOOL_NAME = "tool_search";

export interface CodemodeActivationResult {
  activated: boolean;
  reason:
    | "activated"
    | "already_active"
    | "excluded"
    | "not_registered"
    | "api_unavailable"
    | "error";
  /** Number of extension tools activated directly as a fallback when codemode is unavailable. */
  fallbackCount?: number;
}

interface ParsedToolArgv {
  noTools: boolean;
  excludePatterns: string[];
  /** Non-null when an explicit `--tools` allowlist (plain names/globs) was passed. */
  allowlistPatterns: string[] | null;
  /** Last `+name`/`-name` modifier per exact tool name (true = explicitly disabled). */
  modifierExcluded: Map<string, boolean>;
}

/** Match a tool name against a Pi CLI pattern (`*` matches any characters). */
function matchesToolPattern(name: string, pattern: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) return false;
  if (!trimmed.includes("*")) return name === trimmed;
  const escaped = trimmed.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(name);
}

function splitToolList(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseToolArgv(argv: readonly string[]): ParsedToolArgv {
  let noTools = false;
  const excludePatterns: string[] = [];
  let allowlistPatterns: string[] | null = null;
  const modifierExcluded = new Map<string, boolean>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") break;
    if (arg === "--no-tools" || arg === "-nt") {
      noTools = true;
      continue;
    }

    let excludeRaw: string | undefined;
    if ((arg === "--exclude-tools" || arg === "-xt") && i + 1 < argv.length) {
      excludeRaw = argv[++i];
    } else if (arg.startsWith("--exclude-tools=")) {
      excludeRaw = arg.slice("--exclude-tools=".length);
    } else if (arg.startsWith("-xt=")) {
      excludeRaw = arg.slice("-xt=".length);
    }
    if (excludeRaw !== undefined) {
      excludePatterns.push(...splitToolList(excludeRaw));
      continue;
    }

    let toolsRaw: string | undefined;
    if ((arg === "--tools" || arg === "-t") && i + 1 < argv.length) {
      toolsRaw = argv[++i];
    } else if (arg.startsWith("--tools=")) {
      toolsRaw = arg.slice("--tools=".length);
    } else if (arg.startsWith("-t=")) {
      toolsRaw = arg.slice("-t=".length);
    }
    if (toolsRaw !== undefined) {
      const entries = splitToolList(toolsRaw);
      if (entries.length === 0) continue;
      // Match Pi CLI args.js: later --tools replaces earlier --tools.
      allowlistPatterns = null;
      modifierExcluded.clear();
      const allModifiers = entries.every((entry) => entry.startsWith("+") || entry.startsWith("-"));
      if (allModifiers) {
        for (const entry of entries) {
          const toolName = entry.slice(1);
          if (!toolName) continue;
          modifierExcluded.set(toolName, entry.startsWith("-"));
        }
      } else {
        allowlistPatterns = entries;
      }
    }
  }

  return { noTools, excludePatterns, allowlistPatterns, modifierExcluded };
}

function isToolExcludedByArgv(name: string, parsed: ParsedToolArgv): boolean {
  if (parsed.noTools) return true;
  if (parsed.excludePatterns.some((pattern) => matchesToolPattern(name, pattern))) return true;
  if (parsed.modifierExcluded.get(name) === true) return true;
  if (parsed.allowlistPatterns !== null) {
    return !parsed.allowlistPatterns.some((pattern) => matchesToolPattern(name, pattern));
  }
  return false;
}

/**
 * Inspect CLI arguments for explicit tool exclusion affecting `codemode`:
 * - `--no-tools` / `-nt`
 * - `--exclude-tools` / `-xt` matching `"codemode"` (exact or `*` glob)
 * - `--tools` / `-t` allowlist omitting `"codemode"`, or `-codemode` modifier
 */
export function isCodemodeExcludedByArgv(argv: readonly string[] = process.argv): boolean {
  return isToolExcludedByArgv(CODEMODE_TOOL_NAME, parseToolArgv(argv));
}

/** Check Pi settings `defaultTools` for an explicit `-<name>` exclusion. */
function isToolExcludedBySettings(pi: ExtensionAPI, toolName: string): boolean {
  const getSettings = (pi as any).getSettings;
  if (typeof getSettings !== "function") return false;
  try {
    const defaultTools = getSettings.call(pi)?.defaultTools;
    if (!Array.isArray(defaultTools)) return false;
    let excluded = false;
    for (const entry of defaultTools) {
      if (entry === `-${toolName}`) excluded = true;
      else if (entry === `+${toolName}` || entry === toolName) excluded = false;
    }
    return excluded;
  } catch (err: unknown) {
    log.debug("codemode_settings_check_failed", { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/**
 * Fallback when `codemode` is excluded or not registered: directly activate pi-config's
 * ungated `codemode`/`deferred` extension tools so tools like `TaskCreate` and
 * `memory_search` remain reachable by the model.
 *
 * Skips fallback when `--no-tools` or an explicit `--tools` allowlist is set (so
 * deliberately omitted tools stay omitted), when `tool_search` is already active, or
 * for gated COMS tools (`syncComsActiveTools` activates those when `coms_start` runs).
 */
function activateFallbackExtensionTools(
  pi: ExtensionAPI,
  allTools: readonly any[],
  parsedArgv: ParsedToolArgv,
  reason: "excluded" | "not_registered",
): number {
  if (parsedArgv.noTools || parsedArgv.allowlistPatterns !== null) {
    return 0;
  }

  const active = pi.getActiveTools();
  if (active.includes(TOOL_SEARCH_TOOL_NAME)) {
    return 0;
  }

  const activeSet = new Set(active);
  const toActivate: string[] = [];

  for (const tool of allTools) {
    const name = typeof tool?.name === "string" ? tool.name : "";
    if (!name || activeSet.has(name)) continue;
    if (tool.exposure !== "codemode" && tool.exposure !== "deferred") continue;
    const nsName = tool.namespace?.name;
    if (typeof nsName !== "string" || !EXTENSION_NAMESPACE_NAMES.has(nsName)) continue;
    // Keep gated COMS tools inactive until coms_start runs (syncComsActiveTools handles them).
    if (nsName === "coms" && !COMS_ALWAYS_AVAILABLE_TOOLS.has(name)) continue;
    if (tool.defaultActive === false) continue;
    if (isToolExcludedByArgv(name, parsedArgv) || isToolExcludedBySettings(pi, name)) continue;
    toActivate.push(name);
  }

  if (toActivate.length === 0) return 0;

  pi.setActiveTools([...active, ...toActivate]);
  log.info("codemode_fallback_activated", { reason, count: toActivate.length });
  return toActivate.length;
}

/**
 * Activate Pi's built-in `codemode` tool when it is registered and not excluded
 * via `--no-tools`, `--exclude-tools`, `--tools`, or `defaultTools: ["-codemode"]`.
 *
 * When `codemode` is excluded (without `--no-tools` or an explicit `--tools` allowlist)
 * or absent from the runtime, directly activates pi-config's ungated `codemode`/`deferred`
 * extension tools as a model-facing fallback so they remain reachable.
 */
export function ensureCodemodeActive(
  pi: ExtensionAPI,
  argv: readonly string[] = process.argv,
): CodemodeActivationResult {
  if (
    typeof (pi as any).getAllTools !== "function" ||
    typeof (pi as any).getActiveTools !== "function" ||
    typeof (pi as any).setActiveTools !== "function"
  ) {
    log.debug("codemode_auto_activate_skipped", { reason: "api_unavailable" });
    return { activated: false, reason: "api_unavailable" };
  }

  const parsedArgv = parseToolArgv(argv);

  try {
    const allTools = pi.getAllTools();
    const safeAllTools = Array.isArray(allTools) ? allTools : [];

    if (isToolExcludedByArgv(CODEMODE_TOOL_NAME, parsedArgv) || isToolExcludedBySettings(pi, CODEMODE_TOOL_NAME)) {
      log.debug("codemode_auto_activate_skipped", { reason: "excluded" });
      const fallbackCount = activateFallbackExtensionTools(pi, safeAllTools, parsedArgv, "excluded");
      return { activated: false, reason: "excluded", ...(fallbackCount > 0 ? { fallbackCount } : {}) };
    }

    const codemodeTool = safeAllTools.find(
      (tool: any) =>
        tool?.name === CODEMODE_TOOL_NAME &&
        tool?.exposure !== "hidden" &&
        (tool?.reachesTools === undefined || typeof tool?.reachesTools === "function"),
    );

    if (!codemodeTool) {
      log.debug("codemode_auto_activate_skipped", { reason: "not_registered" });
      const fallbackCount = activateFallbackExtensionTools(pi, safeAllTools, parsedArgv, "not_registered");
      return { activated: false, reason: "not_registered", ...(fallbackCount > 0 ? { fallbackCount } : {}) };
    }

    const active = pi.getActiveTools();
    if (active.includes(CODEMODE_TOOL_NAME)) {
      log.debug("codemode_auto_activate_skipped", { reason: "already_active" });
      return { activated: false, reason: "already_active" };
    }

    // Because extensions load alphabetically (`coms` before `orchestrator`), `coms`
    // may transiently add gated `exposure: "codemode"` tools to `activeTools` before
    // `codemode` activates on `session_start`. Demote those once `codemode` is active
    // unless explicitly requested via `+name` in argv/settings.
    const toolByName = new Map<string, any>();
    for (const t of safeAllTools) {
      if (typeof t?.name === "string") toolByName.set(t.name, t);
    }
    const nextActive = active.filter((name) => {
      const tool = toolByName.get(name);
      if (!tool) return true;
      if (tool.exposure !== "codemode" && tool.exposure !== "deferred") return true;
      if (tool.namespace?.name !== "coms" || COMS_ALWAYS_AVAILABLE_TOOLS.has(name)) return true;
      if (parsedArgv.modifierExcluded.get(name) === false) return true;
      return false;
    });

    pi.setActiveTools([...nextActive, CODEMODE_TOOL_NAME]);
    log.info("codemode_auto_activated", { activeCount: nextActive.length + 1 });
    return { activated: true, reason: "activated" };
  } catch (err: unknown) {
    log.warn("codemode_auto_activate_failed", { error: err instanceof Error ? err.message : String(err) });
    return { activated: false, reason: "error" };
  }
}

/** Register a `session_start` hook that auto-activates Pi's `codemode` tool when available. */
export function registerCodemodeActivation(
  pi: ExtensionAPI,
  argv: readonly string[] = process.argv,
): void {
  pi.on("session_start", () => {
    ensureCodemodeActive(pi, argv);
  });
}
