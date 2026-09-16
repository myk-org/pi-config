import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { createLogger } from "../shared/logger.js";
import {
  discoveredIdFromRuntimeModelId,
  isCliOrAcpxProvider,
  thinkingLevelFromDiscoveredId,
} from "../shared/models-dev.js";
import { resolvePiAgentDir } from "./restore-default-model.js";

const log = createLogger("providers");
const STATE_VERSION = 2;

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
export type ThinkingLevelState = {
  version: 2;
  fallback?: SavedThinkingLevel;
  models: Record<string, SavedThinkingLevel>;
};

type RuntimeModel = Pick<Model<any>, "id" | "provider" | "reasoning" | "thinkingLevelMap">;

export function isThinkingLevel(value: unknown): value is SavedThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

export function modelThinkingKey(model: { id?: unknown; provider?: unknown } | undefined): string | undefined {
  if (typeof model?.provider !== "string" || typeof model.id !== "string") return undefined;
  return `${model.provider}/${model.id}`;
}

export function resolveThinkingLevelStatePath(agentDir?: string | null): string {
  return join(resolvePiAgentDir(agentDir), "state", "last-thinking-level.json");
}

function emptyState(fallback?: SavedThinkingLevel): ThinkingLevelState {
  return { version: STATE_VERSION, ...(fallback ? { fallback } : {}), models: Object.create(null) };
}

export function readThinkingLevelState(
  statePath = resolveThinkingLevelStatePath(),
): ThinkingLevelState {
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      log.warn("thinking preference state ignored invalid root", { statePath });
      return emptyState();
    }

    const input = parsed as { version?: unknown; level?: unknown; fallback?: unknown; models?: unknown };
    if (isThinkingLevel(input.level)) {
      log.info("thinking preference state loaded legacy fallback", { statePath });
      return emptyState(input.level);
    }

    const state = emptyState(isThinkingLevel(input.fallback) ? input.fallback : undefined);
    if (input.version !== STATE_VERSION || !input.models || typeof input.models !== "object" || Array.isArray(input.models)) {
      log.warn("thinking preference state ignored invalid schema", { statePath, version: input.version });
      return state;
    }
    for (const [key, level] of Object.entries(input.models)) {
      if (key && isThinkingLevel(level)) state.models[key] = level;
    }
    log.debug("thinking preference state loaded", {
      statePath,
      modelCount: Object.keys(state.models).length,
      hasFallback: state.fallback !== undefined,
    });
    return state;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") log.warn("thinking preference state read failed", { statePath }, err);
    return emptyState();
  }
}

export function readLastThinkingLevel(
  statePath = resolveThinkingLevelStatePath(),
): SavedThinkingLevel | undefined {
  const level = readThinkingLevelState(statePath).fallback;
  log.debug("thinking preference fallback read", { statePath, level });
  return level;
}

