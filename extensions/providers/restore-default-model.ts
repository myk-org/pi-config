/**
 * Cold-start restore of saved default model (#753).
 *
 * pi findInitialModel requires getModel AND hasConfiguredAuth. Native
 * registerNativeProvider does not provisional-configure auth, so a race can
 * leave hasConfiguredAuth false at pick time → wrong initial model.
 * On session_start (providers already registered), restore the saved default
 * when current differs (or is missing), unless the user passed --model /
 * --provider / --models, enabledModels scopes the model list, or the session
 * is fork/reload.
 *
 * Kept free of @earendil-works/pi-ai so unit tests can import under tsx.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../shared/logger.js";

const log = createLogger("providers");

/** session_start reasons where cold-start restore is allowed. */
export const RESTORE_ALLOWED_REASONS = new Set(["startup", "new", "resume"]);

export type RestoreDefaultModelOpts = {
  defaultProvider?: string | null;
  defaultModelId?: string | null;
  currentProvider?: string | null;
  currentModelId?: string | null;
  /** session_start reason; only "startup" | "new" | "resume" may restore. */
  reason?: string | null;
  /**
   * CLI argv to scan for --model / --provider / --models (user override).
   * Defaults to process.argv when omitted in restoreDefaultModelOnSessionStart.
   */
  argv?: string[] | null;
  /**
   * Settings enabledModels — when non-empty, pi scopes the model list the
   * same way as --models; auth-race restore must not override that scope.
   */
  enabledModels?: string[] | null;
};

/** True when argv contains an explicit --model, --provider, or --models flag. */
export function argvHasModelOrProviderOverride(argv: string[] | null | undefined): boolean {
  if (!Array.isArray(argv)) {
    log.debug("argvHasModelOrProviderOverride", { result: false, reason: "not-array" });
    return false;
  }
  const result = argv.some(
    (arg) =>
      arg === "--model" ||
      arg === "--provider" ||
      arg === "--models" ||
      arg.startsWith("--model=") ||
      arg.startsWith("--provider=") ||
      arg.startsWith("--models="),
  );
  log.debug("argvHasModelOrProviderOverride", { result, argvLen: argv.length });
  return result;
}

/** True when settings enabledModels is a non-empty array (scopes like --models). */
export function hasEnabledModelsScope(
  enabledModels: string[] | null | undefined,
): boolean {
  const result = Array.isArray(enabledModels) && enabledModels.length > 0;
  log.debug("hasEnabledModelsScope", {
    result,
    length: Array.isArray(enabledModels) ? enabledModels.length : null,
  });
  return result;
}

/**
 * Whether session_start should call setModel to recover a saved default
 * that findInitialModel missed (auth race → wrong initial model).
 *
 * Gates (all must pass):
 * 1. defaultProvider and defaultModelId both non-empty
 * 2. reason is startup|new|resume
 * 3. current missing OR current provider/id ≠ default
 * 4. argv does not contain --model, --provider, or --models
 * 5. enabledModels is missing or empty (non-empty scopes like --models)
 */
export function shouldRestoreDefaultModel(opts: RestoreDefaultModelOpts): boolean {
  const reason = typeof opts.reason === "string" ? opts.reason.trim() : "";
  if (!RESTORE_ALLOWED_REASONS.has(reason)) {
    return false;
  }

  const provider = typeof opts.defaultProvider === "string"
    ? opts.defaultProvider.trim()
    : "";
  const modelId = typeof opts.defaultModelId === "string"
    ? opts.defaultModelId.trim()
    : "";

  if (!provider || !modelId) return false;

  if (argvHasModelOrProviderOverride(opts.argv)) {
    return false;
  }

  if (hasEnabledModelsScope(opts.enabledModels)) {
    return false;
  }

  const currentProvider = typeof opts.currentProvider === "string"
    ? opts.currentProvider.trim()
    : "";
  const currentModelId = typeof opts.currentModelId === "string"
    ? opts.currentModelId.trim()
    : "";

  if (!currentProvider || !currentModelId) return true;
  return currentProvider !== provider || currentModelId !== modelId;
}

export type PiAgentDefaults = {
  defaultProvider?: string;
  defaultModel?: string;
  /** When non-empty, pi scopes models (same class as --models). */
  enabledModels?: string[];
};

