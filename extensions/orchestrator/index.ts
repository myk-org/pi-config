/**
 * Orchestrator Extension for pi
 *
 * Bundles:
 * - Subagent tool (based on pi's subagent example, with package agent discovery)
 * - Enforcement handlers (python/pip, git protection, dangerous commands)
 * - Rule injection & memory loading (before_agent_start)
 * - Slash commands (/async, /cron, /worktree, /adopt-skill, /pi-config-settings)
 * - Notifications and status line
 * - Session validation (required tools check)
 * - Async agent infrastructure
 * - ask_user tool
 * - Memory dreaming (background consolidation)
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerAskUser } from "./ask-user.js";
import { registerAsyncAgents } from "./async-agents.js";
import { registerDreaming } from "./dreaming.js";
import { registerEnforcement } from "./enforcement.js";
import { registerMalformedResponseRecovery } from "./malformed-response-recovery.js";
import { registerStreamLoopGuard } from "./stream-loop-guard.js";
import { registerToolArgGuard } from "./tool-arg-guard.js";
import { registerProjectSettings } from "./project-settings.js";
import { registerRules } from "./rules.js";
import { registerSessionValidation } from "./session-validation.js";
import { registerTmpCleanup } from "./tmp-cleanup.js";
import { registerStatusLine } from "./status-line.js";
import { registerSubagentTool } from "./subagent-tool.js";
import { registerGithubAutocomplete } from "./github-autocomplete.js";
import { registerExtendedAutocomplete } from "./extended-autocomplete.js";
import { registerCron } from "./cron.js";
import {
  DEFAULT_BRIDGE_SESSION_KEY,
  publishWorkloadSources,
  resolveBridgeSessionKey,
} from "../shared/session-bridge.js";
import { registerStatus } from "./status.js";
import { registerWorktree } from "./worktree.js";
import { registerNvim } from "./nvim.js";
import { registerPreferenceExtractor } from "./preference-extractor.js";
import { registerSkillMaintenance } from "./skill-maintenance.js";
import { registerMemoryTools } from "./memory-tools.js";
import { registerReviewUI } from "./review-ui.js";
import { registerSessionSearch } from "./session-search.js";
import { closeStateDbs } from "./state-db.js";
import { registerSettingsTui } from "./settings-tui.js";
import { buildSituationReport } from "./situation-report.js";
import { listTopics } from "./memory-tree.js";
import { registerMarkdownTransformer } from "./markdown-transformer.js";
import { registerTrail } from "./trail.js";
import { registerReviewLearning } from "./review-learning.js";
import { registerPrRetro } from "./pr-retro.js";
import { registerSecretObfuscation } from "./secret-obfuscation.js";
import { registerSessionSpill } from "./session-spill.js";
import { registerPreCompactionElision } from "./pre-compaction-elision.js";
import { registerMagicKeywords } from "./magic-keywords.js";
import { registerAdvisor } from "./advisor.js";
import { ensureGitSshTimeout, isRunningInContainer, terminalNotify } from "./utils.js";
import { createLogger } from "../shared/logger.js";
import { emitIfLive, isLiveExtensionCtx } from "../shared/live-ctx.js";
import {
  TOGGLE_ALL_WIDGETS_EVENT,
  registerWidgetShortcut,
  toggleAllWidgets,
} from "../shared/widget-visibility.js";
import { registerProviderStreamLog } from "../shared/provider-stream-log.js";
import { migrateMcpConfig } from "../shared/mcp-config-migration.js";
import { setGlobalSessionId } from "../shared/file-logger.js";
import { registerDaemonManageTool } from "../shared/daemon-manager.js";
import { resolvePiAgentDir } from "../shared/pi-agent-dir.js";

const IN_CONTAINER = isRunningInContainer();
ensureGitSshTimeout();

const log = createLogger("orchestrator");

const CODEMODE_TOOL_NAME = "codemode";

type CodemodePref = "included" | "excluded" | "unset";

function isToolModifierEntry(entry: string): boolean {
  return entry.startsWith("+") || entry.startsWith("-");
}

/**
 * Matches Pi 1.6.1 `SettingsManager.mergeDefaultTools`: a modifier-only override
 * (`+name`/`-name`) appends to the inherited selection; a plain-name list replaces it.
 */
