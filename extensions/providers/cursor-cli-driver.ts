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
  ProviderAdapterShape,
  ProviderDriver,
  SessionHandle,
  SessionStartOptions,
  TurnOptions,
  TurnResult,
} from "../shared/provider-driver.js";
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
  migrateAllCliSessionMarkersDetailed,
  shouldAdoptLegacyCliMarker,
  resolveCliHistorySeed,
  touchCliSession,
  clearCliSessionsForPiSession,
  decideCliSessionStartReseed,
  type CliSessionKey,
} from "../cli-provider/sessions.js";
import { messageText } from "../shared/build-system-prompt.js";
import { createLogger } from "../shared/logger.js";
import { resolveAdapterCwd, adapterMemoryKey, deleteKeysForCwd } from "../shared/session-cwd.js";
import {
  createCliDriver,
  createCliStreamEventForwarder,
  type CliDriverConfig,
} from "./cli-driver-shared.js";

const log = createLogger("cursor-cli-driver");

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
  log.debug(`cursorTurnNeedsHistorySeed cwd=${turnCwd} global=${forceHistorySeedGlobal} cwdListed=${cwdListed} needed=${needed}`);
  return needed;
}

export type CursorCliConfig = CliDriverConfig;

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

export function createCursorCliAdapter(
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
  log.debug(`createCursorCliAdapter bootCwdBound=${Boolean(cwd)} instance=${instanceId}`);
  let activePiSessionId: string | null = null;
  const provisionalPiSessionId = createProvisionalPiSessionId();
  let provisionalMarkerWritten = false;
  let forceHistorySeed = false;
  const forceHistorySeedCwds = new Set<string>();
  const appliedSystemPrompts = new Map<string, string | undefined>();
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

  function saveCliMarker(key: CliSessionKey, sessionId: string): boolean {
    const saved = saveCliSessionId(key, sessionId);
    if (saved && key.piSessionId === provisionalPiSessionId) {
      provisionalMarkerWritten = true;
    }
    return saved;
  }

  function migrateMarkersToRealPiSessionId(sid: string): void {
    if (!sid || sid === provisionalPiSessionId) return;
    const hadProvisionalMarker = provisionalMarkerWritten;
    let remainingProvisional = 0;
    if (hadProvisionalMarker) {
      for (const markerCwd of markerCwds()) {
        const res = migrateAllCliSessionMarkersDetailed(
          markerCwd,
          provisionalPiSessionId,
          sid,
        );
        remainingProvisional += res.remaining;
      }
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
      if (prevKey.piSessionId !== provisionalPiSessionId || hadProvisionalMarker) {
        const migrated = migrateCliSessionMarker(nextKey, prevKey.piSessionId);
        if (!migrated && loadCliSessionId(prevKey)) {
          log.warn(`CLI marker migration failed; keeping source under ${prevKey.piSessionId}`);
          if (prevKey.piSessionId === provisionalPiSessionId) {
            remainingProvisional += 1;
          }
          continue;
        }
      }
      sessionKeys.set(handleKey, nextKey);
    }
    if (hadProvisionalMarker) {
      provisionalMarkerWritten = remainingProvisional > 0;
    }
  }

  return {
    bindPiSessionId: (sid: string) => {
      if (!sid) return;
      if (sid === activePiSessionId && !provisionalMarkerWritten) return;
      log.debug("binding pi session id", { sid, hadProvisionalMarker: provisionalMarkerWritten });
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
        log.debug(`handleSessionStart reseed cwd=${turnCwd} (not adapter-global)`);
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
          log.warn(`session_start marker cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        deleteKeysForCwd(appliedSystemPrompts, turnCwd);
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
      const key = sessionKeyFor(model, turnCwd);
      log.debug("starting CLI session", { model, cwd: turnCwd, hasSystemPrompt: opts.systemPrompt !== undefined });
      if (opts.systemPrompt === undefined) {
        storedSystemPrompts.delete(memKey);
        if (appliedSystemPrompts.get(memKey) !== undefined) {
          clearCliSessionId(key);
          forceHistorySeedCwds.add(turnCwd);
        }
      } else {
        storedSystemPrompts.set(memKey, opts.systemPrompt);
      }
      sessionKeys.set(memKey, key);
      const existingId = loadCliSessionId(key);
      log.debug(`startSession model=${model} cwd=${turnCwd} boot=${cwd}`);
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
      const systemPrompt = storedSystemPrompts.get(handleKey);
      const needsSystemPrompt = reseedThisCwd || !appliedSystemPrompts.has(handleKey) || appliedSystemPrompts.get(handleKey) !== systemPrompt;
      log.debug(`sendTurn model=${handle.model} cwd=${turnCwd} boot=${cwd} reseed=${reseedThisCwd}`);
      log.debug("building turn system prompt", { model: handle.model, turnCwd, reseed: reseedThisCwd, changed: needsSystemPrompt });

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
      const onEvent = createCliStreamEventForwarder(key, saveCliMarker, opts?.onEvent);

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
          saveCliMarker(key, result.sessionId);
        } else if (effectiveSessionId) {
          touchCliSession(key);
        }

        if (needsSystemPrompt) {
          appliedSystemPrompts.set(handleKey, systemPrompt);
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
          log.warn(`resume failed, clearing session and retrying: ${message.slice(0, 200)}`);
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
            saveCliMarker(key, result.sessionId);
          }
          if (needsSystemPrompt) {
            appliedSystemPrompts.set(handleKey, systemPrompt);
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
      appliedSystemPrompts.delete(memKey);
      storedSystemPrompts.delete(memKey);
      forceHistorySeedCwds.delete(turnCwd);
    },

    stopAll: async (): Promise<void> => {
      sessionKeys.clear();
      appliedSystemPrompts.clear();
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

export const CursorCliDriver: ProviderDriver<CursorCliConfig> = createCliDriver({
  agent: "cursor",
  driverKind: "cursor-cli",
  defaultBinary: "agent",
  defaultDisplayName: "Cursor CLI",
  log,
  createAdapter: createCursorCliAdapter,
});
