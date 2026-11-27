/**
 * Shared subagent child process specification assembly — model/provider resolution,
 * Pi CLI flags, system prompt rendering, and child environment variables.
 * Used by both sync (`subagent-tool.ts`) and async (`async-agents.ts`) spawn paths.
 */

import { createLogger } from "../shared/logger.js";
import { withPropagatedPiAgentDirEnv } from "../shared/pi-agent-dir.js";
import type { AgentConfig } from "./agents.js";
import { getSettingDynamic, SETTINGS_KEYS } from "./project-settings.js";
import { resolveAgentModelProvider } from "./resolve-agent-model.js";
import { resolveAgentSystemPrompt } from "./rule-placeholders.js";
import { trailToolsArgs } from "./trail.js";
import { djb2Hash } from "./utils.js";

const log = createLogger("subagent");

/** Precomputed setting key names — avoids calling Object.keys(SETTINGS_KEYS) on every spawn. */
export const SETTINGS_KEY_NAMES: readonly string[] = Object.keys(SETTINGS_KEYS);

export interface SubagentChildSpecOptions {
  mode: "sync" | "async";
  agentName: string;
  agent: Pick<AgentConfig, "model" | "provider" | "tools" | "systemPrompt">;
  task: string;
  cwd: string;
  persistSession: boolean;
  parentModelId?: string;
  parentProvider?: string;
  parentSessionId?: string;
  explicit?: { model?: string; provider?: string };
  extraEnv?: Record<string, string | undefined>;
  /** Override CLI argv inspected for `--agent-dir` propagation (defaults to `process.argv.slice(2)`). */
  argv?: readonly string[];
  onWarn?: (msg: string) => void;
}

export interface SubagentChildSpec {
  effectiveModel: string | undefined;
  effectiveProvider: string | undefined;
  /** Pi CLI args up to (not including) `--append-system-prompt` and `Task: ...`. */
  args: string[];
  /** Resolved system prompt text (empty string when absent or empty after conditional evaluation). */
  resolvedPrompt: string;
  /** Environment variables for spawning the child process. */
  env: Record<string, string | undefined>;
}

/**
 * Assemble model/provider, Pi CLI flags, resolved system prompt, and child env
 * for either a sync or async subagent invocation.
 */
export function buildSubagentChildSpec(opts: SubagentChildSpecOptions): SubagentChildSpec {
  const {
    mode,
    agentName,
    agent,
    task,
    cwd,
    persistSession,
    parentModelId,
    parentProvider,
    parentSessionId = "",
    explicit,
    extraEnv,
    onWarn,
  } = opts;

  const { model: effectiveModel, provider: effectiveProvider } = resolveAgentModelProvider(
    agentName,
    agent,
    parentModelId,
    parentProvider,
    cwd,
    explicit,
  );

  const args: string[] = mode === "async"
    ? ["--mode", "json", "-p", "-nc"]
    : ["--mode", "json", "-p"];

  if (!persistSession) {
    args.push("--no-session");
  }

  if (mode === "async") {
    // Deterministic session ID for provider cache affinity + optional session reuse.
    const sessionIdSource = persistSession
      ? `${agentName}:${cwd}:${parentSessionId}`
      : `${agentName}:${task.slice(0, 100)}`;
    args.push("--session-id", `async-${agentName}-${djb2Hash(sessionIdSource).toString(36)}`);
  } else if (persistSession) {
    args.push("--session-id", `sync-${agentName}-${djb2Hash(`${agentName}:${cwd}`).toString(36)}`);
  }

  if (effectiveModel) args.push("--model", effectiveModel);
  if (effectiveProvider) args.push("--provider", effectiveProvider);
  args.push(...trailToolsArgs(agent.tools, cwd));

  let resolvedPrompt = "";
  if (agent.systemPrompt?.trim()) {
    const rendered = resolveAgentSystemPrompt(
      agent.systemPrompt,
      (key) => getSettingDynamic(cwd, key),
      SETTINGS_KEY_NAMES as string[],
      (msg) => {
        if (onWarn) onWarn(msg);
        else log.warn("agent conditional evaluation:", msg);
      },
    );
    if (rendered.trim()) {
      resolvedPrompt = rendered;
    }
  }

  const sessionId = (globalThis as any).__piConfigSessionId || "";
  const baseEnv = withPropagatedPiAgentDirEnv(process.env, opts.argv);
  const env: Record<string, string | undefined> = {
    ...baseEnv,
    PI_MODEL: effectiveModel || undefined,
    PI_SUBAGENT_CHILD: "1",
    PI_AGENT_NAME: agentName,
    PI_PRIMARY_MODEL: process.env.PI_PRIMARY_MODEL || process.env.PI_MODEL || "",
    ...(mode === "async"
      ? {
          // Isolate children from the shared jiti FS cache — other sessions running
          // different node/jiti versions can poison it and kill children at boot.
          JITI_CACHE: "false",
          JITI_FS_CACHE: "false",
        }
      : {}),
    __PI_CONFIG_SESSION_ID: sessionId,
    __PI_PARENT_SESSION_ID: sessionId,
    ...extraEnv,
  };

  log.debug("subagent_child_spec_built", {
    mode,
    agent: agentName,
    model: effectiveModel,
    provider: effectiveProvider,
    persistSession,
    hasPrompt: Boolean(resolvedPrompt),
  });

  return { effectiveModel, effectiveProvider, args, resolvedPrompt, env };
}
