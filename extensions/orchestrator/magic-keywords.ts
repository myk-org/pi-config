/**
 * Per-turn magic keywords (`ultrathink` / `chillax`) for quick reasoning-effort
 * overrides without manually toggling `/thinking` before and after a prompt (#1418).
 *
 * - Strictly prose-only parser: matches exact lowercase standalone words in user
 *   prose and ignores fenced code blocks (backticks/tildes), inline code spans,
 *   HTML/XML tags/comments, URLs, file paths, identifiers, and synthetic/agent
 *   prompts.
 * - Single-turn thinking override: raises effort to the model's highest supported
 *   level (`ultrathink`) or lowers it to the lowest supported level (`chillax`,
 *   never raising or enabling thinking when off), restoring the previous level on
 *   `turn_end` / `agent_end` / error / abort.
 * - Zero prompt-cache impact: returns `undefined` when no keyword matches, and
 *   delivers any careful-reasoning notice as a hidden per-turn custom message
 *   instead of mutating the cached system prompt prefix.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../shared/logger.js";
import { resolveBridgeSessionKey } from "../shared/session-bridge.js";
import {
  THINKING_LEVELS,
  isThinkingLevel,
  modelThinkingKey,
  type RuntimeModel,
  type SavedThinkingLevel,
} from "../providers/last-thinking-level.js";
import { getSetting } from "./project-settings.js";

const log = createLogger("magic-keywords");

export type MagicKeywordName = "ultrathink" | "chillax";
export type MagicKeywordDirection = "highest" | "lowest";

export interface MagicKeywordSpec {
  readonly keyword: MagicKeywordName;
  readonly direction: MagicKeywordDirection;
  /** Brief per-turn guidance delivered via hidden custom message (never cached system prompt). */
  readonly notice?: string;
}

/** Single source of truth for supported per-turn thinking magic keywords. */
export const MAGIC_KEYWORDS: readonly MagicKeywordSpec[] = [
  {
    keyword: "ultrathink",
    direction: "highest",
    notice:
      "Take extra care on this turn: reason thoroughly through edge cases, invariants, and tradeoffs before acting.",
  },
  {
    keyword: "chillax",
    direction: "lowest",
  },
] as const;

const KEYWORD_BY_NAME: ReadonlyMap<string, MagicKeywordSpec> = new Map(
  MAGIC_KEYWORDS.map((spec) => [spec.keyword, spec]),
);

const KEYWORD_PATTERN = new RegExp(
  `(${MAGIC_KEYWORDS.map((s) => s.keyword).join("|")})`,
  "g",
);

// ── Strict prose-only stripping & matching ───────────────────────────

function stripFencedCodeBlocks(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let fenceChar: "`" | "~" | null = null;
  let fenceLen = 0;

  for (const line of lines) {
    if (fenceChar === null) {
      const openMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (openMatch) {
        const marker = openMatch[1]!;
        const ch = marker[0] as "`" | "~";
        // Per CommonMark, backtick fence info strings cannot contain backticks.
        const rest = line.slice(openMatch[0].length);
        if (ch === "`" && rest.includes("`")) {
          out.push(line);
          continue;
        }
        fenceChar = ch;
        fenceLen = marker.length;
        out.push("");
        continue;
      }
      out.push(line);
    } else {
      const closeRe = fenceChar === "`"
        ? new RegExp(`^ {0,3}\`{${fenceLen},}[ \\t]*$`)
        : new RegExp(`^ {0,3}~{${fenceLen},}[ \\t]*$`);
      out.push("");
      if (closeRe.test(line)) {
        fenceChar = null;
        fenceLen = 0;
      }
    }
  }

  return out.join("\n");
}

function stripInlineCodeSpans(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;

  while (i < n) {
    if (text[i] !== "`") {
      out += text[i];
      i += 1;
      continue;
    }

    let openEnd = i;
    while (openEnd < n && text[openEnd] === "`") openEnd += 1;
    const tickLen = openEnd - i;

    // Scan for the next backtick run with the exact same length.
    let j = openEnd;
    let foundClose = -1;
    while (j < n) {
      if (text[j] !== "`") {
        j += 1;
        continue;
      }
      let closeEnd = j;
      while (closeEnd < n && text[closeEnd] === "`") closeEnd += 1;
      if (closeEnd - j === tickLen) {
        foundClose = closeEnd;
        break;
      }
      j = closeEnd;
    }

    if (foundClose !== -1) {
      out += " ";
      i = foundClose;
    } else {
      out += text.slice(i, openEnd);
      i = openEnd;
    }
  }

  return out;
}

