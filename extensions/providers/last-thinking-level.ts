import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { createLogger } from "../shared/logger.js";
import {
  discoveredIdFromRuntimeModelId,
  isCliOrAcpxProvider,
  thinkingLevelFromDiscoveredId,
} from "../shared/models-dev.js";
import { argvHasModelOrProviderOverride, resolvePiAgentDir } from "./restore-default-model.js";

const log = createLogger("providers");

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type SavedThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(value: unknown): value is SavedThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

export function resolveThinkingLevelStatePath(agentDir?: string | null): string {
  return join(resolvePiAgentDir(agentDir), "state", "last-thinking-level.json");
}

export function readLastThinkingLevel(statePath = resolveThinkingLevelStatePath()): SavedThinkingLevel | undefined {
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as { level?: unknown };
    if (isThinkingLevel(parsed.level)) return parsed.level;
    log.warn("last-thinking-level ignored invalid state", { statePath });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") log.warn("last-thinking-level read failed", { statePath }, err);
  }
  return undefined;
}

export function writeLastThinkingLevel(
  level: unknown,
  statePath = resolveThinkingLevelStatePath(),
): boolean {
  if (!isThinkingLevel(level)) {
    log.warn("last-thinking-level not persisted: invalid level", { level });
    return false;
  }

  const dir = dirname(statePath);
  const tmp = `${statePath}.${process.pid}.tmp`;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(tmp, `${JSON.stringify({ level })}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, statePath);
    chmodSync(statePath, 0o600);
    log.debug("last-thinking-level persisted", { level, statePath });
    return true;
  } catch (err) {
    rmSync(tmp, { force: true });
    log.warn("last-thinking-level persist failed", { statePath }, err);
    return false;
  }
}

export type ThinkingRestoreContext = {
  model?: { id?: string; provider?: unknown; reasoning?: unknown };
  sessionManager?: { getEntries?: () => Array<{ type?: string; customType?: string }> };
};

export function shouldRestoreLastThinkingLevel(opts: {
  reason?: string;
  ctx: ThinkingRestoreContext;
  argv?: string[];
}): boolean {
  if (opts.reason !== "startup" && opts.reason !== "new") return false;
  const model = opts.ctx.model;
  if (model?.reasoning !== true) return false;
  if (argvHasModelOrProviderOverride(opts.argv ?? process.argv)) return false;
  const provider = typeof model.provider === "string" ? model.provider : "";
  if (
    model.id &&
    isCliOrAcpxProvider(provider) &&
    thinkingLevelFromDiscoveredId(discoveredIdFromRuntimeModelId(model.id))
  ) return false;

  // Extension metadata may be appended before this handler. Only entries that
  // restore conversation/model state make a cold startup an existing session.
  const statefulEntryTypes = new Set([
    "message", "custom_message", "compaction", "branch_summary",
    "thinking_level_change", "model_change",
  ]);
  if (opts.reason === "startup" && opts.ctx.sessionManager?.getEntries?.().some(entry => statefulEntryTypes.has(entry.type ?? ""))) return false;
  return true;
}

export function registerLastThinkingLevel(
  pi: ExtensionAPI,
  opts: { statePath?: string; argv?: string[] } = {},
): {
  applyAfterModelRestore: (
    event: { reason?: string },
    ctx: ThinkingRestoreContext,
    modelRestore: Promise<unknown>,
  ) => Promise<boolean>;
  runInternal: <T>(fn: () => T) => T;
} {
  let changeGeneration = 0;
  let internalChange = false;

  pi.on("thinking_level_select", (event) => {
    if (internalChange) {
      log.debug("last-thinking-level ignored internal change", { level: event.level });
      return;
    }
    changeGeneration += 1;
    writeLastThinkingLevel(event.level, opts.statePath);
  });

  const runInternal = <T>(fn: () => T): T => {
    internalChange = true;
    try {
      return fn();
    } finally {
      internalChange = false;
    }
  };

  const applyAfterModelRestore = async (
    event: { reason?: string },
    ctx: ThinkingRestoreContext,
    modelRestore: Promise<unknown>,
  ): Promise<boolean> => {
    const generationAtStart = changeGeneration;
    await modelRestore.catch(() => undefined);

    if (!shouldRestoreLastThinkingLevel({
      reason: event.reason,
      ctx,
      argv: opts.argv,
    })) {
      log.debug("last-thinking-level restore skipped", {
        reason: event.reason,
        reasoning: ctx.model?.reasoning === true,
      });
      return false;
    }
    if (changeGeneration !== generationAtStart) {
      log.info("last-thinking-level restore skipped: level changed during startup");
      return false;
    }

    const level = readLastThinkingLevel(opts.statePath);
    if (!level || pi.getThinkingLevel() === level) return false;
    runInternal(() => pi.setThinkingLevel(level as ThinkingLevel));
    log.info("last-thinking-level restored", { level, reason: event.reason });
    return true;
  };

  return { applyAfterModelRestore, runInternal };
}