function mergePiDefaultTools(
  base: readonly string[] | undefined,
  override: readonly string[] | undefined,
): readonly string[] | undefined {
  if (override === undefined) return base;
  if (base === undefined || !override.every(isToolModifierEntry)) return override;
  return [...base, ...override];
}

function parseToolListPreference(entries: readonly string[], current: CodemodePref): CodemodePref {
  const trimmed = entries.map((e) => e.trim()).filter(Boolean);
  if (trimmed.length === 0) return "excluded";
  const hasPlain = trimmed.some((e) => !isToolModifierEntry(e));
  if (hasPlain) {
    let active = trimmed.includes(CODEMODE_TOOL_NAME);
    for (const entry of trimmed) {
      if (entry === `+${CODEMODE_TOOL_NAME}`) active = true;
      else if (entry === `-${CODEMODE_TOOL_NAME}`) active = false;
    }
    return active ? "included" : "excluded";
  }
  let state = current;
  for (const entry of trimmed) {
    if (entry === `-${CODEMODE_TOOL_NAME}`) state = "excluded";
    else if (entry === `+${CODEMODE_TOOL_NAME}`) state = "included";
  }
  return state;
}

function readDefaultToolsSetting(filePath: string): string[] | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8")) as { defaultTools?: unknown };
    if (!Array.isArray(raw?.defaultTools)) return undefined;
    return raw.defaultTools.filter((v): v is string => typeof v === "string");
  } catch (err) {
    log.warn(`codemode_settings_read_failed (${filePath})`, {
      path: filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

function resolveArgvCodemodePref(argv: readonly string[]): CodemodePref {
  let pref: CodemodePref = "unset";
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") break;
    if (arg === "--no-tools" || arg === "-nt") {
      pref = "excluded";
      continue;
    }
    let val: string | undefined;
    if (arg === "--tools" && i + 1 < argv.length) {
      val = argv[++i];
    } else if (arg.startsWith("--tools=")) {
      val = arg.slice("--tools=".length);
    }
    if (val !== undefined) {
      pref = parseToolListPreference(val.split(","), pref);
    }
  }
  return pref;
}

export interface EnsureCodemodeActiveOptions {
  cwd?: string;
  projectTrusted?: boolean;
  agentDir?: string | null;
  argv?: readonly string[];
  isSubagentChild?: boolean;
}

/**
 * Activate Pi's built-in `codemode` tool on `session_start` when available and not
 * explicitly excluded via CLI flags or Pi `defaultTools` settings, so native
 * `models.generateImages()` works out of the box in default sessions (#1447).
 */
export function ensureCodemodeActive(
  pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools">,
  options: EnsureCodemodeActiveOptions = {},
): boolean {
  const isSubagentChild = options.isSubagentChild ?? process.env.PI_SUBAGENT_CHILD === "1";
  if (isSubagentChild) return false;
  if (
    typeof pi.getAllTools !== "function" ||
    typeof pi.getActiveTools !== "function" ||
    typeof pi.setActiveTools !== "function"
  ) {
    return false;
  }

  // Respect --no-tools, --exclude-tools, --tools allowlists, and -builtin:codemode:
  // Pi omits disallowed/excluded tools from getAllTools(), and requires reachesTools
  // on the real codemode tool (same contract as Pi's builtin:mcp extension).
  const allTools = pi.getAllTools();
  const hasCodemode = allTools.some(
    (t) => t.name === CODEMODE_TOOL_NAME && Boolean((t as { reachesTools?: unknown }).reachesTools),
  );
  if (!hasCodemode) {
    log.debug("codemode_auto_activate_skipped", { reason: "unavailable_or_excluded" });
    return false;
  }

  const active = pi.getActiveTools();
  if (active.includes(CODEMODE_TOOL_NAME)) {
    return false;
  }

  const globalTools = readDefaultToolsSetting(join(resolvePiAgentDir(options.agentDir), "settings.json"));
  const projectTools =
    options.projectTrusted === true && options.cwd
      ? readDefaultToolsSetting(join(options.cwd, ".pi", "settings.json"))
      : undefined;
  const mergedTools = mergePiDefaultTools(globalTools, projectTools);
  let pref: CodemodePref = mergedTools !== undefined ? parseToolListPreference(mergedTools, "unset") : "unset";
  const argvPref = resolveArgvCodemodePref(options.argv ?? process.argv);
  if (argvPref !== "unset") {
    pref = argvPref;
  }
  if (pref === "excluded") {
    log.debug("codemode_auto_activate_skipped", { reason: "excluded_by_config" });
    return false;
  }

  pi.setActiveTools([...active, CODEMODE_TOOL_NAME]);
  log.info("codemode_auto_activated", { activeCount: active.length + 1 });
  return true;
}

export default function (pi: ExtensionAPI) {
  // Set global session ID FIRST so all fileLog callers get per-session files.
  pi.on("session_start", (_event, ctx) => {
    const reason = (_event as any)?.reason ?? "unknown";
    const sid = ctx.sessionManager?.getSessionId?.();
    log.info("session_start", reason, sid ?? "?");
    if (sid) setGlobalSessionId(sid);
    ensureCodemodeActive(pi, {
      cwd: ctx.cwd,
      projectTrusted: ctx.isProjectTrusted?.() === true,
    });
  });

  // ── Pidash command handler bridge ──────────────────────────────────
  // TODO: Remove once pidash uses PiClient/RemoteSession (#732) — native
  // command dispatch via RemoteSession.submit() eliminates the need for
  // this event-based handler forwarding.
  const originalRegisterCommand = pi.registerCommand.bind(pi);
  const commandHandlerRegistry = new Map<string, Function>();

  pi.registerCommand = (name: string, options: any) => {
    if (options?.handler) {
      const origHandler = options.handler;
      options.handler = async (args: string, ctx: any) => {
        pi.events.emit("pidash:command-ctx", ctx);
        return origHandler(args, ctx);
      };
      commandHandlerRegistry.set(name, options.handler);
      // Notify pidash extension about new command handler
      pi.events.emit("pidash:register-command", { name, handler: options.handler });
    }
    return originalRegisterCommand(name, options);
  };

  // Replay all registered command handlers when pidash requests them
  // (handles extension load order — pidash may load after orchestrator)
  // TODO: Remove once pidash uses PiClient/RemoteSession (#732)
  pi.events.on("pidash:request-commands", () => {
    for (const [name, handler] of commandHandlerRegistry) {
      pi.events.emit("pidash:register-command", { name, handler });
    }
  });

  // ── #968 part E: memory status surface for pidash ──────────────────
  // Read-only snapshot through the live orchestrator memory modules —
  // situation report, topic hotness, entry counts, budget usage.
  // The requesting session's cwd comes in the event payload (the pidash
  // browser may be watching a session in a different project than this
  // process's cwd).
  pi.events.on("pidash:memory-status-request", (data: unknown) => {
    try {
      const payload = (typeof data === "object" && data !== null ? data : {}) as { cwd?: unknown };
      const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
      const report = buildSituationReport(cwd);
      const topics = listTopics(cwd).map((t) => ({
        name: t.name,
        entryCount: t.entryCount,
        hotness: Math.round(t.hotness),
        newestEntry: t.newestEntry,
      }));
      const usageMatch = report.match(/# Project Memory \[([0-9]+)%[^\]]*\]/);
      pi.events.emit("pidash:memory-status", {
        topics,
        usagePct: usageMatch ? Number(usageMatch[1]) : null,
        report,
      });
      log.info("pidash_memory_status_sent", { topics: topics.length });
    } catch (e: any) {
      log.warn("pidash_memory_status_failed", { error: e?.message });
      pi.events.emit("pidash:memory-status", { topics: [], usagePct: null, report: "", error: e?.message });
    }
  });

  // Extended autocomplete must register FIRST — it wraps registerCommand
  // to inject getArgumentCompletions before other modules register their commands.
  registerExtendedAutocomplete(pi);

  registerAskUser(pi, terminalNotify);
  const { spawnAsyncAgent, killAsyncAgent, getAsyncJobs } = registerAsyncAgents(pi, terminalNotify);
  registerSubagentTool(pi, spawnAsyncAgent, killAsyncAgent);
  registerProjectSettings(pi);
  registerTrail(pi);
  // Reversible secret obfuscation (#1413): restore tool_call placeholders BEFORE
  // enforcement sees arguments, obfuscate tool_result BEFORE spill/LLM, and
  // obfuscate provider-bound context without mutating static system prompts.
  registerSecretObfuscation(pi);
  registerEnforcement(pi, IN_CONTAINER);
  // A rejected-before-run tool call must force a retry, not end the turn silently.
  registerToolArgGuard(pi);
  // Bounded auto-recovery when a provider aborts with MALFORMED_RESPONSE (#1333).
  registerMalformedResponseRecovery(pi);
  // Abort runaway streaming repetition/degeneration loops (#1374).
  registerStreamLoopGuard(pi);
  registerReviewUI(pi);
  registerRules(pi, getAsyncJobs);

  registerStatusLine(pi, IN_CONTAINER, terminalNotify);
  registerDreaming(pi, spawnAsyncAgent);
  registerSkillMaintenance(pi);
  const { getCronTasks } = registerCron(pi, spawnAsyncAgent);
  // #1083: peers report their OWN workload — session crons live only in this process, so the
  // coms extension must read them here rather than scan for them.
  let workloadSessionKey = DEFAULT_BRIDGE_SESSION_KEY;
  let unregisterWorkload: (() => void) | null = null;
  const publishOwnWorkload = (ctx?: any, preserveNamedOnMissingId = false): void => {
    const resolvedKey = ctx ? resolveBridgeSessionKey(ctx) : workloadSessionKey;
    const nextKey =
      preserveNamedOnMissingId &&
      resolvedKey === DEFAULT_BRIDGE_SESSION_KEY &&
      workloadSessionKey !== DEFAULT_BRIDGE_SESSION_KEY
        ? workloadSessionKey
        : resolvedKey;
    if (unregisterWorkload && nextKey !== workloadSessionKey) {
      unregisterWorkload();
      unregisterWorkload = null;
    }
    workloadSessionKey = nextKey;
    unregisterWorkload = publishWorkloadSources({ agents: getAsyncJobs, crons: getCronTasks }, workloadSessionKey);
  };
  publishOwnWorkload();
  // #1084: re-publish on every session transition. The getters themselves are live, but a
  // session switch/reload must not leave peers reading a binding from the previous session.
  pi.on("session_start", (_event, ctx) => {
    log.debug("workload_sources_republish", "session_start");
    publishOwnWorkload(ctx);
  });
  // A watched-session switch or any other ctx change shows up as a turn in the new ctx, so
  // re-publishing here keeps the getters bound to the session that is actually running.
  pi.on("before_agent_start", (_event, ctx) => publishOwnWorkload(ctx, true));
  // A torn-down runtime must not keep answering coms drilldowns from dead getters
  // or hold open SQLite state DB handles.
  pi.on("session_shutdown", () => {
    log.debug("session_shutdown", "clearing workload sources and closing state DBs");
    unregisterWorkload?.();
    unregisterWorkload = null;
    closeStateDbs();
  });
  registerSessionValidation(pi);
  registerGithubAutocomplete(pi);
  registerStatus(pi, IN_CONTAINER, getAsyncJobs, getCronTasks);
  registerWorktree(pi);
  registerDaemonManageTool(pi);
  registerNvim(pi);
  registerPreferenceExtractor(pi);
  registerMemoryTools(pi);
  registerReviewLearning(pi);
  registerPrRetro(pi, spawnAsyncAgent);
  registerTmpCleanup(pi);
  registerSessionSearch(pi);
  registerSettingsTui(pi);
  registerMarkdownTransformer(pi);
  // Register session spill LAST among tool_result hooks so enforcement, trail,
  // review-learning, pr-retro, and skill-maintenance inspect full outputs first (#1420).
  registerSessionSpill(pi);
  // Mechanical pre-compaction elision of old bulky tool results (#1421).
  registerPreCompactionElision(pi);
  // Per-turn reasoning-effort magic keywords (`ultrathink` / `chillax`) (#1418).
  registerMagicKeywords(pi);
  // Opt-in background read-only advisor/watchdog model (default disabled) (#1419).
  registerAdvisor(pi);
  if (process.env.PI_SUBAGENT_CHILD !== "1") {
    registerWidgetShortcut(
      pi,
      "widget_all_shortcut",
      process.cwd(),
      "Collapse/expand both tasks and coms widgets",
      (ctx) => {
        if (!isLiveExtensionCtx(ctx)) return;
        const cwd = ctx?.cwd || process.cwd();
        const modes = toggleAllWidgets(cwd);
        emitIfLive(pi, TOGGLE_ALL_WIDGETS_EVENT, { modes, cwd });
        log.info("widget_all_shortcut_toggled", { modes });
      },
    );
  }
  // Raw provider stream logging — gated on `log_providers=debug` (#848).
  registerProviderStreamLog(pi);
  // Copy a pre-#848 `~/.pi/pi-config/mcp.json` to where builtin:mcp reads it (#848).
  migrateMcpConfig();

  // ── list_models tool — LLM-callable model discovery ──
  pi.registerTool({
    name: "list_models",
    label: "List Models",
    description: "List available models and providers. Use when the user asks to run an agent with a specific model, or when you need to discover available models for the subagent model parameter. Returns provider/model pairs that can be passed to subagent(model=\"provider/model-id\").",
    parameters: Type.Object({
      provider: Type.Optional(Type.String({ description: "Filter by provider name (e.g., 'litellm', 'google', 'anthropic')" })),
    }),
    async execute(_callId, params, _signal, _onUpdate, ctx) {
      let models: any[];
      try {
        const registry = ctx.modelRegistry;
        if (!registry) {
          return {
            content: [{ type: "text" as const, text: "Model registry not available." }],
            details: undefined,
          };
        }
        models = registry.getAvailable?.() || registry.getAll?.() || [];
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `Failed to list models: ${e?.message || e}` }],
          details: undefined,
        };
      }
      const filtered = params.provider
        ? models.filter((m: any) => m.provider === params.provider)
        : models;
      if (filtered.length === 0) {
        return {
          content: [{ type: "text" as const, text: params.provider ? `No models found for provider "${params.provider}".` : "No models available." }],
          details: undefined,
        };
      }
      // Group by provider for readability
      const byProvider = new Map<string, string[]>();
      for (const m of filtered) {
        const list = byProvider.get(m.provider) || [];
        list.push(m.id);
        byProvider.set(m.provider, list);
      }
      const lines: string[] = [];
      for (const [prov, ids] of byProvider) {
        lines.push(`## ${prov}`);
        for (const id of ids) {
          lines.push(`- ${prov}/${id}`);
        }
      }
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: undefined,
      };
    },
  });
}