function stripHtmlAndXml(text: string): string {
  // Strip HTML/XML comments first, then opening/closing/self-closing tags.
  return text
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/?[A-Za-z][A-Za-z0-9:._-]*(?:\s(?:[^<>"']|"[^"]*"|'[^']*')*?)?\/?>/g, " ");
}

function stripUrls(text: string): string {
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ");
}

function isStandaloneProseBoundary(text: string, start: number, end: number): boolean {
  // Left boundary: start of text, whitespace, or opening paren/bracket after start/whitespace.
  if (start > 0) {
    const prev = text[start - 1]!;
    if (!/\s/.test(prev)) {
      if (prev === "(" || prev === "[") {
        if (start - 1 > 0 && !/\s/.test(text[start - 2]!)) {
          return false; // e.g. fn(ultrathink) or arr[chillax]
        }
      } else {
        return false; // rejects paths, identifiers, flags, quotes, colons, etc.
      }
    }
  }

  // Right boundary: end of text, whitespace, closing paren/bracket, or trailing prose punctuation.
  if (end < text.length) {
    const next = text[end]!;
    if (/\s/.test(next)) return true;

    if (next === ")" || next === "]") {
      if (end + 1 === text.length) return true;
      const afterClose = text[end + 1]!;
      if (/\s/.test(afterClose)) return true;
      if (/[.,!?;:]/.test(afterClose)) {
        return end + 2 === text.length || /\s/.test(text[end + 2]!);
      }
      return false; // e.g. (ultrathink).ts or (ultrathink)()
    }

    if (/[.,!?;:]/.test(next)) {
      // Trailing prose punctuation is only valid when followed by EOL, whitespace, or closing paren/bracket.
      // Rejects ultrathink.ts, chillax::bar, chillax:123, ultrathink.foo.
      return end + 1 === text.length || /[\s)\]]/.test(text[end + 1]!);
    }

    return false; // rejects ultrathink(), ultrathink_x, ultrathink-x, ultrathink/x, "ultrathink", etc.
  }

  return true;
}

/**
 * Detect a standalone lowercase magic keyword in user prose.
 * When multiple keywords match in prose, the last match wins.
 */
export function detectMagicKeyword(prompt: string): MagicKeywordSpec | null {
  if (!prompt) return null;
  const prose = stripUrls(stripHtmlAndXml(stripInlineCodeSpans(stripFencedCodeBlocks(prompt))));

  let matched: MagicKeywordSpec | null = null;
  KEYWORD_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = KEYWORD_PATTERN.exec(prose)) !== null) {
    const word = m[1]!;
    const start = m.index;
    const end = start + word.length;
    if (isStandaloneProseBoundary(prose, start, end)) {
      matched = KEYWORD_BY_NAME.get(word) ?? null;
    }
  }
  return matched;
}

// ── Thinking-level resolution ────────────────────────────────────────

const DEFAULT_REASONING_LEVELS: readonly SavedThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
];

/** Compute the ordered list of supported thinking levels for a model (mirrors Pi's `getSupportedThinkingLevels`). */
export function getModelSupportedThinkingLevels(
  model: RuntimeModel | undefined,
): SavedThinkingLevel[] {
  if (!model) return [...DEFAULT_REASONING_LEVELS];
  if (model.reasoning !== true) return ["off"];
  const supported = THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
  return supported.length > 0 ? supported : ["off"];
}

/**
 * Resolve the target thinking level for a magic keyword, or `null` when no change should be applied.
 * - `highest` (`ultrathink`): raises to the model's highest supported level (never lowers).
 * - `lowest` (`chillax`): lowers to the model's lowest active reasoning level (e.g. `minimal` or `low`,
 *   never turning reasoning completely off and never raising or enabling thinking when off).
 */
export function resolveMagicThinkingLevel(
  model: RuntimeModel | undefined,
  currentLevel: SavedThinkingLevel,
  direction: MagicKeywordDirection,
): SavedThinkingLevel | null {
  const supported = getModelSupportedThinkingLevels(model);
  if (supported.length === 0) return null;

  const currentIdx = THINKING_LEVELS.indexOf(currentLevel);
  if (currentIdx < 0) return null;

  if (direction === "highest") {
    const target = supported[supported.length - 1]!;
    const targetIdx = THINKING_LEVELS.indexOf(target);
    return targetIdx > currentIdx ? target : null;
  }

  // direction === "lowest": never raise or enable thinking when already off,
  // and target the lowest active reasoning level (excluding "off").
  if (currentLevel === "off") return null;
  const target = supported.find((level) => level !== "off");
  if (!target) return null;
  const targetIdx = THINKING_LEVELS.indexOf(target);
  return targetIdx < currentIdx ? target : null;
}