export function writeThinkingLevelState(
  state: ThinkingLevelState,
  statePath = resolveThinkingLevelStatePath(),
): boolean {
  const dir = dirname(statePath);
  const tmp = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    writeFileSync(tmp, `${JSON.stringify(state)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(tmp, statePath);
    chmodSync(statePath, 0o600);
    log.debug("thinking preference state persisted", {
      statePath,
      modelCount: Object.keys(state.models).length,
      hasFallback: state.fallback !== undefined,
    });
    return true;
  } catch (err) {
    rmSync(tmp, { force: true });
    log.warn("thinking preference state persist failed", { statePath }, err);
    return false;
  }
}

export function writeLastThinkingLevel(
  level: unknown,
  statePath = resolveThinkingLevelStatePath(),
): boolean {
  if (!isThinkingLevel(level)) {
    log.warn("thinking preference fallback not persisted: invalid level", { level });
    return false;
  }
  const state = readThinkingLevelState(statePath);
  state.fallback = level;
  log.debug("thinking preference fallback queued", { statePath, level });
  return writeThinkingLevelState(state, statePath);
}

export type ThinkingRestoreContext = {
  model?: RuntimeModel;
  sessionManager?: { getEntries?: () => Array<{ type?: string; customType?: string }> };
};

function hasExplicitThinkingArg(argv: string[]): boolean {
  const explicit = argv.some((arg, index) => arg === "--thinking" && argv[index + 1] !== undefined)
    || argv.some(arg => arg.startsWith("--thinking="));
  log.debug("thinking preference CLI override checked", { explicit });
  return explicit;
}

function hasEncodedThinking(model: RuntimeModel | undefined): boolean {
  const encoded = !!model?.id
    && isCliOrAcpxProvider(String(model.provider))
    && thinkingLevelFromDiscoveredId(discoveredIdFromRuntimeModelId(model.id)) !== undefined;
  log.debug("thinking preference encoded model checked", {
    model: modelThinkingKey(model),
    encoded,
  });
  return encoded;
}

function hasSessionThinkingState(ctx: ThinkingRestoreContext): boolean {
  const statefulEntryTypes = new Set([
    "message", "custom_message", "compaction", "branch_summary",
    "thinking_level_change", "model_change",
  ]);
  const present = ctx.sessionManager?.getEntries?.().some(entry => statefulEntryTypes.has(entry.type ?? "")) === true;
  log.debug("thinking preference session state checked", { present });
  return present;
}

export function shouldRestoreLastThinkingLevel(opts: {
  reason?: string;
  ctx: ThinkingRestoreContext;
  argv?: string[];
}): boolean {
  const fresh = opts.reason === "new"
    || (opts.reason === "startup" && !hasSessionThinkingState(opts.ctx));
  const restore = fresh
    && opts.ctx.model?.reasoning === true
    && !hasExplicitThinkingArg(opts.argv ?? process.argv)
    && !hasEncodedThinking(opts.ctx.model);
  log.debug("thinking preference lifecycle restore checked", {
    reason: opts.reason,
    model: modelThinkingKey(opts.ctx.model),
    restore,
  });
  return restore;
}

function preferredLevel(
  model: RuntimeModel,
  state: ThinkingLevelState,
): SavedThinkingLevel | undefined {
  const key = modelThinkingKey(model);
  const level = key ? state.models[key] ?? state.fallback : state.fallback;
  log.debug("thinking preference resolved", { model: key, level, exact: !!key && state.models[key] !== undefined });
  return level;
}

function clampSavedThinkingLevel(model: RuntimeModel, level: SavedThinkingLevel): SavedThinkingLevel {
  const available = THINKING_LEVELS.filter((candidate) => {
    const mapped = model.thinkingLevelMap?.[candidate];
    return mapped !== null && ((candidate !== "xhigh" && candidate !== "max") || mapped !== undefined);
  });
  if (available.includes(level)) return level;
  const requested = THINKING_LEVELS.indexOf(level);
  return available.find(candidate => THINKING_LEVELS.indexOf(candidate) > requested)
    ?? available.findLast(candidate => THINKING_LEVELS.indexOf(candidate) < requested)
    ?? "off";
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
  setInternalThinkingLevel: (level: ThinkingLevel) => void;
} {
  let generation = 0;
  let activeModelKey: string | undefined;
  let preserveSessionLevel = false;
  const suppressedEvents: Array<{ model: string | undefined; level: SavedThinkingLevel }> = [];

  const setInternalThinkingLevel = (level: ThinkingLevel): void => {
    const model = activeModelKey;
    suppressedEvents.push({ model, level });
    pi.setThinkingLevel(level);
    log.debug("thinking preference internal level requested", { model, level });
  };

  const applyPreference = (model: RuntimeModel | undefined, reason: string): boolean => {
    const key = modelThinkingKey(model);
    if (!model || model.reasoning !== true || !key || hasEncodedThinking(model)) {
      log.debug("thinking preference model restore skipped", { model: key, reason, reasoning: model?.reasoning === true });
      return false;
    }
    const requested = preferredLevel(model, readThinkingLevelState(opts.statePath));
    if (!requested) return false;
    const effective = clampSavedThinkingLevel(model, requested);
    if (pi.getThinkingLevel() === effective) return false;
    setInternalThinkingLevel(effective as ThinkingLevel);
    log.info("thinking preference restored", { model: key, requested, effective, reason });
    return true;
  };

  pi.on("session_start", (event, ctx) => {
    activeModelKey = modelThinkingKey(ctx.model);
    preserveSessionLevel = hasExplicitThinkingArg(opts.argv ?? process.argv)
      || event.reason === "reload"
      || event.reason === "resume"
      || event.reason === "fork"
      || hasEncodedThinking(ctx.model)
      || (event.reason === "startup" && hasSessionThinkingState(ctx));
    log.debug("thinking preference session tracking reset", {
      reason: event.reason,
      model: activeModelKey,
      preserveSessionLevel,
      generation,
    });
  });

  pi.on("thinking_level_select", (event, ctx) => {
    const currentModelKey = modelThinkingKey(ctx.model);
    const suppressedIndex = suppressedEvents.findIndex(item =>
      item.model === currentModelKey && item.level === event.level,
    );
    if (suppressedIndex >= 0) {
      suppressedEvents.splice(suppressedIndex, 1);
      log.debug("thinking preference ignored internal change", {
        model: currentModelKey,
        level: event.level,
      });
      return;
    }
    if (currentModelKey !== activeModelKey) {
      log.debug("thinking preference ignored automatic change", {
        activeModel: activeModelKey,
        currentModel: currentModelKey,
        level: event.level,
      });
      return;
    }
    if (!isThinkingLevel(event.level) || !currentModelKey) {
      log.warn("thinking preference ignored invalid explicit change", { model: currentModelKey, level: event.level });
      return;
    }
    const state = readThinkingLevelState(opts.statePath);
    state.fallback = event.level;
    state.models[currentModelKey] = event.level;
    generation += 1;
    writeThinkingLevelState(state, opts.statePath);
    log.info("thinking preference saved explicit change", { model: currentModelKey, level: event.level, generation });
  });

  pi.on("model_select", (event, ctx) => {
    const selectedKey = modelThinkingKey(event.model);
    const currentKey = modelThinkingKey(ctx.model);
    if (selectedKey !== currentKey) {
      log.debug("thinking preference ignored stale model event", {
        selectedModel: selectedKey,
        currentModel: currentKey,
        source: event.source,
      });
      return;
    }
    activeModelKey = selectedKey;
    generation += 1;
    if (event.source === "restore" || preserveSessionLevel) {
      log.debug("thinking preference model event preserved session level", {
        model: selectedKey,
        source: event.source,
        generation,
      });
      return;
    }
    applyPreference(event.model as RuntimeModel, `model_${event.source}`);
  });

  const applyAfterModelRestore = async (
    event: { reason?: string },
    ctx: ThinkingRestoreContext,
    modelRestore: Promise<unknown>,
  ): Promise<boolean> => {
    activeModelKey = modelThinkingKey(ctx.model);
    const startGeneration = generation;
    await modelRestore.catch(() => undefined);
    const key = modelThinkingKey(ctx.model);
    if (generation !== startGeneration) {
      log.debug("thinking preference startup restore ignored stale work", {
        reason: event.reason,
        model: key,
        startGeneration,
        generation,
      });
      return false;
    }
    activeModelKey = key;

    if (!shouldRestoreLastThinkingLevel({ reason: event.reason, ctx, argv: opts.argv })) {
      log.debug("thinking preference startup restore skipped", { reason: event.reason, model: key });
      return false;
    }
    return applyPreference(ctx.model, `session_${event.reason ?? "unknown"}`);
  };

  return { applyAfterModelRestore, setInternalThinkingLevel };
}
