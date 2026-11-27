import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../shared/logger.js";

const log = createLogger("codemode-activation");

export const CODEMODE_TOOL_NAME = "codemode";

export interface CodemodeActivationResult {
  activated: boolean;
  reason: "activated" | "already_active" | "excluded" | "not_registered" | "api_unavailable" | "error";
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

/**
 * Inspect CLI arguments for explicit tool exclusion affecting `codemode`:
 * - `--no-tools` / `-nt`
 * - `--exclude-tools` / `-xt` matching `"codemode"` (exact or `*` glob)
 * - `--tools` / `-t` allowlist omitting `"codemode"`, or `-codemode` modifier
 */
export function isCodemodeExcludedByArgv(argv: readonly string[] = process.argv): boolean {
  let modifierExcluded: boolean | null = null;
  let allowlistExcludesCodemode = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") break;
    if (arg === "--no-tools" || arg === "-nt") {
      return true;
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
      if (splitToolList(excludeRaw).some((pattern) => matchesToolPattern(CODEMODE_TOOL_NAME, pattern))) {
        return true;
      }
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
      modifierExcluded = null;
      allowlistExcludesCodemode = false;
      const allModifiers = entries.every((entry) => entry.startsWith("+") || entry.startsWith("-"));
      if (allModifiers) {
        for (const entry of entries) {
          if (entry === `-${CODEMODE_TOOL_NAME}`) modifierExcluded = true;
          else if (entry === `+${CODEMODE_TOOL_NAME}`) modifierExcluded = false;
        }
      } else {
        allowlistExcludesCodemode = !entries.some((pattern) => matchesToolPattern(CODEMODE_TOOL_NAME, pattern));
      }
    }
  }

  return modifierExcluded === true || allowlistExcludesCodemode;
}

/** Check Pi settings `defaultTools` for an explicit `-codemode` exclusion. */
function isCodemodeExcludedBySettings(pi: ExtensionAPI): boolean {
  const getSettings = (pi as any).getSettings;
  if (typeof getSettings !== "function") return false;
  try {
    const defaultTools = getSettings.call(pi)?.defaultTools;
    if (!Array.isArray(defaultTools)) return false;
    let excluded = false;
    for (const entry of defaultTools) {
      if (entry === `-${CODEMODE_TOOL_NAME}`) excluded = true;
      else if (entry === `+${CODEMODE_TOOL_NAME}` || entry === CODEMODE_TOOL_NAME) excluded = false;
    }
    return excluded;
  } catch (err: unknown) {
    log.debug("codemode_settings_check_failed", { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/**
 * Activate Pi's built-in `codemode` tool when it is registered and not excluded
 * via `--no-tools`, `--exclude-tools`, `--tools`, or `defaultTools: ["-codemode"]`.
 *
 * Safe no-op in runtimes or test harnesses where `codemode` or the tool-registry
 * APIs are absent.
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

  if (isCodemodeExcludedByArgv(argv) || isCodemodeExcludedBySettings(pi)) {
    log.debug("codemode_auto_activate_skipped", { reason: "excluded" });
    return { activated: false, reason: "excluded" };
  }

  try {
    const allTools = pi.getAllTools();
    const codemodeTool = Array.isArray(allTools)
      ? allTools.find(
          (tool: any) =>
            tool?.name === CODEMODE_TOOL_NAME &&
            tool?.exposure !== "hidden" &&
            (tool?.reachesTools === undefined || typeof tool?.reachesTools === "function"),
        )
      : undefined;

    if (!codemodeTool) {
      log.debug("codemode_auto_activate_skipped", { reason: "not_registered" });
      return { activated: false, reason: "not_registered" };
    }

    const active = pi.getActiveTools();
    if (active.includes(CODEMODE_TOOL_NAME)) {
      log.debug("codemode_auto_activate_skipped", { reason: "already_active" });
      return { activated: false, reason: "already_active" };
    }

    pi.setActiveTools([...active, CODEMODE_TOOL_NAME]);
    log.info("codemode_auto_activated", { activeCount: active.length + 1 });
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