// ── Extension lifecycle registration ─────────────────────────────────

interface ActiveThinkingOverride {
  keyword: MagicKeywordName;
  previousLevel: SavedThinkingLevel;
  appliedLevel: SavedThinkingLevel;
  modelKey: string | undefined;
}

interface MagicKeywordSessionState {
  activeOverride: ActiveThinkingOverride | null;
  pendingSyntheticPrompt: string | null;
}

const MAX_SESSION_STATES = 32;

function getSafeThinkingLevel(pi: ExtensionAPI): SavedThinkingLevel | undefined {
  try {
    const level = pi.getThinkingLevel?.();
    return isThinkingLevel(level) ? level : undefined;
  } catch (err) {
    log.debug("getThinkingLevel failed", { error: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}

function setTransientThinkingLevel(
  pi: ExtensionAPI,
  level: SavedThinkingLevel,
  modelKey: string | undefined,
): boolean {
  let suppressionQueued = false;
  try {
    // Notify session-restore so temporary per-turn overrides never overwrite last-thinking-level.json.
    pi.events?.emit?.("providers:suppress-thinking-save", { model: modelKey, level });
    suppressionQueued = true;
  } catch {
    // Event bus is optional in minimal test harnesses.
  }
  try {
    pi.setThinkingLevel(level as ThinkingLevel);
    return true;
  } catch (err) {
    if (suppressionQueued) {
      try {
        pi.events?.emit?.("providers:unsuppress-thinking-save", { model: modelKey, level });
      } catch {
        // Ignore secondary cleanup error.
      }
    }
    log.warn("setThinkingLevel failed", {
      level,
      model: modelKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export function registerMagicKeywords(pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENT_CHILD === "1") {
    log.debug("magic-keywords skipped for subagent child");
    return;
  }

  const sessions = new Map<string, MagicKeywordSessionState>();

  const getState = (ctx: any): MagicKeywordSessionState => {
    const key = resolveBridgeSessionKey(ctx);
    const existing = sessions.get(key);
    if (existing) return existing;
    if (sessions.size >= MAX_SESSION_STATES) {
      const oldest = sessions.keys().next().value;
      if (oldest !== undefined) sessions.delete(oldest);
    }
    const fresh: MagicKeywordSessionState = {
      activeOverride: null,
      pendingSyntheticPrompt: null,
    };
    sessions.set(key, fresh);
    return fresh;
  };

  const emitTransientBoundary = (
    eventName: "providers:transient-thinking-start" | "providers:transient-thinking-end",
    modelKey: string | undefined,
  ): void => {
    try {
      pi.events?.emit?.(eventName, { model: modelKey });
    } catch {
      // Event bus is optional in minimal harnesses.
    }
  };

  // Receive deferred startup thinking-preference restores that settled while a
  // keyword override was active, so restoration returns to the restored preference.
  pi.events?.on?.("providers:deferred-thinking-restore", (payload: unknown) => {
    if (!payload || typeof payload !== "object") return;
    const p = payload as { model?: unknown; level?: unknown };
    if (!isThinkingLevel(p.level)) return;
    const targetModel = typeof p.model === "string" ? p.model : undefined;
    for (const state of sessions.values()) {
      const active = state.activeOverride;
      if (!active) continue;
      if (targetModel !== undefined && active.modelKey !== undefined && active.modelKey !== targetModel) {
        continue;
      }
      active.previousLevel = p.level;
      log.debug("magic_keyword_deferred_restore_adopted", {
        keyword: active.keyword,
        model: active.modelKey,
        restoredTarget: p.level,
      });
    }
  });

  const restoreOverride = (ctx: any, reason: string): void => {
    const state = getState(ctx);
    const active = state.activeOverride;
    if (!active) return;
    state.activeOverride = null;
    emitTransientBoundary("providers:transient-thinking-end", active.modelKey);

    const currentModelKey = modelThinkingKey(ctx?.model);
    if (active.modelKey !== undefined && currentModelKey !== undefined && currentModelKey !== active.modelKey) {
      log.debug("magic_keyword_restore_skipped_model_changed", {
        reason,
        keyword: active.keyword,
        overrideModel: active.modelKey,
        currentModel: currentModelKey,
      });
      return;
    }

    const currentLevel = getSafeThinkingLevel(pi);
    if (currentLevel !== undefined && currentLevel !== active.appliedLevel) {
      log.debug("magic_keyword_restore_skipped_user_changed_level", {
        reason,
        keyword: active.keyword,
        applied: active.appliedLevel,
        current: currentLevel,
      });
      return;
    }

    if (active.previousLevel === active.appliedLevel) {
      log.debug("magic_keyword_restore_already_at_target", {
        reason,
        keyword: active.keyword,
        level: active.previousLevel,
      });
      return;
    }

    const restored = setTransientThinkingLevel(pi, active.previousLevel, currentModelKey ?? active.modelKey);
    log.info("magic_keyword_restored", {
      reason,
      keyword: active.keyword,
      from: active.appliedLevel,
      to: active.previousLevel,
      restored,
    });
  };

  pi.on("input", (event, ctx) => {
    const state = getState(ctx);
    if (event?.source === "extension") {
      state.pendingSyntheticPrompt = typeof event.text === "string" ? event.text : "";
    } else {
      state.pendingSyntheticPrompt = null;
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    const state = getState(ctx);
    // Recover cleanly if a previous turn crashed before turn_end/agent_end.
    if (state.activeOverride) {
      restoreOverride(ctx, "next_turn_recovery");
    }

    if (event?.messageType !== "user") {
      return;
    }
    const prompt = typeof event.prompt === "string" ? event.prompt : "";
    if (!prompt) return;

    // Ignore synthetic extension-initiated prompts (pi.sendUserMessage -> input source === "extension").
    if (state.pendingSyntheticPrompt !== null) {
      const synthetic = state.pendingSyntheticPrompt;
      state.pendingSyntheticPrompt = null;
      if (synthetic === "" || prompt === synthetic || prompt.startsWith(synthetic)) {
        log.debug("magic_keyword_skipped_synthetic_prompt");
        return;
      }
    }

    const cwd = ctx?.cwd || process.cwd();
    if (!getSetting(cwd, "magic_keywords")) {
      return;
    }

    const match = detectMagicKeyword(prompt);
    if (!match) return;

    const currentLevel = getSafeThinkingLevel(pi);
    const model = ctx?.model as RuntimeModel | undefined;
    const modelKey = modelThinkingKey(model);

    if (currentLevel !== undefined) {
      const targetLevel = resolveMagicThinkingLevel(model, currentLevel, match.direction);
      if (targetLevel !== null && targetLevel !== currentLevel) {
        if (setTransientThinkingLevel(pi, targetLevel, modelKey)) {
          state.activeOverride = {
            keyword: match.keyword,
            previousLevel: currentLevel,
            appliedLevel: targetLevel,
            modelKey,
          };
          emitTransientBoundary("providers:transient-thinking-start", modelKey);
          log.info("magic_keyword_applied", {
            keyword: match.keyword,
            from: currentLevel,
            to: targetLevel,
            model: modelKey,
          });
        }
      } else {
        log.debug("magic_keyword_no_level_change", {
          keyword: match.keyword,
          currentLevel,
          model: modelKey,
        });
      }
    }

    if (match.notice) {
      return {
        message: {
          customType: "magic-keyword-notice",
          content: match.notice,
          display: false,
        },
      };
    }
    return;
  });

  pi.on("turn_end", (event, ctx) => {
    const outcome = (event as any)?.outcome as string | undefined;
    const willContinue = (event as any)?.continue === true;
    if (outcome === "aborted" || outcome === "error" || !willContinue) {
      restoreOverride(ctx, `turn_end:${outcome ?? "completed"}`);
    }
  });

  pi.on("agent_end", (_event, ctx) => {
    restoreOverride(ctx, "agent_end");
  });

  pi.on("session_start", (_event, ctx) => {
    restoreOverride(ctx, "session_start");
    sessions.delete(resolveBridgeSessionKey(ctx));
  });

  pi.on("session_shutdown", (_event, ctx) => {
    restoreOverride(ctx, "session_shutdown");
    sessions.delete(resolveBridgeSessionKey(ctx));
  });

  log.debug("magic-keywords lifecycle registered");
}
