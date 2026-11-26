/**
 * Rule & memory injection — loads rules/*.md for the orchestrator
 * and project memories from topic files for all agents.
 *
 * Includes: social closer gate, session history auto-injection,
 * retrieval telemetry, and vector-based contextual memory injection.
 */

import { createLogger } from "../shared/logger.js";

const log = createLogger("rules");
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatDuration } from "./async-agents.js";
import {
  buildCompactionMemoryContext,
  buildSituationReport,
  estimateMemoryBudget,
  rebuildAndOrganize,
  type SituationReportOptions,
} from "./situation-report.js";
import { getMemoryMutationsSince, getMemoryMutationSeq } from "./memory-store.js";
import { classifyQueryClass, getQueryClassBias } from "./memory-query-class.js";
import { getSetting, getSettingDynamic, SETTINGS_KEYS } from "./project-settings.js";
import {
  assembleRulesSplit,
  extractPathsFromText,
  extractPathsFromToolInput,
  matchLazyRule,
  type LazyRule,
} from "./rule-placeholders.js";
import { isComsActive, resolveBridgeSessionKey } from "../shared/session-bridge.js";
import { JsonlAppendLog } from "./state-jsonl.js";
import { getProjectDataDir, getProjectMemoryDir } from "./utils.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_RULES_DIR = path.resolve(MODULE_DIR, "..", "..", "rules");
const KNOWN_SETTING_KEYS = new Set(Object.keys(SETTINGS_KEYS));
const RULE_MAX_BYTES = 128 * 1024;
const RAW_RULE_FILE_CACHE_MAX = 128;
const ASSEMBLED_RULES_CACHE_MAX = 16;

interface CachedRawRuleFile {
  stamp: string;
  content: string | null; // null when skipped (>128KB)
}

interface AssembledRulesCacheEntry {
  accessedSettings: Array<[string, unknown]>;
  comsActive: boolean;
  interactiveTui: boolean;
  reviewLoopMaxCycles: number;
  joined: string;
  lazyRules: LazyRule[];
  fileCount: number;
  includedCount: number;
  lazyCount: number;
  skippedCount: number;
}

interface RuleBundle {
  baseRules: string;
  lazyRules: LazyRule[];
}

const rawRuleFileCache = new Map<string, CachedRawRuleFile>();
const assembledRulesCache = new Map<string, AssembledRulesCacheEntry>();

function setBounded<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  if (map.has(key)) map.delete(key);
  else if (map.size >= max) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

/** Clear rule file and assembly caches (tests). */
export function clearRulesCache(): void {
  rawRuleFileCache.clear();
  assembledRulesCache.clear();
}

function statStamp(filePath: string): { stamp: string; size: number } {
  const st = fs.statSync(filePath, { bigint: true });
  return {
    stamp: `${st.mtimeNs}:${st.ctimeNs}:${st.size}`,
    size: Number(st.size),
  };
}

function readRuleFileCached(fileName: string, filePath: string): { stamp: string; content: string | null } | null {
  try {
    const { stamp, size } = statStamp(filePath);
    const cached = rawRuleFileCache.get(filePath);
    if (cached && cached.stamp === stamp) {
      return cached;
    }
    if (size > RULE_MAX_BYTES) {
      log.debug(`${fileName} skipped (${Math.round(size / 1024)}KB > 128KB limit)`);
      const entry = { stamp, content: null };
      setBounded(rawRuleFileCache, filePath, entry, RAW_RULE_FILE_CACHE_MAX);
      return entry;
    }
    const entry = { stamp, content: fs.readFileSync(filePath, "utf-8") };
    setBounded(rawRuleFileCache, filePath, entry, RAW_RULE_FILE_CACHE_MAX);
    return entry;
  } catch (e: any) {
    rawRuleFileCache.delete(filePath);
    log.debug(`${fileName} failed from ${filePath}:`, e?.message?.slice(0, 100));
    return null;
  }
}

function sameSettingValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a === "object" && typeof b === "object" && a !== null && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

