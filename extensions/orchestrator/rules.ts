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
import { buildSituationReport, estimateMemoryBudget, rebuildAndOrganize, type SituationReportOptions } from "./situation-report.js";
import { classifyQueryClass, getQueryClassBias } from "./memory-query-class.js";
import { getSetting, getSettingDynamic, SETTINGS_KEYS } from "./project-settings.js";
import { assembleRuleText } from "./rule-placeholders.js";
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
  fileCount: number;
  includedCount: number;
  skippedCount: number;
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

function loadOrAssembleRules(
  cwd: string,
  packageRulesDir = PACKAGE_RULES_DIR,
  sessionKey?: string,
  interactiveTui = process.env.PI_COMS_SUPERVISED_PEER !== "1",
): string {
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
    return "\n\n[ORCHESTRATOR RULES] You are a MANAGER. Delegate work to subagents.\n";
  }

  const sorted = [...ruleCandidates.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const ruleContents: string[] = [];
  const sigParts: string[] = [];

  for (const [fileName, candidates] of sorted) {
    let loaded = false;
    for (let i = candidates.length - 1; i >= 0; i--) {
      const filePath = candidates[i]!;
      const loadedEntry = readRuleFileCached(fileName, filePath);
      if (!loadedEntry) continue;
      sigParts.push(`${fileName}:${filePath}:${loadedEntry.stamp}`);
      if (loadedEntry.content !== null) {
        ruleContents.push(loadedEntry.content);
      }
      loaded = true;
      break;
    }
    if (!loaded) {
      log.debug(`${fileName}: all candidates failed, skipping`);
    }
  }

  if (ruleContents.length === 0) {
    return "\n\n[ORCHESTRATOR RULES] You are a MANAGER. Delegate work to subagents.\n";
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
      skipped: cached.skippedCount,
      cached: true,
    });
    return "\n\n" + cached.joined;
  }

  log.debug("assembling rules", { count: ruleContents.length, reviewLoopMaxCycles, interactiveTui });
  let includedCount = 0;
  let skippedCount = 0;
  const accessed = new Map<string, unknown>();
  const resolveTracked = (key: string): unknown => {
    const val = getSettingDynamic(cwd, key);
    if (!accessed.has(key)) accessed.set(key, val);
    return val;
  };
  const joined = assembleRuleText(ruleContents, {
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
      fileCount: ruleContents.length,
      includedCount,
      skippedCount,
    },
    ASSEMBLED_RULES_CACHE_MAX,
  );
  log.info("rules assembled", {
    chars: joined.length,
    files: ruleContents.length,
    included: includedCount,
    skipped: skippedCount,
  });
  return "\n\n" + joined;
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