/**
 * Resolve pi agent config directory.
 * Prefer explicit agentDir; else PI_CODING_AGENT_DIR; else ~/.pi/agent.
 * ExtensionContext has cwd but no agentDir — callers should not cast agentDir
 * from ctx; pass agentDir only for tests or explicit override.
 */
export function resolvePiAgentDir(agentDir?: string | null): string {
  const explicit = typeof agentDir === "string" ? agentDir.trim() : "";
  if (explicit) return explicit;
  const envDir = typeof process.env.PI_CODING_AGENT_DIR === "string"
    ? process.env.PI_CODING_AGENT_DIR.trim()
    : "";
  if (envDir) return envDir;
  return join(homedir(), ".pi", "agent");
}

/** Resolve path to settings.json under the agent dir (global settings). */
export function resolvePiAgentSettingsPath(agentDir?: string | null): string {
  return join(resolvePiAgentDir(agentDir), "settings.json");
}

/** Project settings path: `<cwd>/.pi/settings.json`. */
export function resolveProjectPiSettingsPath(cwd: string): string {
  return join(cwd, ".pi", "settings.json");
}

function parseEnabledModels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const models = value
    .filter((m): m is string => typeof m === "string")
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
  return models.length > 0 ? models : [];
}

function parsePiAgentSettingsFile(settingsPath: string): PiAgentDefaults {
  try {
    const raw = readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const defaultProvider = typeof parsed.defaultProvider === "string"
      ? parsed.defaultProvider.trim() || undefined
      : undefined;
    const defaultModel = typeof parsed.defaultModel === "string"
      ? parsed.defaultModel.trim() || undefined
      : undefined;
    const enabledModels = parseEnabledModels(parsed.enabledModels);
    log.debug(
      "readPiAgentDefaults",
      `path=${settingsPath} provider=${defaultProvider ?? "(none)"} ` +
        `model=${defaultModel ?? "(none)"} ` +
        `enabledModels=${enabledModels ? enabledModels.length : "(none)"}`,
    );
    return { defaultProvider, defaultModel, enabledModels };
  } catch (err) {
    log.debug(
      "readPiAgentDefaults skipped",
      `${settingsPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {};
  }
}

/**
 * Merge global (agentDir) + project (cwd/.pi) settings like pi SettingsManager:
 * project wins for defaultProvider / defaultModel / enabledModels.
 */
export function mergePiAgentDefaults(
  globalDefaults: PiAgentDefaults,
  projectDefaults: PiAgentDefaults,
): PiAgentDefaults {
  const merged: PiAgentDefaults = { ...globalDefaults };
  if (projectDefaults.defaultProvider !== undefined) {
    merged.defaultProvider = projectDefaults.defaultProvider;
  }
  if (projectDefaults.defaultModel !== undefined) {
    merged.defaultModel = projectDefaults.defaultModel;
  }
  if (projectDefaults.enabledModels !== undefined) {
    merged.enabledModels = projectDefaults.enabledModels;
  }
  return merged;
}

/**
 * Read defaultProvider / defaultModel / enabledModels from settings.
 * When cwd is set and projectTrusted is true, merges global agentDir settings
 * with project `cwd/.pi/settings.json` (project wins), matching pi SettingsManager.
 * When projectTrusted is false or undefined (fail-closed), reads global only
 * (ignores the project file — same trust gate as SettingsManager).
 * When settingsPath is set without cwd, reads that single file (tests).
 */
export function readPiAgentDefaults(opts?: {
  settingsPath?: string;
  agentDir?: string | null;
  cwd?: string | null;
  /**
   * When true, merge project `.pi/settings.json`. Missing/undefined → false
   * (fail closed). Wire from ctx.isProjectTrusted().
   */
  projectTrusted?: boolean;
} | string): PiAgentDefaults {
  // Back-compat: readPiAgentDefaults(path) for single-file reads (tests).
  if (typeof opts === "string") {
    return parsePiAgentSettingsFile(opts);
  }

  const settingsPath = opts?.settingsPath;
  const cwd = typeof opts?.cwd === "string" ? opts.cwd.trim() : "";
  // Fail closed: missing/undefined projectTrusted → do not read project settings.
  const projectTrusted = opts?.projectTrusted === true;

  if (settingsPath && !cwd) {
    return parsePiAgentSettingsFile(settingsPath);
  }

  const globalPath = settingsPath ?? resolvePiAgentSettingsPath(opts?.agentDir);
  const globalDefaults = parsePiAgentSettingsFile(globalPath);

  if (!cwd) {
    return globalDefaults;
  }

  if (!projectTrusted) {
    log.debug(
      "readPiAgentDefaults untrusted",
      `cwd=${cwd} — ignoring project settings; using global=${globalPath} ` +
        `provider=${globalDefaults.defaultProvider ?? "(none)"} ` +
        `model=${globalDefaults.defaultModel ?? "(none)"}`,
    );
    return globalDefaults;
  }

  const projectPath = resolveProjectPiSettingsPath(cwd);
  const projectDefaults = parsePiAgentSettingsFile(projectPath);
  const merged = mergePiAgentDefaults(globalDefaults, projectDefaults);
  log.debug(
    "readPiAgentDefaults merged",
    `global=${globalPath} project=${projectPath} ` +
      `provider=${merged.defaultProvider ?? "(none)"} ` +
      `model=${merged.defaultModel ?? "(none)"} ` +
      `enabledModels=${merged.enabledModels ? merged.enabledModels.length : "(none)"}`,
  );
  return merged;
}

export type ModelLike = {
  id: string;
  provider: string;
};

export type ModelRegistryLike = {
  find?: (provider: string, modelId: string) => ModelLike | undefined;
  getAvailable?: () => ModelLike[];
};

/**
 * Resolve provider+id from a model registry (find preferred; getAvailable fallback).
 * getAvailable is auth-filtered — never use it alone for hopeless detection.
 */
export function resolveDefaultModel(
  registry: ModelRegistryLike | undefined | null,
  provider: string,
  modelId: string,
): ModelLike | undefined {
  if (!registry) return undefined;
  if (typeof registry.find === "function") {
    const found = registry.find(provider, modelId);
    if (found) return found;
  }
  if (typeof registry.getAvailable === "function") {
    try {
      return registry.getAvailable().find(
        (m) => m.provider === provider && m.id === modelId,
      );
    } catch (err) {
      log.warn(
        "resolveDefaultModel getAvailable threw",
        err instanceof Error ? err.message : String(err),
      );
      return undefined;
    }
  }
  return undefined;
}

/**
 * True when restore should stop — only when registeredProviders is an array
 * that does not include the default provider (including empty array).
 *
 * Optional / tests only. Production omits registeredProviders and relies on
 * find + setModel retries (warn on exhaust). Never pass a cli/acpx-only list.
 *
 * NEVER treat getAvailable missing the target as hopeless: getAvailable only
 * returns auth-ready providers. During the #753 race a provider may be
 * registered but not yet in configuredProviders while another IS in
 * getAvailable — that must keep retrying setModel.
 * registry/modelId are unused (API compat for callers).
 */
export function isRestoreModelHopeless(
  _registry: ModelRegistryLike | undefined | null,
  provider: string,
  _modelId: string,
  registeredProviders?: string[] | null,
): boolean {
  if (Array.isArray(registeredProviders) && !registeredProviders.includes(provider)) {
    log.debug(
      "isRestoreModelHopeless",
      `registeredProviders lack ${provider} ` +
        `(count=${registeredProviders.length})`,
    );
    return true;
  }
  return false;
}

export type RestoreSessionCtx = {
  model?: ModelLike | undefined;
  modelRegistry?: ModelRegistryLike;
};

/** Shorter retry window; optional registeredProviders fail-fast for tests. */
export const RESTORE_DEFAULT_MODEL_RETRIES = 5;
/** Delay between restore attempts (ms). */
export const RESTORE_DEFAULT_MODEL_DELAY_MS = 100;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function trimModelRef(
  model: { provider?: string | null; id?: string | null } | undefined | null,
): { provider: string; id: string } | undefined {
  const provider = typeof model?.provider === "string" ? model.provider.trim() : "";
  const id = typeof model?.id === "string" ? model.id.trim() : "";
  if (!provider || !id) return undefined;
  return { provider, id };
}

/**
 * If settings have a default and current model differs (or is missing),
 * resolve and setModel. Retries briefly when the model is not yet resolvable
 * or setModel returns false (stale hasConfiguredAuth).
 * Fail-fast only when registeredProviders is an array lacking the default
 * provider (including empty) — optional; production omits it for agnostic
 * restore. getAvailable must not drive hopelessness.
 * Skips when argv contains --model, --provider, or --models, or when
 * enabledModels is a non-empty array (scoped models).
 * Before each attempt, optional getCurrentModel aborts if already at default
 * or the user switched (snapshot mismatch). When session_start had no model,
 * track the first non-default live model seen mid-flight and only abort if
 * it later *changes* (first sighting alone is not user intent).
 * Re-checks immediately before setModel (TOCTOU).
 * Returns true when setModel succeeded.
 */
export async function restoreDefaultModelOnSessionStart(opts: {
  ctx: RestoreSessionCtx;
  setModel: (model: ModelLike) => Promise<boolean>;
  settingsPath?: string;
  agentDir?: string | null;
  /** Project cwd — merges cwd/.pi/settings.json over global when trusted. */
  cwd?: string | null;
  /**
   * When true, merge project settings. Missing/undefined → false (fail closed).
   * Wire from ctx.isProjectTrusted() — same gate as pi SettingsManager.
   */
  projectTrusted?: boolean;
  reason?: string;
  /**
   * Optional provider ids for fail-fast (tests). Production should omit —
   * do not pass a cli/acpx-only list (breaks native default restore).
   */
  registeredProviders?: string[];
  /** Total attempts (default 5). Injectable for tests. */
  retries?: number;
  /** Delay between attempts in ms (default 100). Injectable for tests. */
  delayMs?: number;
  /** Sleep implementation (default setTimeout). Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** CLI argv for --model/--provider/--models skip (default process.argv). */
  argv?: string[];
  /**
   * Live current model (e.g. () => ctx.model). Re-checked before each attempt
   * and immediately before setModel; abort if already at default or user
   * switched away from the session_start snapshot (or changed mid-flight
   * selection when there was no initial snapshot).
   */
  getCurrentModel?: () => { provider: string; id: string } | undefined;
}): Promise<boolean> {
  const {
    defaultProvider,
    defaultModel,
    enabledModels,
  } = readPiAgentDefaults({
    settingsPath: opts.settingsPath,
    agentDir: opts.agentDir,
    cwd: opts.cwd,
    projectTrusted: opts.projectTrusted,
  });
  const current = opts.ctx.model;
  const currentProvider = current?.provider;
  const currentModelId = current?.id;
  const argv = opts.argv ?? process.argv;
  const argvOverride = argvHasModelOrProviderOverride(argv);
  const enabledModelsScope = hasEnabledModelsScope(enabledModels);

  if (!shouldRestoreDefaultModel({
    defaultProvider,
    defaultModelId: defaultModel,
    currentProvider,
    currentModelId,
    reason: opts.reason,
    argv,
    enabledModels,
  })) {
    log.debug(
      "restore-default-model skip",
      `reason=${opts.reason ?? "?"} default=${defaultProvider ?? "?"}/${defaultModel ?? "?"} ` +
        `current=${currentProvider ?? "?"}/${currentModelId ?? "?"} ` +
        `argvOverride=${argvOverride} enabledModelsScope=${enabledModelsScope}` +
        (enabledModelsScope ? ` enabledModels=${enabledModels!.length}` : ""),
    );
    return false;
  }

  const retries = opts.retries ?? RESTORE_DEFAULT_MODEL_RETRIES;
  const delayMs = opts.delayMs ?? RESTORE_DEFAULT_MODEL_DELAY_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const label = `${defaultProvider}/${defaultModel}`;
  let lastFailReason = "unknown";
  const snapshot = trimModelRef({
    provider: currentProvider,
    id: currentModelId,
  });
  /** First non-default live model seen when snapshot was empty — baseline for change detection. */
  let firstSeenLive: { provider: string; id: string } | undefined;

  if (
    isRestoreModelHopeless(
      opts.ctx.modelRegistry,
      defaultProvider!,
      defaultModel!,
      opts.registeredProviders,
    )
  ) {
    const count = Array.isArray(opts.registeredProviders)
      ? opts.registeredProviders.length
      : 0;
    log.warn(
      "restore-default-model fail-fast",
      `registeredProviders lack ${defaultProvider} (count=${count}): ${label} ` +
        `(session_start reason=${opts.reason ?? "?"})`,
    );
    return false;
  }

  /** Abort if live already matches default or user switched mid-retry. */
  const shouldAbortForLiveModel = (
    live: { provider: string; id: string } | undefined,
    attempt: number,
    phase: "pre-resolve" | "pre-setModel",
  ): boolean => {
    if (!live) return false;
    if (live.provider === defaultProvider && live.id === defaultModel) {
      log.debug(
        "restore-default-model abort",
        `already at default ${label} (${phase} attempt ${attempt}/${retries})`,
      );
      return true;
    }
    if (snapshot) {
      if (live.provider !== snapshot.provider || live.id !== snapshot.id) {
        log.debug(
          "restore-default-model abort",
          `current changed from session_start snapshot ` +
            `${snapshot.provider}/${snapshot.id} → ${live.provider}/${live.id} ` +
            `(${phase} attempt ${attempt}/${retries})`,
        );
        return true;
      }
    } else {
      // Empty snapshot: first non-default live model is baseline, not abort.
      // Only abort when live later *changes* from that mid-flight selection.
      if (!firstSeenLive) {
        firstSeenLive = live;
        log.debug(
          "restore-default-model baseline",
          `no session_start snapshot; first live=${live.provider}/${live.id} ` +
            `(${phase} attempt ${attempt}/${retries})`,
        );
        return false;
      }
      if (
        live.provider !== firstSeenLive.provider ||
        live.id !== firstSeenLive.id
      ) {
        log.debug(
          "restore-default-model abort",
          `no session_start snapshot; live changed ` +
            `${firstSeenLive.provider}/${firstSeenLive.id} → ${live.provider}/${live.id} ` +
            `(${phase} attempt ${attempt}/${retries})`,
        );
        return true;
      }
    }
    return false;
  };

  for (let attempt = 1; attempt <= retries; attempt++) {
    if (typeof opts.getCurrentModel === "function") {
      const live = trimModelRef(opts.getCurrentModel());
      if (shouldAbortForLiveModel(live, attempt, "pre-resolve")) {
        return false;
      }
    }

    const model = resolveDefaultModel(
      opts.ctx.modelRegistry,
      defaultProvider!,
      defaultModel!,
    );
    if (!model) {
      lastFailReason = `model not resolvable: ${label}`;
      log.debug(
        "restore-default-model retry",
        `${lastFailReason} (attempt ${attempt}/${retries})`,
      );
      if (attempt < retries) await sleep(delayMs);
      continue;
    }

    // TOCTOU: re-check immediately before setModel after resolve.
    if (typeof opts.getCurrentModel === "function") {
      const liveBeforeSet = trimModelRef(opts.getCurrentModel());
      if (shouldAbortForLiveModel(liveBeforeSet, attempt, "pre-setModel")) {
        return false;
      }
    }

    try {
      const ok = await opts.setModel(model);
      if (ok) {
        log.info(
          "restore-default-model",
          `restored ${label} ` +
            `(was ${currentProvider ?? "none"}/${currentModelId ?? "none"}; ` +
            `session_start reason=${opts.reason ?? "?"}; attempt ${attempt}/${retries})`,
        );
        return true;
      }
      lastFailReason = `setModel returned false for ${label}`;
      log.debug(
        "restore-default-model retry",
        `${lastFailReason} (attempt ${attempt}/${retries})`,
      );
    } catch (err) {
      lastFailReason = err instanceof Error ? err.message : String(err);
      log.debug(
        "restore-default-model retry",
        `setModel threw: ${lastFailReason} (attempt ${attempt}/${retries})`,
      );
    }
    if (attempt < retries) await sleep(delayMs);
  }

  log.warn(
    "restore-default-model exhausted",
    `${lastFailReason} after ${retries} attempts ` +
      `(session_start reason=${opts.reason ?? "?"})`,
  );
  return false;
}