function loadRuleBundle(
  cwd: string,
  packageRulesDir = PACKAGE_RULES_DIR,
  sessionKey?: string,
  interactiveTui = process.env.PI_COMS_SUPERVISED_PEER !== "1",
): RuleBundle {
  const userRulesDir = path.join(os.homedir(), ".pi", "agent", "rules");
  const projectRulesDir = path.join(cwd, ".pi", "rules");

  const ruleCandidates = new Map<string, string[]>();

  for (const dir of [packageRulesDir, userRulesDir, projectRulesDir]) {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if ((!entry.isFile() && !entry.isSymbolicLink()) || !entry.name.endsWith(".md")) continue;
        const f = entry.name;
        const existing = ruleCandidates.get(f) || [];
        existing.push(path.join(dir, f));
        ruleCandidates.set(f, existing);
      }
    } catch (e: any) {
      if (e?.code !== "ENOENT") log.debug("failed to read", dir, e?.message?.slice(0, 100));
    }
  }

  if (ruleCandidates.size === 0) {
    return {
      baseRules: "\n\n[ORCHESTRATOR RULES] You are a MANAGER. Delegate work to subagents.\n",
      lazyRules: [],
    };
  }

  const sorted = [...ruleCandidates.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const ruleFiles: Array<{ fileName: string; raw: string }> = [];
  const sigParts: string[] = [];

  for (const [fileName, candidates] of sorted) {
    let loaded = false;
    for (let i = candidates.length - 1; i >= 0; i--) {
      const filePath = candidates[i]!;
      const loadedEntry = readRuleFileCached(fileName, filePath);
      if (!loadedEntry) continue;
      sigParts.push(`${fileName}:${filePath}:${loadedEntry.stamp}`);
      if (loadedEntry.content !== null) {
        ruleFiles.push({ fileName, raw: loadedEntry.content });
      }
      loaded = true;
      break;
    }
    if (!loaded) {
      log.debug(`${fileName}: all candidates failed, skipping`);
    }
  }

  if (ruleFiles.length === 0) {
    return {
      baseRules: "\n\n[ORCHESTRATOR RULES] You are a MANAGER. Delegate work to subagents.\n",
      lazyRules: [],
    };
  }

  const comsActive = isComsActive(sessionKey);
  const reviewLoopMaxCycles = Number(getSetting(cwd, "review_loop_max_cycles"));
  const cacheKey = `${path.resolve(cwd)}\0${comsActive ? "1" : "0"}\0${interactiveTui ? "1" : "0"}\0${sigParts.join("|")}`;
  const cached = assembledRulesCache.get(cacheKey);
  if (
    cached &&
    cached.comsActive === comsActive &&
    cached.interactiveTui === interactiveTui &&
    cached.reviewLoopMaxCycles === reviewLoopMaxCycles &&
    cached.accessedSettings.every(([k, v]) => sameSettingValue(getSettingDynamic(cwd, k), v))
  ) {
    // Touch LRU position
    assembledRulesCache.delete(cacheKey);
    assembledRulesCache.set(cacheKey, cached);
    log.info("rules assembled", {
      chars: cached.joined.length,
      files: cached.fileCount,
      included: cached.includedCount,
      lazy: cached.lazyCount,
      skipped: cached.skippedCount,
      cached: true,
    });
    return {
      baseRules: cached.joined ? "\n\n" + cached.joined : "",
      lazyRules: cached.lazyRules,
    };
  }

  log.debug("assembling rules", { count: ruleFiles.length, reviewLoopMaxCycles, interactiveTui });
  let includedCount = 0;
  let lazyCount = 0;
  let skippedCount = 0;
  const accessed = new Map<string, unknown>();
  const resolveTracked = (key: string): unknown => {
    const val = getSettingDynamic(cwd, key);
    if (!accessed.has(key)) accessed.set(key, val);
    return val;
  };
  const { baseText: joined, lazyRules } = assembleRulesSplit(ruleFiles, {
    resolve: resolveTracked,
    knownKeys: KNOWN_SETTING_KEYS,
    featurePredicates: {
      coms_active: () => comsActive,
      interactive_tui: () => interactiveTui,
    },
    reviewLoopMaxCycles,
    onWarn: (msg) => log.warn("rule assembly:", msg),
    onSkip: ({ attrs, index }) => {
      skippedCount += 1;
      log.debug("rule skipped by frontmatter gate", { index, attrs });
    },
    onInclude: ({ attrs, index }) => {
      includedCount += 1;
      log.debug("rule included", { index, attrs });
    },
    onLazy: ({ attrs, index, scope }) => {
      lazyCount += 1;
      log.debug("rule registered as lazy", { index, globs: scope.globs, tools: scope.tools, attrs });
    },
  });
  setBounded(
    assembledRulesCache,
    cacheKey,
    {
      accessedSettings: [...accessed.entries()],
      comsActive,
      interactiveTui,
      reviewLoopMaxCycles,
      joined,
      lazyRules,
      fileCount: ruleFiles.length,
      includedCount,
      lazyCount,
      skippedCount,
    },
    ASSEMBLED_RULES_CACHE_MAX,
  );
  log.info("rules assembled", {
    chars: joined.length,
    files: ruleFiles.length,
    included: includedCount,
    lazy: lazyCount,
    skipped: skippedCount,
  });
  return {
    baseRules: joined ? "\n\n" + joined : "",
    lazyRules,
  };
}

/** Per-cwd telemetry log cache — avoids re-creating on every call. */
const telemetryLogCache = new Map<string, JsonlAppendLog<Record<string, unknown>>>();

function getTelemetryLog(cwd: string): JsonlAppendLog<Record<string, unknown>> {
  const dataDir = getProjectDataDir(cwd);
  const cached = telemetryLogCache.get(dataDir);
  if (cached) return cached;
  const log = new JsonlAppendLog<Record<string, unknown>>(
    path.join(dataDir, "memory-telemetry.jsonl"),
  );
  telemetryLogCache.set(dataDir, log);
  return log;
}

/** Social closer gate — skip expensive vector search for trivial messages */
const SOCIAL_CLOSERS = new Set([
  "ok", "yes", "no", "thanks", "thank you", "got it", "sure",
  "right", "correct", "agreed", "nice", "cool", "great", "perfect",
  "👍", "👌", "✅", "🙏", "😊", "🎉", "💯",
]);

