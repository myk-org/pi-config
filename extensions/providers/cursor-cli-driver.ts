/**
 * CursorCliDriver — ProviderDriver for the Cursor Agent CLI.
 *
 * Most complex CLI driver — owns session management (markers, resume
 * recovery, history seeding), model discovery via --list-models, and
 * stream-json parsing.
 *
 * Reuses existing modules:
 * - cli-provider/agents/cursor.ts — discovery (parseAgentListModels)
 * - cli-provider/runner.ts — process spawning
 * - cli-provider/sessions.ts — full session marker management
 * - cli-provider/parsers.ts — output parsing
 * - shared/build-system-prompt.ts — system prompt injection
 *
 * @module providers/cursor-cli-driver
 */

import type {
  ConfigSchema,
  DiscoveredModel,
  ProviderAdapterShape,
  ProviderDriver,
  ProviderDriverCreateInput,
  ProviderInstance,
  ProviderProbeResult,
  SessionHandle,
  SessionStartOptions,
  TurnOptions,
  TurnResult,
} from "../shared/provider-driver.js";
import { makeManagedSnapshot, buildInitialSnapshot } from "../shared/managed-refresh.js";
import { resolveBinary } from "../shared/resolve-binary.js";
import { discoverCliModelsDetailed } from "../cli-provider/discover.js";
import { runCliAgent } from "../cli-provider/runner.js";
import {
  loadCliSessionId,
  saveCliSessionId,
  clearCliSessionId,
  applySystemPromptToCliPrompt,
  shouldRetryWithoutResume,
  createProvisionalPiSessionId,
  isProvisionalPiSessionId,
  migrateCliSessionMarker,
  migrateAllCliSessionMarkers,
  shouldAdoptLegacyCliMarker,
  resolveCliHistorySeed,
  touchCliSession,
  clearCliSessionsForPiSession,
  readPiSessionIdFromManager,
  resolveActivePiSessionIdOnSessionStart,
  decideCliSessionStartReseed,
  type CliSessionKey,
} from "../cli-provider/sessions.js";
import { buildExternalSystemPrompt } from "../shared/build-system-prompt.js";
import { fileLog } from "../shared/file-logger.js";
import { resolveAdapterCwd, adapterMemoryKey, deleteKeysForCwd } from "../shared/session-cwd.js";

const LOG_DOMAIN = "cursor-cli-driver";
const DRIVER_KIND = "cursor-cli";

/**
 * Per-turn history reseed. Cwd-scoped `session_start` must not force a fresh
 * CLI session on a different workspace. `forceHistorySeedGlobal` is only
 * `setForceHistorySeed()` (explicit adapter-wide override).
 */
