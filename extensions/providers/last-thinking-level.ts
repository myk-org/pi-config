import {
  chmodSync,
  mkdirSync,
  statSync,
  unlinkSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
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
  const key = typeof model?.provider === "string" && typeof model.id === "string"
    ? `${model.provider}/${model.id}` : undefined;
  log.debug("thinking preference model key resolved", { model: key, valid: key !== undefined });
  return key;
}

export function resolveThinkingLevelStatePath(agentDir?: string | null): string {
  return join(resolvePiAgentDir(agentDir), "state", "last-thinking-level.json");
}

function emptyState(fallback?: SavedThinkingLevel): ThinkingLevelState {
  log.debug("thinking preference empty state created", { hasFallback: fallback !== undefined });
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
    try { rmSync(tmp, { force: true }); } catch { /* retain original persistence failure */ }
    log.error("thinking preference state persist failed", { statePath }, err);
    return false;
  }
}

const lockSleep = new Int32Array(new SharedArrayBuffer(4));

function updateThinkingLevelState(statePath: string, update: (state: ThinkingLevelState) => void): boolean {
  const lockPath = `${statePath}.lock`;
  let db: DatabaseSync | undefined;
  let locked = false;
  try {
    mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
    chmodSync(dirname(statePath), 0o700);
    // SQLite's BEGIN IMMEDIATE serializes all writers, including simultaneous stale-lock reclaimers.
    // Unlike unlinking a lock pathname, no contender can remove another contender's ownership.
    db = new DatabaseSync(`${statePath}.lock.sqlite`, { timeout: 5000 });
    chmodSync(`${statePath}.lock.sqlite`, 0o600);
    db.exec("BEGIN IMMEDIATE");
    locked = true;
    const deadline = Date.now() + 5000;
    while (true) {
      let pid: number;
      let age: number;
      try {
        pid = Number(readFileSync(lockPath, "utf8"));
        age = Date.now() - statSync(lockPath).mtimeMs;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") break;
        throw err;
      }
      let alive = false;
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); alive = true; }
        catch (err) { if ((err as NodeJS.ErrnoException).code !== "ESRCH") alive = true; }
      }
      if (!alive && age > 1000) {
        unlinkSync(lockPath); // Only the transaction holder may reclaim a legacy lock.
        break;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out acquiring thinking preference lock: ${lockPath}`);
      Atomics.wait(lockSleep, 0, 0, 20);
    }
    const state = readThinkingLevelState(statePath);
    update(state);
    const saved = writeThinkingLevelState(state, statePath);
    log.debug("thinking preference locked update completed", { statePath, saved });
    return saved;
  } catch (err) {
    log.error("thinking preference locked update failed", { statePath }, err);
    return false;
  } finally {
    if (locked) db?.exec("ROLLBACK");
    db?.close();
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
  return updateThinkingLevelState(statePath, state => { state.fallback = level; });
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
  const requested = THINKING_LEVELS.indexOf(level);
  const effective = available.includes(level) ? level
    : available.find(candidate => THINKING_LEVELS.indexOf(candidate) > requested)
      ?? available.findLast(candidate => THINKING_LEVELS.indexOf(candidate) < requested)
      ?? "off";
  log.debug("thinking preference level clamped", { model: modelThinkingKey(model), requested: level, effective });
  return effective;
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
  restoreModel: (model: Model<any>, setModel: (model: Model<any>) => Promise<boolean>) => Promise<boolean>;
} {
  let generation = 0;
  let activeModelKey: string | undefined;
  let preserveCliLevel = false;
  let modelEventGeneration = 0;
  let lastModelEvent: { key: string | undefined; source: string; fromDefaultRestore: boolean } | undefined;
  let defaultRestoreKey: string | undefined;
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
    preserveCliLevel = hasExplicitThinkingArg(opts.argv ?? process.argv);
    log.debug("thinking preference session tracking reset", {
      reason: event.reason,
      model: activeModelKey,
      preserveCliLevel,
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
    generation += 1;
    const saved = updateThinkingLevelState(opts.statePath ?? resolveThinkingLevelStatePath(), state => {
      state.fallback = event.level;
      state.models[currentModelKey] = event.level;
    });
    log.info("thinking preference explicit change handled", { model: currentModelKey, level: event.level, generation, saved });
  });

  const restoreModel = async (model: Model<any>, setModel: (model: Model<any>) => Promise<boolean>): Promise<boolean> => {
    defaultRestoreKey = modelThinkingKey(model);
    try {
      const restored = await setModel(model);
      log.debug("thinking preference default model set completed", { model: defaultRestoreKey, restored });
      return restored;
    } finally {
      defaultRestoreKey = undefined;
    }
  };

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
    modelEventGeneration = generation;
    lastModelEvent = { key: selectedKey, source: event.source, fromDefaultRestore: event.source === "set" && selectedKey === defaultRestoreKey };
    if (event.source === "restore" || selectedKey === defaultRestoreKey || preserveCliLevel || hasEncodedThinking(event.model as RuntimeModel)) {
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
    const restored = await modelRestore.catch(() => false);
    const key = modelThinkingKey(ctx.model);
    const expectedRestoreEvent = restored === true
      && generation === startGeneration + 1
      && modelEventGeneration === generation
      && lastModelEvent?.fromDefaultRestore === true
      && lastModelEvent.key === key;
    if (generation !== startGeneration && !expectedRestoreEvent) {
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

  return { applyAfterModelRestore, setInternalThinkingLevel, restoreModel };
}