function isSocialCloser(text: string): boolean {
  const stripped = text.trim().toLowerCase();
  if (SOCIAL_CLOSERS.has(stripped)) return true;
  // Emoji-only messages (no alphanumeric, no non-Latin scripts like CJK/Cyrillic)
  if (stripped.length > 0 && stripped.length <= 8 && !/[a-z0-9\u00C0-\u024F\u0400-\u04FF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(stripped)) return true;
  return false;
}

/** Track last injected memories for usage detection in turn_end */
let lastInjectedMemories: { text: string; category: string; similarity: number }[] = [];

/** Log what memories were auto-injected for retrieval telemetry.
 *  Uses JsonlAppendLog — seq/ts added automatically, size-based truncation built-in. */
function logMemoryInjection(
  cwd: string,
  prompt: string,
  injected: { text: string; category: string; similarity: number }[],
  queryClass?: string,
): void {
  try {
    getTelemetryLog(cwd).append({
      event: "inject",
      prompt: prompt.slice(0, 200),
      queryClass: queryClass ?? "general",
      injected: injected.map(m => ({ text: m.text.slice(0, 100), category: m.category, similarity: m.similarity })),
    });
  } catch (e: any) { log.debug("telemetry write failed:", e?.message?.slice(0, 100)); }
}

/** Log whether injected memories were referenced in the LLM response.
 *  Uses JsonlAppendLog — seq/ts added automatically. */
function logMemoryUsage(cwd: string, injected: { text: string; category: string; similarity: number }[], used: { text: string; category: string; similarity: number }[]): void {
  try {
    getTelemetryLog(cwd).append({
      event: "usage",
      injectedCount: injected.length,
      usedCount: used.length,
      usageRate: injected.length > 0 ? +(used.length / injected.length).toFixed(2) : 0,
      used: used.map(m => ({ text: m.text.slice(0, 100), category: m.category })),
    });
  } catch (e: any) { log.debug("telemetry usage write failed:", e?.message?.slice(0, 100)); }
}

interface TrackedSnapshotEntry {
  category: string;
  text: string;
  id?: string;
}

interface PinnedMemorySnapshot {
  report: string;
  /** Immutable set of canonical lines actually rendered in `report` (used for recall dedup). */
  pinnedEmittedKeys: ReadonlySet<string>;
  /** Live identities of entries originating from `report` (used for mid-session/cross-process notices). */
  trackedEntries: Map<string, TrackedSnapshotEntry>;
  mutationSeq: number;
  /** Topic directory mtime/size fingerprint so cross-process edits are detected cheaply. */
  topicsStamp: string;
}

interface RulesSessionState {
  cwd: string;
  memorySnapshot: PinnedMemorySnapshot | null;
  hadAsyncJobs: boolean;
  /** Lazy rules that have actually been delivered to the model in this session. */
  deliveredLazyRules: Set<string>;
  /** Undelivered lazy rules matched on tool_call, keyed by fileName for fallback delivery. */
  pendingLazyRules: Map<string, LazyRule>;
  /** Undelivered lazy rules matched on specific tool_call IDs. */
  pendingLazyRulesByCallId: Map<string, LazyRule[]>;
}

const SESSION_STATES_MAX = 32;

function topicsDirStamp(cwd: string): string {
  const topicsDir = path.join(getProjectMemoryDir(cwd), "topics");
  try {
    const files = fs.readdirSync(topicsDir).filter((f) => f.endsWith(".md")).sort();
    const parts: string[] = [];
    for (const file of files) {
      try {
        const st = fs.statSync(path.join(topicsDir, file), { bigint: true });
        parts.push(`${file}:${st.mtimeNs}:${st.size}`);
      } catch {
        // File vanished mid-scan — include marker so next check reconciles.
        parts.push(`${file}:missing`);
      }
    }
    return parts.join("|");
  } catch {
    return "";
  }
}

function resolveInteractiveTui(ctx: any): boolean {
  return (
    process.env.PI_COMS_SUPERVISED_PEER !== "1" &&
    ctx?.hasUI !== false &&
    (ctx?.mode === undefined || ctx?.mode === "tui")
  );
}

function formatLazyRulesMarkdown(rules: LazyRule[]): string {
  return rules
    .map((r) => `<!-- scoped-rule: ${r.fileName} -->\n${r.body}`)
    .join("\n\n");
}

function markLazyRulesDelivered(state: RulesSessionState, rules: LazyRule[]): void {
  const names = new Set<string>();
  for (const r of rules) {
    state.deliveredLazyRules.add(r.fileName);
    state.pendingLazyRules.delete(r.fileName);
    names.add(r.fileName);
  }
  for (const [cid, list] of state.pendingLazyRulesByCallId.entries()) {
    const remaining = list.filter((r) => !names.has(r.fileName));
    if (remaining.length === 0) state.pendingLazyRulesByCallId.delete(cid);
    else state.pendingLazyRulesByCallId.set(cid, remaining);
  }
}

export function registerRules(
  pi: ExtensionAPI,
  getAsyncJobs?: () => Array<{ id: string; agent: string; name?: string; task: string; status: string; startedAt: number }>,
  options?: { packageRulesDir?: string },
): void {
  const isSubagent = process.env.PI_SUBAGENT_CHILD === "1";
  let rebuildDone = false;
  const sessionStates = new Map<string, RulesSessionState>();

  function getSessionState(ctx: any): RulesSessionState {
    const key = resolveBridgeSessionKey(ctx);
    const cwd = ctx?.cwd || process.cwd();
    const existing = sessionStates.get(key);
    if (existing && existing.cwd === cwd) {
      return existing;
    }
    const fresh: RulesSessionState = {
      cwd,
      memorySnapshot: null,
      hadAsyncJobs: false,
      deliveredLazyRules: new Set<string>(),
      pendingLazyRules: new Map<string, LazyRule>(),
      pendingLazyRulesByCallId: new Map<string, LazyRule[]>(),
    };
    setBounded(sessionStates, key, fresh, SESSION_STATES_MAX);
    return fresh;
  }

  function resetSessionState(ctx: any): string {
    const key = resolveBridgeSessionKey(ctx);
    sessionStates.delete(key);
    return key;
  }

  // Run full rebuild on session start (once per session, not every turn)
  pi.on("session_start", async (_event, ctx) => {
    rebuildDone = false;
    resetSessionState(ctx);
    try {
      rebuildAndOrganize(ctx.cwd);
      rebuildDone = true;
    } catch (e: any) { log.debug("rebuildAndOrganize on session_start failed:", e?.message || e); }

    // Bootstrap vector embeddings — embed missing entries only (orchestrator only)
    // Skips model init entirely if all entries are already embedded
    if (!isSubagent) {
      try {
        const { readAllTopicEntries } = await import("./memory-tree.js");
        const entries = readAllTopicEntries(ctx.cwd);
        if (entries.length > 0) {
          const { embedMissing } = await import("./memory-embeddings.js");
          // embedMissing checks store first — only inits model if entries are actually missing
          await embedMissing(ctx.cwd, entries);
        }
      } catch (e: any) { log.debug("embedding bootstrap failed:", e?.message?.slice(0, 100)); }
    }
  });

  // Pre-compaction standing memory context (#1422): fail-soft, skips subagents.
  // Verified against Pi 1.6.1 `AgentSession.compact()` / `_runAutoCompaction()`:
  // the same `preparation` object (and its `messagesToSummarize`/`turnPrefixMessages`
  // array) emitted here is passed directly to `compact(preparation, ...)` ->
  // `convertToLlm` -> `serializeConversation`, preserving Pi's built-in compaction
  // model routing, retry settings, and custom instructions.
  pi.on("session_before_compact", async (event, ctx) => {
    if (isSubagent) return;
    try {
      const preparation = (event as any)?.preparation;
      if (!preparation) return;
      const memContext = buildCompactionMemoryContext(ctx.cwd);
      if (!memContext) return;

      const messagesToSummarize = Array.isArray(preparation.messagesToSummarize)
        ? preparation.messagesToSummarize
        : null;
      const turnPrefixMessages = Array.isArray(preparation.turnPrefixMessages)
        ? preparation.turnPrefixMessages
        : null;

      let target: any[] | null = null;
      let targetName = "";
      if (messagesToSummarize && messagesToSummarize.length > 0) {
        target = messagesToSummarize;
        targetName = "messagesToSummarize";
      } else if (preparation.isSplitTurn && turnPrefixMessages && turnPrefixMessages.length > 0) {
        target = turnPrefixMessages;
        targetName = "turnPrefixMessages";
      }
      if (!target) return;

      const alreadyInjected = target.some(
        (m: any) => m?.role === "custom" && m?.customType === "standing-project-memory",
      );
      if (alreadyInjected) return;

      target.unshift({
        role: "custom",
        customType: "standing-project-memory",
        content: memContext,
        display: false,
        timestamp: Date.now(),
      });
      log.info("session_before_compact_memory_prepended", {
        reason: (event as any)?.reason,
        chars: memContext.length,
        target: targetName,
      });
    } catch (e: any) {
      // Fail-soft: never block or abort compaction on memory store errors.
      log.warn("session_before_compact_memory_failed", {
        error: e?.message?.slice(0, 160) ?? String(e),
      });
    }
  });

  // Post-compaction snapshot refresh (#1422 + #1414 + #1415):
  // Compaction resets the provider prompt-cache prefix, so cleanly refresh
  // the pinned startup memory snapshot, clear pending mid-session notices,
  // and reset per-session lazy rule deduplication.
  pi.on("session_compact", async (event, ctx) => {
    const sessionKey = resetSessionState(ctx);
    log.info("session_compact_state_refreshed", {
      sessionKey,
      reason: (event as any)?.reason,
      fromExtension: (event as any)?.fromExtension,
    });
  });

  pi.on("session_shutdown", async (event, ctx) => {
    if ((event as any)?.reason === "reload") return;
    const sessionKey = resetSessionState(ctx);
    log.debug("session_shutdown_state_cleared", { sessionKey, reason: (event as any)?.reason });
  });

  // Scoped lazy rule matching on tool_call (#1415): queues matched rules for
  // immediate delivery on tool_result (or next before_agent_start fallback).
  // Rules are only marked delivered when a tool_result or before_agent_start
  // actually emits them so a blocked call never delays delivery to a later tool.
  pi.on("tool_call", async (event, ctx) => {
    if (isSubagent) return;
    try {
      const sessionKey = resolveBridgeSessionKey(ctx);
      const bundle = loadRuleBundle(ctx.cwd, options?.packageRulesDir, sessionKey, resolveInteractiveTui(ctx));
      if (bundle.lazyRules.length === 0) return;

      const state = getSessionState(ctx);
      const toolName = typeof (event as any)?.toolName === "string" ? (event as any).toolName : "";
      const paths = extractPathsFromToolInput(toolName, (event as any)?.input, ctx.cwd);
      const matched: LazyRule[] = [];
      for (const rule of bundle.lazyRules) {
        if (state.deliveredLazyRules.has(rule.fileName)) continue;
        if (matchLazyRule(rule, { toolName, paths })) {
          matched.push(rule);
        }
      }
      if (matched.length === 0) return;

      const callId = typeof (event as any)?.toolCallId === "string" ? (event as any).toolCallId : "";
      if (callId) {
        const existing = state.pendingLazyRulesByCallId.get(callId) ?? [];
        const existingNames = new Set(existing.map((r) => r.fileName));
        const merged = [...existing, ...matched.filter((r) => !existingNames.has(r.fileName))];
        state.pendingLazyRulesByCallId.set(callId, merged);
      }
      for (const rule of matched) {
        state.pendingLazyRules.set(rule.fileName, rule);
      }
      log.debug("lazy_rules_matched_tool_call", {
        toolName,
        callId: callId || undefined,
        files: matched.map((r) => r.fileName),
      });
    } catch (e: any) {
      log.debug("lazy_rules_tool_call_failed", { error: e?.message?.slice(0, 120) });
    }
  });

  // Deliver scoped lazy rules matched on tool_call/tool_result directly in the
  // tool result content so the model sees them in the same turn without
  // mutating the cached base system prompt prefix (#1415).
  pi.on("tool_result", async (event, ctx) => {
    if (isSubagent) return;
    try {
      const state = getSessionState(ctx);
      const callId = typeof (event as any)?.toolCallId === "string" ? (event as any).toolCallId : "";
      const delivered: LazyRule[] = [];
      const deliveredNames = new Set<string>();

      if (callId && state.pendingLazyRulesByCallId.has(callId)) {
        const queued = state.pendingLazyRulesByCallId.get(callId) ?? [];
        state.pendingLazyRulesByCallId.delete(callId);
        for (const rule of queued) {
          if (state.deliveredLazyRules.has(rule.fileName) || deliveredNames.has(rule.fileName)) continue;
          deliveredNames.add(rule.fileName);
          delivered.push(rule);
        }
      }

      // Also match directly if tool_result ran without a preceding tool_call,
      // or if an earlier call was blocked before delivering a pending rule.
      const sessionKey = resolveBridgeSessionKey(ctx);
      const bundle = loadRuleBundle(ctx.cwd, options?.packageRulesDir, sessionKey, resolveInteractiveTui(ctx));
      if (bundle.lazyRules.length > 0) {
        const toolName = typeof (event as any)?.toolName === "string" ? (event as any).toolName : "";
        const paths = extractPathsFromToolInput(toolName, (event as any)?.input, ctx.cwd);
        for (const rule of bundle.lazyRules) {
          if (state.deliveredLazyRules.has(rule.fileName) || deliveredNames.has(rule.fileName)) continue;
          if (matchLazyRule(rule, { toolName, paths })) {
            deliveredNames.add(rule.fileName);
            delivered.push(rule);
          }
        }
      }

      if (delivered.length === 0) return;

      markLazyRulesDelivered(state, delivered);

      const blockText = `\n\n<scoped_rules>\n${formatLazyRulesMarkdown(delivered)}\n</scoped_rules>`;
      const existingContent = Array.isArray((event as any).content) ? (event as any).content : [];
      log.info("lazy_rules_injected", {
        hook: "tool_result",
        toolName: (event as any)?.toolName,
        files: delivered.map((r) => r.fileName),
      });
      return {
        content: [...existingContent, { type: "text" as const, text: blockText }],
        ...((event as any).structuredContent !== undefined
          ? { structuredContent: (event as any).structuredContent }
          : {}),
      };
    } catch (e: any) {
      log.debug("lazy_rules_tool_result_failed", { error: e?.message?.slice(0, 120) });
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    // Run rebuild on first agent start if session_start didn't fire yet
    if (!rebuildDone) {
      try {
        rebuildAndOrganize(ctx.cwd);
        rebuildDone = true;
      } catch (e: any) { log.debug("rebuildAndOrganize on agent_start failed:", e?.message || e); }
    }
    const state = getSessionState(ctx);
    const sessionKey = resolveBridgeSessionKey(ctx);

    // 1. Stable prefix: always-apply orchestrator rules (skip for specialist agents).
    // Load from: package rules/ → user ~/.pi/agent/rules/ → project .pi/rules/
    // Same-filename override: project > user > package
    let baseRules = "";
    let lazyRules: LazyRule[] = [];
    if (!isSubagent) {
      const bundle = loadRuleBundle(ctx.cwd, options?.packageRulesDir, sessionKey, resolveInteractiveTui(ctx));
      baseRules = bundle.baseRules;
      lazyRules = bundle.lazyRules;
    }

    // 1.4.0's BeforeAgentStartEvent is a union: `prompt` exists only on the user
    // variant, so narrow once here and use this for every downstream lookup.
    const prompt = event.messageType === "user" ? event.prompt : undefined;
    const shouldSearch = !isSubagent && !!prompt && !isSocialCloser(prompt);
    const queryClass = shouldSearch ? classifyQueryClass(prompt) : "general";

    // Helper to lazily preload scores + topic entries once per turn when needed.
    // Fail-soft: a store lock/migration error must never abort the agent turn.
    let preloaded: SituationReportOptions["preloaded"];
    let preloadAttempted = false;
    let preloadFailed = false;
    const ensurePreloaded = async (): Promise<SituationReportOptions["preloaded"]> => {
      if (preloadAttempted) return preloaded;
      preloadAttempted = true;
      try {
        const topicsDir = path.join(getProjectMemoryDir(ctx.cwd), "topics");
        if (fs.existsSync(topicsDir)) {
          const { readAllTopicEntries } = await import("./memory-tree.js");
          const { loadScores } = await import("./memory-scoring.js");
          preloaded = {
            scores: loadScores(ctx.cwd),
            topicEntries: readAllTopicEntries(ctx.cwd),
          };
        }
      } catch (e: any) {
        preloadFailed = true;
        log.debug("memory preload failed:", e?.message?.slice(0, 100));
      }
      return preloaded;
    };

    // 2. Stable prefix: pin the startup `# Project Memory` Situation Report once per
    // session (re-pinned only on session_start / session_compact) with deterministic
    // `queryClass: "general"` so mid-session memory writes and per-prompt query-class
    // shifts never invalidate the cached system-prompt prefix (#1414).
    const dynamicBlocks: string[] = [];
    let memories = "";
    let emittedMemoryKeys: ReadonlySet<string> = new Set<string>();

    if (state.memorySnapshot === null) {
      const budget = estimateMemoryBudget(event.systemPrompt?.length ?? 0, undefined, ctx.cwd);
      const data = budget > 0 ? await ensurePreloaded() : undefined;
      const emittedKeys = new Set<string>();
      const loaded = preloadFailed
        ? { report: "", failed: true }
        : loadMemoriesWithScoring(ctx.cwd, isSubagent, budget, "general", data, emittedKeys);
      memories = loaded.report;
      emittedMemoryKeys = emittedKeys;

      // Pin ONLY when memory loading succeeded — a transient lock/read error on
      // turn 1 must retry on the next turn instead of blanking memory all session.
      if (!preloadFailed && !loaded.failed) {
        const trackedEntries = new Map<string, TrackedSnapshotEntry>();
        if (data && emittedKeys.size > 0) {
          const { canonicalTopicLine } = await import("./memory-tree.js");
          const { entryHash } = await import("./memory-scoring.js");
          for (const te of data.topicEntries) {
            const canon = canonicalTopicLine(te);
            if (!emittedKeys.has(canon)) continue;
            const scored = data.scores.entries[entryHash(canon)];
            trackedEntries.set(canon, {
              category: te.category,
              text: te.text,
              id: te.id ?? scored?.id,
            });
          }
        }
        state.memorySnapshot = {
          report: loaded.report,
          pinnedEmittedKeys: emittedKeys,
          trackedEntries,
          mutationSeq: getMemoryMutationSeq(ctx.cwd),
          topicsStamp: topicsDirStamp(ctx.cwd),
        };
        log.debug("memory_snapshot_pinned", {
          sessionKey,
          chars: loaded.report.length,
          emitted: emittedKeys.size,
        });
      }
    } else {
      memories = state.memorySnapshot.report;
      emittedMemoryKeys = state.memorySnapshot.pinnedEmittedKeys;

      // Check if any entry from the pinned snapshot was edited, invalidated,
      // expired, or removed — both via the in-process mutation journal AND
      // via cross-process/gap reconciliation against topic files on disk.
      const snapshot = state.memorySnapshot;
      const { records: mutations, truncated } = getMemoryMutationsSince(ctx.cwd, snapshot.mutationSeq);
      snapshot.mutationSeq = getMemoryMutationSeq(ctx.cwd);
      const notices: string[] = [];

      for (const m of mutations) {
        const oldCanon = `- [${m.category}] ${m.oldText}`;
        const tracked = snapshot.trackedEntries.get(oldCanon);
        if (!tracked) continue;
        snapshot.trackedEntries.delete(oldCanon);
        if (m.op === "edit" && m.newText) {
          snapshot.trackedEntries.set(`- [${m.category}] ${m.newText}`, {
            category: m.category,
            text: m.newText,
            id: tracked.id,
          });
          notices.push(
            `- [updated] [${m.category}] "${m.oldText}" → "${m.newText}" (supersedes entry in pinned # Project Memory snapshot)`,
          );
        } else {
          notices.push(
            `- [removed] [${m.category}] "${m.oldText}" (no longer active; ignore entry in pinned # Project Memory snapshot)`,
          );
        }
      }

      const currentTopicsStamp = topicsDirStamp(ctx.cwd);
      if ((truncated || currentTopicsStamp !== snapshot.topicsStamp) && snapshot.trackedEntries.size > 0) {
        const data = await ensurePreloaded();
        if (!preloadFailed) {
          snapshot.topicsStamp = currentTopicsStamp;
          const activeCanonical = new Set<string>();
          const activeById = new Map<string, { category: string; text: string }>();
          if (data) {
            const { canonicalTopicLine } = await import("./memory-tree.js");
            const { entryHash, isEntryActiveForSession } = await import("./memory-scoring.js");
            for (const te of data.topicEntries) {
              const canon = canonicalTopicLine(te);
              const scored = data.scores.entries[entryHash(canon)];
              if (scored && !isEntryActiveForSession(scored, undefined)) continue;
              activeCanonical.add(canon);
              const id = te.id ?? scored?.id;
              if (id) activeById.set(id, { category: te.category, text: te.text });
            }
          }
          for (const [canon, tracked] of [...snapshot.trackedEntries.entries()]) {
            if (activeCanonical.has(canon)) continue;
            snapshot.trackedEntries.delete(canon);
            const replacement = tracked.id ? activeById.get(tracked.id) : undefined;
            if (replacement && replacement.category === tracked.category) {
              snapshot.trackedEntries.set(`- [${replacement.category}] ${replacement.text}`, {
                category: replacement.category,
                text: replacement.text,
                id: tracked.id,
              });
              notices.push(
                `- [updated] [${tracked.category}] "${tracked.text}" → "${replacement.text}" (supersedes entry in pinned # Project Memory snapshot)`,
              );
            } else {
              notices.push(
                `- [removed] [${tracked.category}] "${tracked.text}" (no longer active; ignore entry in pinned # Project Memory snapshot)`,
              );
            }
          }
        }
      } else if (currentTopicsStamp !== snapshot.topicsStamp) {
        snapshot.topicsStamp = currentTopicsStamp;
      }

      if (notices.length > 0) {
        log.info("pinned_memory_invalidation_notice", { count: notices.length, truncated });
        dynamicBlocks.push(
          `# Project Memory Updates\n\nThe following entries from the pinned session memory snapshot changed mid-session:\n\n${notices.join("\n")}`,
        );
      }
    }

    // 3. Per-turn dynamic context (delivered outside the cached system-prompt prefix):

    // 3a. Ticking async agent status — only emitted when jobs are running, or once
    // on a running → 0 transition so idle turns carry zero dynamic overhead (#1414).
    if (!isSubagent && getAsyncJobs) {
      const jobs = getAsyncJobs();
      if (jobs.length > 0) {
        let status = `# Async Agents Status\n\n${jobs.length} async agent(s) running — kill any that are no longer needed:\n`;
        for (const j of jobs) {
          const elapsed = formatDuration(Date.now() - j.startedAt);
          status += `- ${j.name || j.agent} (${j.agent}) — ${elapsed}\n`;
        }
        state.hadAsyncJobs = true;
        dynamicBlocks.push(status.trim());
        log.debug("async_agents_status_built", { jobCount: jobs.length, chars: status.length });
      } else if (state.hadAsyncJobs) {
        state.hadAsyncJobs = false;
        dynamicBlocks.push("# Async Agents Status\n\nNo async agents running.");
        log.debug("async_agents_status_built", { jobCount: 0, transition: true });
      }
    }

    // 3b. Auto-inject contextually relevant memories via vector search (~2.5ms, in-process).
    // Session-scoped/expired entries AND entries already emitted verbatim in
    // `# Project Memory` are excluded so pinned/high-score entries are not injected twice.
    if (shouldSearch) {
      const data = await ensurePreloaded();
      if (data && data.topicEntries.length > 0) {
        try {
          const { vectorSearch } = await import("./memory-embeddings.js");
          const { canonicalTopicLine } = await import("./memory-tree.js");
          const { entryHash, isEntryActiveForSession } = await import("./memory-scoring.js");
          const sessionId = (ctx as any).sessionManager?.getSessionId?.();
          const entries = data.topicEntries.filter((te) => {
            const canon = canonicalTopicLine(te);
            if (emittedMemoryKeys.has(canon)) return false;
            return isEntryActiveForSession(data.scores.entries[entryHash(canon)], sessionId);
          });
          if (entries.length > 0) {
            const topK = getQueryClassBias(queryClass).vectorTopK;
            const boostCats = new Set(getQueryClassBias(queryClass).boostCategories);
            // Prefer boosted categories when present; fall back to full set
            const searchPool =
              boostCats.size > 0 && entries.some((e) => boostCats.has(e.category))
                ? [
                    ...entries.filter((e) => boostCats.has(e.category)),
                    ...entries.filter((e) => !boostCats.has(e.category)),
                  ]
                : entries;
            const results = await vectorSearch(ctx.cwd, prompt, searchPool, topK);
            const injectThreshold = Number(getSetting(ctx.cwd, "memory_inject_similarity")) || 0.65;
            const relevant = results.filter((r) => {
              if (r.similarity <= injectThreshold) return false;
              return !emittedMemoryKeys.has(`- [${r.category}] ${r.text}`);
            });
            if (relevant.length > 0) {
              log.info("context_injected", "contextual_memories");
              const contextMemories = "# Contextually Relevant Memories\n\n" +
                relevant.map(r => `- [${r.category}] ${r.text} (similarity: ${r.similarity.toFixed(3)})`).join("\n");
              dynamicBlocks.push(contextMemories);
              // Retrieval telemetry — track what was injected
              logMemoryInjection(ctx.cwd, prompt, relevant, queryClass);
              lastInjectedMemories = relevant;
              log.info("memory_injected", relevant.length);
            }
          }
        } catch (e: any) { log.debug("vector search auto-inject failed:", e?.message?.slice(0, 100)); }
      }
    }

    // 3c. Auto-inject relevant session history (keyword search, zero LLM cost)
    if (shouldSearch) {
      try {
        const { searchSessions } = await import("./session-search.js");
        const currentSessionId = (ctx as any).sessionManager?.getSessionId?.() || undefined;
        const sessionResults = searchSessions(ctx.cwd, prompt, 3, { excludeSessionId: currentSessionId });
        if (sessionResults.length > 0) {
          log.info("context_injected", "session_history");
          const sessionContext = "# Relevant Past Sessions\n\n" +
            "Automatically retrieved from past conversation summaries:\n\n" +
            sessionResults.map(r =>
              `- **${r.timestamp.split("T")[0]}** (${r.sessionId.slice(0, 8)}): ${r.snippet.replace(/[`$]/g, "")}`
            ).join("\n");
          dynamicBlocks.push(sessionContext);
          // Telemetry — log session injections via JsonlAppendLog
          try {
            getTelemetryLog(ctx.cwd).append({
              event: "session-inject",
              prompt: prompt?.slice(0, 200),
              sessionCount: sessionResults.length,
            });
          } catch (e: any) { log.debug("session telemetry write failed:", e?.message?.slice(0, 100)); }
        }
      } catch (e: any) { log.debug("session history auto-inject failed:", e?.message?.slice(0, 100)); }
    }

    // 3d. Scoped lazy rules matched by prompt paths or queued from a prior tool_call (#1415)
    if (!isSubagent) {
      const turnLazyRules: LazyRule[] = [];
      const turnLazyNames = new Set<string>();
      if (state.pendingLazyRules.size > 0) {
        for (const rule of state.pendingLazyRules.values()) {
          if (state.deliveredLazyRules.has(rule.fileName) || turnLazyNames.has(rule.fileName)) continue;
          turnLazyNames.add(rule.fileName);
          turnLazyRules.push(rule);
        }
        state.pendingLazyRules.clear();
        state.pendingLazyRulesByCallId.clear();
      }
      if (prompt && lazyRules.length > 0) {
        const promptPaths = extractPathsFromText(prompt);
        if (promptPaths.length > 0) {
          for (const rule of lazyRules) {
            if (state.deliveredLazyRules.has(rule.fileName) || turnLazyNames.has(rule.fileName)) continue;
            if (matchLazyRule(rule, { paths: promptPaths })) {
              turnLazyNames.add(rule.fileName);
              turnLazyRules.push(rule);
            }
          }
        }
      }
      if (turnLazyRules.length > 0) {
        markLazyRulesDelivered(state, turnLazyRules);
        log.info("lazy_rules_injected", {
          hook: "before_agent_start",
          files: turnLazyRules.map((r) => r.fileName),
        });
        dynamicBlocks.push(`# Scoped Rules\n\n${formatLazyRulesMarkdown(turnLazyRules)}`);
      }
    }

    const dynamicContent = dynamicBlocks.join("\n\n").trim();
    if (!baseRules && !memories && !dynamicContent) return;

    // Inject ONLY cache-stable sections (`orchestrator_rules` and pinned
    // `project_memory`) into `systemPromptOptions.sections` so the provider
    // prompt prefix remains byte-identical across turns (#1414). Deliver all
    // per-turn dynamic context in a non-displayed custom message appended
    // after the user prompt so prefix caches stay warm on every provider.
    const opts = (event as any).systemPromptOptions;
    const forced = opts?.forceSystemPrompt !== undefined;
    const sections = opts?.sections;
    if (!forced && sections && typeof sections === "object") {
      if (baseRules) sections.orchestrator_rules = baseRules.trim();
      if (memories) sections.project_memory = memories.trim();
      if (dynamicContent) {
        return {
          message: {
            customType: "orchestrator-turn-context",
            content: dynamicContent,
            display: false,
          },
        };
      }
      return;
    }

    // Fallback: an earlier handler forced the whole prompt, or this pi
    // version does not expose systemPromptOptions — compose on top of the
    // current prompt text the legacy way so our context is not lost.
    const dynamicSuffix = dynamicContent ? `\n\n${dynamicContent}\n` : "";
    return { systemPrompt: event.systemPrompt + baseRules + memories + dynamicSuffix };
  });

  // Post-turn memory reminder: after a turn completes, check if any tool
  // results suggest relevant memories the AI should know about.
  // This catches cases where the user's prompt doesn't mention deployment
  // but the AI just modified files that have deployment-related memories.
  pi.on("turn_end", async (_event, ctx) => {
    log.info("turn_end_enter");
    if (process.env.PI_SUBAGENT_CHILD === "1") return;

    // Retrieval telemetry — detect if injected memories were used in the response.
    // Aborted or errored runs produce truncated responses — counting them as
    // "memory unused" would skew the telemetry (issue #915).
    const outcome = (_event as any).outcome as string | undefined;
    if (outcome === "aborted" || outcome === "error") {
      lastInjectedMemories = [];
    }
    try {
      const response = (_event as any).response || (_event as any).assistantMessage || "";
      if (response && lastInjectedMemories.length > 0) {
        const responseLower = typeof response === "string" ? response.toLowerCase() : "";
        if (responseLower.length > 50) {
          const used = lastInjectedMemories.filter(m =>
            responseLower.includes(m.text.toLowerCase().slice(0, 40))
          );
          if (used.length > 0 || lastInjectedMemories.length > 0) {
            logMemoryUsage(ctx.cwd, lastInjectedMemories, used);
          }
        }
        lastInjectedMemories = [];
      }
    } catch (e: any) { log.debug("telemetry usage detection failed:", e?.message?.slice(0, 100)); }

    // Semantic enforcement: check verifier rules against this turn's tool calls
    try {
      const { loadVerifierEntries, checkVerifiers } = await import("./enforcement-rules.js");
      const verifierEntries = loadVerifierEntries(ctx.cwd, (ctx as any).sessionManager?.getSessionId?.());
      if (verifierEntries.length > 0) {
        const rawResults = (_event as any).toolResults;
        if (rawResults && Array.isArray(rawResults) && rawResults.length > 0) {
          const turnToolResults = rawResults.map((tr: any) => ({
            toolName: tr?.toolName || "",
            input: tr?.input || {},
          }));
          const violations = checkVerifiers(verifierEntries, turnToolResults);

          if (violations.length > 0) {
            pi.sendMessage({
              customType: "enforcement-violation",
              content: `\u26d4 ENFORCEMENT VIOLATION \u2014 fix before continuing:\n\n${violations.map(v => `- ${v}`).join("\n")}`,
              display: true,
            }, { triggerTurn: true, deliverAs: "followUp" });
          }
        }
      }
    } catch (e: any) { log.debug("semantic enforcement failed:", e?.message?.slice(0, 100)); }

    // Check what files were modified in this turn by looking at tool results
    const toolResults = (_event as any).toolResults;
    if (!toolResults || !Array.isArray(toolResults) || toolResults.length === 0) return;

    // Extract file paths from edit/write tool results
    const modifiedPaths: string[] = [];
    for (const tr of toolResults) {
      const name = (tr as any)?.toolName;
      if (name === "edit" || name === "write") {
        const path = (tr as any)?.input?.path;
        if (typeof path === "string") modifiedPaths.push(path);
      }
    }
    if (modifiedPaths.length === 0) return;

    // Deduplicate and cap paths
    const uniquePaths = [...new Set(modifiedPaths)].slice(0, 10);

    // Search for memories related to the modified files
    // (session-scoped/expired entries filtered — Qodo #19, PR #916)
    try {
      const { vectorSearch } = await import("./memory-embeddings.js");
      const { readAllTopicEntries } = await import("./memory-tree.js");
      const { loadScores, entryHash, isEntryActiveForSession } = await import("./memory-scoring.js");
      const sessionId = (ctx as any).sessionManager?.getSessionId?.();
      const scores = loadScores(ctx.cwd);
      const entries = readAllTopicEntries(ctx.cwd).filter(
        (te) => isEntryActiveForSession(scores.entries[entryHash(`- [${te.category}] ${te.text}`)], sessionId),
      );
      if (entries.length === 0) return;

      // Build a search query from modified file paths
      const searchQuery = `files modified: ${uniquePaths.join(", ")}`;
      const results = await vectorSearch(ctx.cwd, searchQuery, entries, 3);
      const relevant = results.filter(r => r.similarity > 0.70);

      if (relevant.length > 0) {
        const reminder = relevant
          .map(r => `- [${r.category}] ${r.text}`)
          .join("\n");
        pi.sendMessage({
          customType: "memory-reminder",
          content: `📝 **Memory reminder** (based on files you just modified):\n\n${reminder}`,
          display: true,
        }, { triggerTurn: false, deliverAs: "followUp" });
      }
    } catch (e: any) {
      log.debug("turn_end memory reminder failed:", e?.message?.slice(0, 100));
    }
    log.info("turn_end_exit");
  });
}

// Loads memories using situation report (scored, token-budgeted) from topic files
function loadMemoriesWithScoring(
  cwd: string,
  isSubagent: boolean,
  tokenBudget?: number,
  queryClass: import("./memory-query-class.js").QueryClass = "general",
  preloaded?: SituationReportOptions["preloaded"],
  emittedKeys?: Set<string>,
): { report: string; failed: boolean } {
  if (!tokenBudget || tokenBudget <= 0) return { report: "", failed: false };
  try {
    const report = buildSituationReport(cwd, tokenBudget, { queryClass, preloaded, emittedKeys });
    if (report) {
      let result = "\n" + report + "\n";
      if (isSubagent) {
        result += "\n**Do NOT write to memory** \u2014 only the orchestrator writes memories.\n";
      }
      return { report: result + "\n", failed: false };
    }
    return { report: "", failed: false };
  } catch (e: any) {
    log.debug("situation report failed:", e?.message || e);
    return { report: "", failed: true };
  }
}