export function cursorTurnNeedsHistorySeed(
  turnCwd: string,
  forceHistorySeedCwds: ReadonlySet<string>,
  forceHistorySeedGlobal: boolean,
): boolean {
  const cwdListed = forceHistorySeedCwds.has(turnCwd);
  const needed = forceHistorySeedGlobal || cwdListed;
  fileLog(LOG_DOMAIN, "debug", LOG_DOMAIN,
    `cursorTurnNeedsHistorySeed cwd=${turnCwd} global=${forceHistorySeedGlobal} cwdListed=${cwdListed} needed=${needed}`);
  return needed;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface CursorCliConfig {
  readonly binary: string;
  readonly enabled: boolean;
}

const cursorCliConfigSchema: ConfigSchema<CursorCliConfig> = {
  parse: (raw: unknown): CursorCliConfig => {
    if (!raw || typeof raw !== "object") {
      return { binary: "agent", enabled: true };
    }
    const obj = raw as Record<string, unknown>;
    return {
      binary: typeof obj.binary === "string" ? obj.binary : "agent",
      enabled: typeof obj.enabled === "boolean" ? obj.enabled : true,
    };
  },
};

// ---------------------------------------------------------------------------
// History seeding (from original cli-provider)
// ---------------------------------------------------------------------------

function messageText(msg: { role: string; content: unknown }): string {
  if (typeof msg.content === "string") return msg.content;
  if (!Array.isArray(msg.content)) return "";
  const textParts: string[] = [];
  for (const block of msg.content) {
    if (
      block &&
      typeof block === "object" &&
      "text" in block &&
      typeof (block as { text: unknown }).text === "string"
    ) {
      textParts.push((block as { text: string }).text);
    }
  }
  return textParts.join("\n");
}

/**
 * When starting a NEW CLI session (no --resume), inject prior pi turns so
 * switching mid-session does not drop conversation history.
 */
function buildPromptWithHistory(
  messages: Array<{ role: string; content: unknown }>,
  latest: string,
  hasCliSession: boolean,
): string {
  if (hasCliSession) return latest;

  const prior: string[] = [];
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUser = i;
      break;
    }
  }
  for (let i = 0; i < lastUser; i++) {
    const msg = messages[i];
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const text = messageText(msg).trim();
    if (!text) continue;
    const clipped =
      text.length > 4000 ? `${text.slice(0, 4000)}\n…[truncated]` : text;
    prior.push(`${msg.role === "user" ? "User" : "Assistant"}: ${clipped}`);
  }

  if (prior.length === 0) return latest;

  return [
    "Prior conversation in this pi session (for context — continue from here):",
    "",
    ...prior,
    "",
    "---",
    "",
    "Current user message:",
    latest,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

function createCursorCliAdapter(
  config: CursorCliConfig,
  cwd: string,
  instanceId: string,
): ProviderAdapterShape & {
  /** Bind the real pi session UUID (from sessionManager). */
  bindPiSessionId: (sid: string) => void;
  /** Handle session_start event (reseed, marker cleanup). */
  handleSessionStart: (reason: string, sid: string | null, sessionCwd?: string) => void;
  /** Force history re-seed on next turn. */
  setForceHistorySeed: (force: boolean) => void;
} {
  let activePiSessionId: string | null = null;
  const provisionalPiSessionId = createProvisionalPiSessionId();
  let forceHistorySeed = false;
  const forceHistorySeedCwds = new Set<string>();
  const systemPromptSent = new Set<string>();
  const storedSystemPrompts = new Map<string, string>();
  const sessionKeys = new Map<string, CliSessionKey>();

  function memoryKey(model: string | undefined, turnCwd: string): string {
    return adapterMemoryKey(model, turnCwd);
  }

  function markerCwds(): string[] {
    const found = new Set<string>([cwd]);
    for (const key of sessionKeys.values()) {
      if (key.cwd) found.add(key.cwd);
    }
    return [...found];
  }

  function resolvedPiSessionId(): string {
    return activePiSessionId || provisionalPiSessionId;
  }

  function sessionKeyFor(model: string, turnCwd: string = cwd): CliSessionKey {
    return { cwd: turnCwd, agent: "cursor", model, piSessionId: resolvedPiSessionId() };
  }

  function migrateMarkersToRealPiSessionId(sid: string): void {
    if (!sid || sid === provisionalPiSessionId) return;
    for (const markerCwd of markerCwds()) {
      migrateAllCliSessionMarkers(markerCwd, provisionalPiSessionId, sid);
    }
    for (const [handleKey, prevKey] of sessionKeys) {
      if (
        !prevKey.piSessionId ||
        prevKey.piSessionId === sid ||
        (!isProvisionalPiSessionId(prevKey.piSessionId) &&
          prevKey.piSessionId !== "default")
      ) {
        continue;
      }
      const nextKey: CliSessionKey = { ...prevKey, piSessionId: sid };
      const migrated = migrateCliSessionMarker(nextKey, prevKey.piSessionId);
      if (!migrated && loadCliSessionId(prevKey)) {
        fileLog(LOG_DOMAIN, "warn", LOG_DOMAIN,
          `CLI marker migration failed; keeping source under ${prevKey.piSessionId}`);
      }
      sessionKeys.set(handleKey, nextKey);
    }
  }

  return {
    bindPiSessionId: (sid: string) => {
      activePiSessionId = sid;
      migrateMarkersToRealPiSessionId(sid);
    },

    handleSessionStart: (reason: string, sid: string | null, sessionCwd?: string) => {
      const prevSid = activePiSessionId;
      const resolvedSid = sid || activePiSessionId;
      const turnCwd = sessionCwd || cwd;
      if (sid) {
        activePiSessionId = sid;
        migrateMarkersToRealPiSessionId(sid);
      }

      const decision = decideCliSessionStartReseed({
        reason,
        prevPiSessionId: prevSid,
        nextPiSessionId: resolvedSid,
      });
      if (decision.forceHistorySeed) {
        forceHistorySeedCwds.add(turnCwd);
        fileLog(LOG_DOMAIN, "debug", LOG_DOMAIN,
          `handleSessionStart reseed cwd=${turnCwd} (not adapter-global)`);
      }

      if (decision.action === "keep") {
        return;
      }
      if (decision.action === "reseed" && resolvedSid) {
        try {
          clearCliSessionsForPiSession(turnCwd, resolvedSid, {
            includeLegacyDefault: prevSid == null || prevSid === "" || prevSid === "default",
          });
        } catch (err) {
          fileLog(LOG_DOMAIN, "warn", LOG_DOMAIN,
            `session_start marker cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        deleteKeysForCwd(systemPromptSent, turnCwd);
        deleteKeysForCwd(storedSystemPrompts, turnCwd);
        deleteKeysForCwd(sessionKeys, turnCwd);
      }
    },

    setForceHistorySeed: (force: boolean) => {
      forceHistorySeed = force;
    },

    startSession: async (opts: SessionStartOptions): Promise<SessionHandle> => {
      const model = opts.model || "default";
      const turnCwd = resolveAdapterCwd(opts, cwd);
      const memKey = memoryKey(model, turnCwd);
      if (opts.systemPrompt) storedSystemPrompts.set(memKey, opts.systemPrompt);
      const key = sessionKeyFor(model, turnCwd);
      sessionKeys.set(memKey, key);
      const existingId = loadCliSessionId(key);
      fileLog(LOG_DOMAIN, "debug", LOG_DOMAIN,
        `startSession model=${model} cwd=${turnCwd} boot=${cwd}`);
      return {
        sessionId: existingId || `cursor-${instanceId}-${model}`,
        model,
        cwd: turnCwd,
      };
    },

    sendTurn: async (
      handle: SessionHandle,
      prompt: string,
      opts?: TurnOptions,
    ): Promise<TurnResult> => {
      const turnCwd = resolveAdapterCwd(handle, cwd);
      const handleKey = memoryKey(handle.model, turnCwd);
      const key = sessionKeyFor(handle.model, turnCwd);
      // Read previous key BEFORE updating so legacy-marker adoption can compare categories
      const prevKey = sessionKeys.get(handleKey);
      sessionKeys.set(handleKey, key);

      let sessionId = loadCliSessionId(key);
      // Mid-session bind: adopt legacy marker
      if (!sessionId && shouldAdoptLegacyCliMarker(prevKey, key) && prevKey?.piSessionId) {
        migrateCliSessionMarker(key, prevKey.piSessionId);
        sessionId = loadCliSessionId(key);
      }

      const reseedThisCwd = cursorTurnNeedsHistorySeed(
        turnCwd,
        forceHistorySeedCwds,
        forceHistorySeed,
      );
      const needsSystemPrompt = !systemPromptSent.has(handleKey) || reseedThisCwd;
      fileLog(LOG_DOMAIN, "debug", LOG_DOMAIN,
        `sendTurn model=${handle.model} cwd=${turnCwd} boot=${cwd} reseed=${reseedThisCwd}`);

      // Prefer the system prompt stored at startSession over rebuilding
      let systemPrompt: string | undefined;
      if (needsSystemPrompt) {
        systemPrompt =
          storedSystemPrompts.get(handleKey) ||
          buildExternalSystemPrompt({ systemPrompt: undefined }, turnCwd);
      }

      // Resolve history seed plan
      const seedPlan = resolveCliHistorySeed({
        hasCliSession: !!sessionId,
        forceHistorySeed: reseedThisCwd,
      });
      // Stale marker after /resume: drop it so we open a fresh CLI chat
      if (reseedThisCwd && sessionId) {
        clearCliSessionId(key);
      }
      const effectiveSessionId = seedPlan.useCliSession ? sessionId : null;

      // Seed prior pi turns when opening a fresh CLI session
      let finalPrompt = seedPlan.seedHistory && opts?.context?.messages
        ? buildPromptWithHistory(opts.context.messages, prompt, false)
        : prompt;
      if (needsSystemPrompt && systemPrompt) {
        finalPrompt = applySystemPromptToCliPrompt(finalPrompt, systemPrompt);
      }

      // Build event handler
      const onEvent = opts?.onEvent
        ? (ev: { kind: string; text?: string; sessionId?: string }) => {
            if (ev.kind === "session" && ev.sessionId) {
              saveCliSessionId(key, ev.sessionId);
              opts.onEvent!({ kind: "session", sessionId: ev.sessionId });
            } else if (ev.kind === "thinking_delta" && ev.text) {
              opts.onEvent!({ kind: "thinking_delta", text: ev.text });
            } else if (ev.kind === "text_delta" && ev.text) {
              opts.onEvent!({ kind: "text_delta", text: ev.text });
            }
          }
        : undefined;

      const runOnce = (sid: string | null, p: string) =>
        runCliAgent({
          agent: "cursor",
          model: handle.model === "default" ? "default" : handle.model,
          cwd: turnCwd,
          prompt: p,
          sessionId: sid,
          signal: opts?.signal,
          binary: config.binary,
          onEvent,
        });

      try {
        const result = await runOnce(effectiveSessionId, finalPrompt);

        if (result.sessionId) {
          saveCliSessionId(key, result.sessionId);
        } else if (effectiveSessionId) {
          touchCliSession(key);
        }

        if (needsSystemPrompt) {
          systemPromptSent.add(handleKey);
        }
        forceHistorySeedCwds.delete(turnCwd);
        if (forceHistorySeed && reseedThisCwd) {
          forceHistorySeed = false;
        }

        return {
          text: result.text,
          thinking: result.thinking,
          sessionId: result.sessionId,
          stopReason: "stop",
          usage: result.usage,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (effectiveSessionId && shouldRetryWithoutResume(message)) {
          fileLog(LOG_DOMAIN, "warn", LOG_DOMAIN,
            `resume failed, clearing session and retrying: ${message.slice(0, 200)}`);
          clearCliSessionId(key);
          // Fresh CLI session after failed --resume — re-seed history
          let retryPrompt = opts?.context?.messages
            ? buildPromptWithHistory(opts.context.messages, prompt, false)
            : prompt;
          if (systemPrompt) {
            retryPrompt = applySystemPromptToCliPrompt(retryPrompt, systemPrompt);
          }
          const result = await runOnce(null, retryPrompt);
          if (result.sessionId) {
            saveCliSessionId(key, result.sessionId);
          }
          if (needsSystemPrompt) {
            systemPromptSent.add(handleKey);
          }
          forceHistorySeedCwds.delete(turnCwd);
          if (forceHistorySeed && reseedThisCwd) {
            forceHistorySeed = false;
          }
          return {
            text: result.text,
            thinking: result.thinking,
            sessionId: result.sessionId,
            stopReason: "stop",
            usage: result.usage,
          };
        }
        throw err;
      }
    },

    stopSession: async (handle: SessionHandle): Promise<void> => {
      const turnCwd = resolveAdapterCwd(handle, cwd);
      const memKey = memoryKey(handle.model, turnCwd);
      const key = sessionKeyFor(handle.model, turnCwd);
      clearCliSessionId(key);
      sessionKeys.delete(memKey);
      systemPromptSent.delete(memKey);
      storedSystemPrompts.delete(memKey);
      forceHistorySeedCwds.delete(turnCwd);
    },

    stopAll: async (): Promise<void> => {
      sessionKeys.clear();
      systemPromptSent.clear();
      storedSystemPrompts.clear();
    },

    hasSession: (_sessionId: string): boolean => {
      return false;
    },
  };
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export const CursorCliDriver: ProviderDriver<CursorCliConfig> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Cursor CLI",
    supportsMultipleInstances: false,
  },
  configSchema: cursorCliConfigSchema,
  defaultConfig: () => ({ binary: "agent", enabled: true }),

  probe: async (config: CursorCliConfig): Promise<ProviderProbeResult> => {
    const binary = resolveBinary(config.binary);
    if (!binary) {
      return {
        available: false,
        reason: `Binary '${config.binary}' not found on PATH`,
      };
    }
    return { available: true };
  },

  create: async (
    input: ProviderDriverCreateInput<CursorCliConfig>,
  ): Promise<ProviderInstance> => {
    const { instanceId, config, cwd } = input;

    let discoveredModels: DiscoveredModel[] = [];
    try {
      const detailed = await discoverCliModelsDetailed("cursor");
      discoveredModels = detailed.map((m) => ({ id: m.id, name: m.name }));
    } catch (err) {
      fileLog(LOG_DOMAIN, "warn", LOG_DOMAIN,
        `model discovery failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const managed = makeManagedSnapshot({
      skipInitialRefresh: true,
      initialSnapshot: () =>
        buildInitialSnapshot(true, discoveredModels),
      checkProvider: async () => {
        const binary = resolveBinary(config.binary);
        if (!binary) {
          return buildInitialSnapshot(false, [], undefined, `Binary '${config.binary}' not found`);
        }
        try {
          const next = await discoverCliModelsDetailed("cursor");
          const models = next.map((m) => ({ id: m.id, name: m.name }));
          return buildInitialSnapshot(true, models);
        } catch {
          return buildInitialSnapshot(true, discoveredModels);
        }
      },
      getSettings: () => config,
      haveSettingsChanged: (prev, next) =>
        prev.binary !== next.binary || prev.enabled !== next.enabled,
    });

    const adapter = createCursorCliAdapter(config, cwd, instanceId);

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName || "Cursor CLI",
      enabled: input.enabled,
      snapshot: {
        getSnapshot: managed.getSnapshot,
        refresh: managed.refresh,
        dispose: managed.dispose,
      },
      adapter,
      dispose: async () => {
        managed.dispose();
        await adapter.stopAll();
      },
    };
  },
};