export function registerRules(
  pi: ExtensionAPI,
  getAsyncJobs?: () => Array<{ id: string; agent: string; name?: string; task: string; status: string; startedAt: number }>,
  options?: { packageRulesDir?: string },
): void {
  const isSubagent = process.env.PI_SUBAGENT_CHILD === "1";
  let rebuildDone = false;


  // Run full rebuild on session start (once per session, not every turn)
  pi.on("session_start", async (_event, ctx) => {
    rebuildDone = false;
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

  pi.on("before_agent_start", async (event, ctx) => {
    // Run rebuild on first agent start if session_start didn't fire yet
    if (!rebuildDone) {
      try {
        rebuildAndOrganize(ctx.cwd);
        rebuildDone = true;
      } catch (e: any) { log.debug("rebuildAndOrganize on agent_start failed:", e?.message || e); }
    }
    let extra = "";

    // Orchestrator rules — skip for specialist agents
    // Load from: package rules/ → user ~/.pi/agent/rules/ → project .pi/rules/
    // Same-filename override: project > user > package
    if (!isSubagent) {
      const interactiveTui =
        process.env.PI_COMS_SUPERVISED_PEER !== "1" &&
        ctx.hasUI !== false &&
        (ctx.mode === undefined || ctx.mode === "tui");
      extra += loadOrAssembleRules(ctx.cwd, options?.packageRulesDir, resolveBridgeSessionKey(ctx), interactiveTui);
    }

    // Async agent status — always show so the AI knows what's running.
    // Built separately from `extra` so ticking durations don't invalidate
    // `sections.orchestrator_rules` on every turn (#1178).
    let asyncStatus = "";
    if (!isSubagent && getAsyncJobs) {
      const jobs = getAsyncJobs();
      if (jobs.length === 0) {
        asyncStatus = "\n\n# Async Agents Status\n\nNo async agents running.\n";
      } else {
        let status = `\n\n# Async Agents Status\n\n${jobs.length} async agent(s) running — kill any that are no longer needed:\n`;
        for (const j of jobs) {
          const elapsed = formatDuration(Date.now() - j.startedAt);
          status += `- ${j.name || j.agent} (${j.agent}) — ${elapsed}\n`;
        }
        asyncStatus = status;
      }
      log.debug("async_agents_status_built", { jobCount: jobs.length, chars: asyncStatus.length });
    }

    // 1.4.0's BeforeAgentStartEvent is a union: `prompt` exists only on the user
    // variant, so narrow once here and use this for every downstream lookup.
    const prompt = event.messageType === "user" ? event.prompt : undefined;

    // Project memories — situation report (scored, token-budgeted) injected BEFORE rules
    // systemPrompt.length is chars; estimateMemoryBudget converts internally
    const budget = estimateMemoryBudget(event.systemPrompt?.length ?? 0, undefined, ctx.cwd);
    const queryClass =
      !isSubagent && prompt && !isSocialCloser(prompt)
        ? classifyQueryClass(prompt)
        : "general";
    const shouldSearch = !isSubagent && !!prompt && !isSocialCloser(prompt);

    // Load scores + topic entries once per turn when either situation report or
    // contextual recall needs them, avoiding duplicate disk reads and stat calls.
    // Fail-soft: a store lock/migration error must never abort the agent turn.
    let preloaded: SituationReportOptions["preloaded"];
    if (budget > 0 || shouldSearch) {
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
        log.debug("memory preload failed:", e?.message?.slice(0, 100));
      }
    }

    const emittedMemoryKeys = new Set<string>();
    const memories = loadMemoriesWithScoring(ctx.cwd, isSubagent, budget, queryClass, preloaded, emittedMemoryKeys);

    // Auto-inject contextually relevant memories via vector search (~2.5ms, in-process)
    // Session-scoped/expired entries AND entries already emitted verbatim in
    // `# Project Memory` are excluded so pinned/high-score entries are not injected twice.
    let contextMemories = "";
    if (shouldSearch && preloaded && preloaded.topicEntries.length > 0) {
      try {
        const { vectorSearch } = await import("./memory-embeddings.js");
        const { canonicalTopicLine } = await import("./memory-tree.js");
        const { entryHash, isEntryActiveForSession } = await import("./memory-scoring.js");
        const sessionId = (ctx as any).sessionManager?.getSessionId?.();
        const entries = preloaded.topicEntries.filter((te) => {
          const canon = canonicalTopicLine(te);
          if (emittedMemoryKeys.has(canon)) return false;
          return isEntryActiveForSession(preloaded.scores.entries[entryHash(canon)], sessionId);
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
            contextMemories = "\n# Contextually Relevant Memories\n\n" +
              relevant.map(r => `- [${r.category}] ${r.text} (similarity: ${r.similarity.toFixed(3)})`).join("\n") +
              "\n\n";
            // Retrieval telemetry — track what was injected
            logMemoryInjection(ctx.cwd, prompt, relevant, queryClass);
            lastInjectedMemories = relevant;
            log.info("memory_injected", relevant.length);
          }
        }
      } catch (e: any) { log.debug("vector search auto-inject failed:", e?.message?.slice(0, 100)); }
    }

    // Auto-inject relevant session history (keyword search, zero LLM cost)
    let sessionContext = "";
    if (shouldSearch) {
      try {
        const { searchSessions } = await import("./session-search.js");
        const currentSessionId = (ctx as any).sessionManager?.getSessionId?.() || undefined;
        const sessionResults = searchSessions(ctx.cwd, prompt, 3, { excludeSessionId: currentSessionId });
        if (sessionResults.length > 0) {
          log.info("context_injected", "session_history");
          sessionContext = "\n# Relevant Past Sessions\n\n" +
            "Automatically retrieved from past conversation summaries:\n\n" +
            sessionResults.map(r =>
              `- **${r.timestamp.split("T")[0]}** (${r.sessionId.slice(0, 8)}): ${r.snippet.replace(/[`$]/g, "")}`
            ).join("\n") +
            "\n\n";
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

    if (!extra && !asyncStatus && !memories && !contextMemories && !sessionContext) return;

    // Inject as structured system-prompt sections (issue #915): mutating
    // systemPromptOptions.sections lets pi append a transcript delta that
    // preserves cached prompt prefixes. Returning a full systemPrompt string
    // would replace the whole prompt every run and defeat prefix caching.
    // Custom sections render after cwd — still the tail position, where
    // attention is highest (U-shaped attention curve).
    const opts = (event as any).systemPromptOptions;
    const forced = opts?.forceSystemPrompt !== undefined;
    const sections = opts?.sections;
    if (!forced && sections && typeof sections === "object") {
      if (extra) sections.orchestrator_rules = extra.trim();
      if (asyncStatus) sections.async_agents_status = asyncStatus.trim();
      if (memories) sections.project_memory = memories.trim();
      if (contextMemories) sections.contextual_memories = contextMemories.trim();
      if (sessionContext) sections.past_sessions = sessionContext.trim();
      return;
    }

    // Fallback: an earlier handler forced the whole prompt, or this pi
    // version does not expose systemPromptOptions — compose on top of the
    // current prompt text the legacy way so our context is not lost.
    return { systemPrompt: event.systemPrompt + extra + asyncStatus + memories + contextMemories + sessionContext };
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
): string {
  if (!tokenBudget || tokenBudget <= 0) return "";
  try {
    const report = buildSituationReport(cwd, tokenBudget, { queryClass, preloaded, emittedKeys });
    if (report) {
      let result = "\n" + report + "\n";
      if (isSubagent) {
        result += "\n**Do NOT write to memory** \u2014 only the orchestrator writes memories.\n";
      }
      return result + "\n";
    }
  } catch (e: any) { log.debug("situation report failed:", e?.message || e); }
  return "";
}
