/**
 * Memory Tools — AI-accessible tools for searching, recalling, and reinforcing memories.
 *
 * Registers pi tools that the LLM can call to interact with the memory system:
 * - memory_search: search memories by keyword
 * - memory_reinforce: reinforce an existing memory (bump evidence)
 * - memory_add: add a new memory entry
 * - memory_remove: remove an outdated or incorrect memory entry
 * - memory_topics: list all memory topic files with hotness scores
 *
 * Architecture inspired by OpenHuman (https://github.com/tinyhumansai/openhuman).
 * Clean-room TypeScript implementation under MIT — not a code translation.
 */

import { createLogger } from "../shared/logger.js";
import { READ_ONLY_LOCAL_ANNOTATIONS, TOOL_NAMESPACES } from "../shared/tool-namespaces.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  loadScores,
  entryHash,
  isEntryActiveForSession,
  reinforce,
  VALID_CATEGORIES,
  type ScoredEntry,
} from "./memory-scoring.js";
import {
  listTopics,
  readAllTopicEntries,
  type TopicInfo,
} from "./memory-tree.js";
import { vectorSearch, embedMissing } from "./memory-embeddings.js";
import { maybePromoteAfterReinforce } from "./memory-promotion.js";
import { addMemoryEntry, editMemoryEntry, formatNotFoundWithCandidates, removeMemoryEntry } from "./memory-store.js";

const CATEGORY_DESC = "preference|lesson|pattern|decision|done|mistake";

// ── Shared search & formatting helpers ──────────────────────────────

interface SearchHit {
  text: string;
  category: string;
  pinned: boolean;
  similarity?: number;
}

function mergeSearchHits(
  vectorMatches: readonly SearchHit[],
  keywordMatches: readonly SearchHit[],
): SearchHit[] {
  const seen = new Set<string>();
  const merged: SearchHit[] = [];
  for (const vm of vectorMatches) {
    const dedupKey = `${vm.category}:${vm.text}`;
    if (!seen.has(dedupKey)) {
      seen.add(dedupKey);
      merged.push(vm);
    }
  }
  for (const km of keywordMatches) {
    const dedupKey = `${km.category}:${km.text}`;
    if (!seen.has(dedupKey)) {
      seen.add(dedupKey);
      merged.push({ text: km.text, category: km.category, pinned: km.pinned });
    }
  }
  return merged;
}

function formatProvenance(scored: ScoredEntry | undefined): string {
  const provParts: string[] = [];
  if (scored?.sourceSession) provParts.push(`session: ${scored.sourceSession}`);
  if (scored?.derivedFrom) provParts.push(`from: ${scored.derivedFrom}`);
  if (scored?.informs?.length) provParts.push(`informs: ${scored.informs.join(", ")}`);
  return provParts.length ? ` [${provParts.join("; ")}]` : "";
}

// ── memory_search ────────────────────────────────────────────────────

function registerMemorySearch(pi: ExtensionAPI, state: { embeddingsMigrated: boolean }): void {
  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    exposure: "codemode",
    namespace: TOOL_NAMESPACES.memory,
    annotations: READ_ONLY_LOCAL_ANNOTATIONS,
    description: "Search memories by keyword and similarity; returns matches with scores and categories.",
    parameters: Type.Object({
      query: Type.String({ description: "Keyword or phrase" }),
      category: Type.Optional(
        Type.String({ description: CATEGORY_DESC }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;

      // Read from topics (source of truth)
      const topicEntries = readAllTopicEntries(cwd);

      // Lazy migration: embed any entries missing from the vector store
      if (!state.embeddingsMigrated) {
        try {
          const embedded = await embedMissing(cwd, topicEntries);
          if (embedded >= 0) {
            state.embeddingsMigrated = true; // Only mark done on success
          } else {
            log.warn("memory: embedding migration failed, will retry next search");
          }
        } catch (err) {
          log.warn("memory: embedding migration failed, will retry next search", {}, err);
        }
      }
      const scores = loadScores(cwd);
      const queryLower = params.query.toLowerCase();

      // Build searchable entries from topics
      const searchEntries = topicEntries.map((te) => ({
        text: te.text,
        category: te.category,
        pinned: te.pinned,
        fullLine: `- [${te.category}] ${te.text}`,
      }));

      if (searchEntries.length === 0) {
        return { content: [{ type: "text", text: "No memories found." }], details: undefined };
      }

      // Keyword substring search (existing behavior)
      const keywordMatches = searchEntries
        .filter((entry) => {
          if (params.category && entry.category !== params.category) return false;
          return entry.text.toLowerCase().includes(queryLower) ||
            entry.category.includes(queryLower);
        });

      // Vector similarity search (additive — merges with keyword results)
      const vectorMatches = await vectorSearch(
        cwd,
        params.query,
        searchEntries.filter((e) => !params.category || e.category === params.category),
      );

      // Merge: union of keyword + vector results, deduplicated by category+text
      const merged = mergeSearchHits(
        vectorMatches,
        keywordMatches.map((km) => ({ text: km.text, category: km.category, pinned: km.pinned })),
      );

      const results = merged
        .map((entry) => {
          const canonLine = `- [${entry.category}] ${entry.text}`;
          const hash = entryHash(canonLine);
          const scored = scores.entries[hash];
          return {
            text: entry.text,
            category: entry.category,
            pinned: entry.pinned,
            score: scored?.score ?? 0,
            lifecycle: scored?.lifecycle ?? "unknown",
            evidenceCount: scored?.evidenceCount ?? 0,
            lastReinforced: scored?.lastReinforced ?? "unknown",
            similarity: entry.similarity,
          };
        })
        // Sort: pinned first, then by combined rank (similarity + stability score)
        .sort((a, b) => {
          if (a.pinned && !b.pinned) return -1;
          if (!a.pinned && b.pinned) return 1;
          const aRank = (a.similarity ?? 0) * 100 + (a.score ?? 0);
          const bRank = (b.similarity ?? 0) * 100 + (b.score ?? 0);
          return bRank - aRank;
        })
        .slice(0, 30);

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `No memories found matching "${params.query}".` }],
          details: undefined,
        };
      }

      const lines = results.map((r) => {
        const pin = r.pinned ? " (pinned)" : "";
        const sim = r.similarity !== undefined ? `, similarity: ${r.similarity.toFixed(3)}` : "";
        const scored = scores.entries[entryHash(`- [${r.category}] ${r.text}`)];
        const prov = formatProvenance(scored);
        return `- [${r.category}] ${r.text}${pin} — score: ${typeof r.score === "number" ? r.score.toFixed(2) : r.score}, evidence: ${r.evidenceCount}${sim}${prov}`;
      });

      log.info("memory_search", params.query, results.length);
      const text = `Found ${results.length} memories matching "${params.query}":\n\n${lines.join("\n")}`;
      return { content: [{ type: "text", text }], details: undefined };
    },
  });
}

// ── memory_reinforce ─────────────────────────────────────────────────

function registerMemoryReinforce(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "memory_reinforce",
    label: "Memory Reinforce",
    exposure: "codemode",
    namespace: TOOL_NAMESPACES.memory,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: "Reinforce a relevant memory; bumps evidence count and stability score.",
    parameters: Type.Object({
      entryText: Type.String({ description: "Exact text (no category prefix)" }),
      category: Type.String({ description: CATEGORY_DESC }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const entryLine = `- [${params.category}] ${params.entryText}`;
      const reinforced = reinforce(ctx.cwd, entryLine);

      if (reinforced) {
        log.info("memory_reinforce", params.entryText.slice(0, 60));
        const scores = loadScores(ctx.cwd);
        const hash = entryHash(entryLine);
        const entry = scores.entries[hash];
        let promoNote = "";
        try {
          const promo = maybePromoteAfterReinforce(ctx.cwd, entryLine);
          if (promo && (promo.applied > 0 || promo.queued > 0)) {
            promoNote = `\nPromotion pass: applied=${promo.applied}, proposed=${promo.queued}` +
              (promo.details.length ? ` (${promo.details.join("; ")})` : "");
          }
        } catch (e: any) {
          log.debug("memory: promote-after-reinforce failed:", e?.message || e);
        }
        return {
          content: [{
            type: "text",
            text: `Reinforced: [${params.category}] ${params.entryText}\nNew evidence count: ${entry?.evidenceCount ?? "?"}, score: ${entry?.score?.toFixed(2) ?? "?"}${promoNote}`,
          }],
          details: undefined,
        };
      }

      return {
        content: [{
          type: "text",
          text: `Memory not found: [${params.category}] ${params.entryText}\nUse memory_search to find the exact text.`,
        }],
        details: undefined,
      };
    },
  });
}

// ── memory_topics ────────────────────────────────────────────────────

function registerMemoryTopics(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "memory_topics",
    label: "Memory Topics",
    exposure: "codemode",
    namespace: TOOL_NAMESPACES.memory,
    annotations: READ_ONLY_LOCAL_ANNOTATIONS,
    description: "List topic files with hotness scores, entry counts, and token sizes.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const topics = listTopics(ctx.cwd);

      if (topics.length === 0) {
        return { content: [{ type: "text", text: "No memory topics found." }], details: undefined };
      }

      const lines = topics.map((t: TopicInfo) =>
        `- **${t.name}**: ${t.entryCount} entries, hotness: ${t.hotness.toFixed(1)}, ${(t.chars / 4).toFixed(0)} tokens`
      );

      const text = `Memory topics (${topics.length}):\n\n${lines.join("\n")}`;
      return { content: [{ type: "text", text }], details: undefined };
    },
  });
}

// ── memory_add ──────────────────────────────────────────────────────

function registerMemoryAdd(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "memory_add",
    label: "Memory Add",
    exposure: "codemode",
    namespace: TOOL_NAMESPACES.memory,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: "Add a short, actionable memory (~100 chars, one line). Never add one-off grants or task-scoped asks.",
    parameters: Type.Object({
      text: Type.String({ description: "One-line actionable text" }),
      category: Type.String({ description: CATEGORY_DESC }),
      pinned: Type.Optional(
        Type.Boolean({ description: "Pin permanently (user-explicit only)" }),
      ),
      trigger: Type.Optional(
        Type.String({
          description: "'bash_contains <str>'|'bash_regex <re>'|'tool_name <name>'|'file_modified <glob>'",
        }),
      ),
      action: Type.Optional(
        Type.String({ description: "'block'|'run_after <cmd>'|'warn'" }),
      ),
      verifier: Type.Optional(
        Type.String({ description: "Turn-end check, e.g. 'tool_called ask_user before git push'" }),
      ),
      scope: Type.Optional(
        Type.String({ description: "'session'|'task'|'project' (default)" }),
      ),
      overrideConflicts: Type.Optional(
        Type.Boolean({ description: "True only after ask_user confirms rule change" }),
      ),
      sourceSession: Type.Optional(
        Type.String({ description: "Source session id" }),
      ),
      derivedFrom: Type.Optional(
        Type.String({ description: "Prior entry or source note" }),
      ),
      informs: Type.Optional(
        Type.Array(Type.String(), { description: "Targets informed (e.g. git, pr-review)" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // Unified write path (issue #915, #1354): validation, grant-phrase guardrail,
      // contradiction gate, dedup, topic cap, scope — all in memory-store.ts.
      // Session-scoped writes carry the current session id when the caller
      // did not supply one, so scope eligibility can be evaluated later.
      if (params.scope === "session" && !params.sourceSession) {
        const sid = (ctx as any).sessionManager?.getSessionId?.();
        if (sid) params.sourceSession = sid;
      }
      const result = await addMemoryEntry(ctx.cwd, params);
      log.info("memory_add", params.category, params.text.slice(0, 60), result.status);
      return { content: [{ type: "text", text: result.message }], details: undefined };
    },
  });
}

// ── memory_remove ────────────────────────────────────────────────────

function registerMemoryRemove(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "memory_remove",
    label: "Memory Remove",
    exposure: "codemode",
    namespace: TOOL_NAMESPACES.memory,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: "Remove an outdated, wrong, or superseded memory.",
    parameters: Type.Object({
      text: Type.String({ description: "Exact text (no category prefix)" }),
      category: Type.String({ description: CATEGORY_DESC }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const category = params.category;
      const text = params.text;

      const res = removeMemoryEntry(cwd, category, text, { recordTombstone: true });
      if (res.status === "invalid_category") {
        return { content: [{ type: "text", text: `Invalid category "${category}". Valid: ${VALID_CATEGORIES.join(", ")}` }], details: undefined };
      }
      if (res.status === "topic_missing") {
        return { content: [{ type: "text", text: `Topic file not found for category "${category}".` }], details: undefined };
      }
      if (res.status === "not_found") {
        return { content: [{ type: "text", text: formatNotFoundWithCandidates(category, text, res.candidates) }], details: undefined };
      }

      log.info("memory_remove", category, text.slice(0, 60));
      return {
        content: [{ type: "text", text: `Removed: [${category}] ${text}` }],
        details: undefined,
      };
    },
  });
}

// ── memory_reflect ──────────────────────────────────────────────────

function registerMemoryReflect(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "memory_reflect",
    label: "Memory Reflect",
    exposure: "codemode",
    namespace: TOOL_NAMESPACES.memory,
    annotations: READ_ONLY_LOCAL_ANNOTATIONS,
    description: "Recall ranked memories (vector + keyword, with provenance) for a question.",
    parameters: Type.Object({
      query: Type.String({ description: "Question to answer from memory" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      // Session-scoped and expired entries are filtered out first (Qodo #1,
      // PR #916): recalled context must never surface a one-off session
      // grant or an entry past its TTL as if it were a standing rule.
      const sessionId = (ctx as any).sessionManager?.getSessionId?.();
      const scores0 = loadScores(cwd);
      const topicEntries = readAllTopicEntries(cwd).filter(
        (te) => isEntryActiveForSession(scores0.entries[entryHash(`- [${te.category}] ${te.text}`)], sessionId),
      );
      if (topicEntries.length === 0) {
        return { content: [{ type: "text", text: "No memories to reflect on." }], details: undefined };
      }

      // Get relevant memories via vector + keyword search
      const vectorMatches = await vectorSearch(cwd, params.query, topicEntries, 10);
      const queryLower = params.query.toLowerCase();
      const keywordMatches = topicEntries.filter(e =>
        e.text.toLowerCase().includes(queryLower)
      );

      // Merge and deduplicate
      const relevant = mergeSearchHits(
        vectorMatches,
        keywordMatches.map((km) => ({ text: km.text, category: km.category, pinned: km.pinned })),
      );

      if (relevant.length === 0) {
        return { content: [{ type: "text", text: `No relevant memories found for: "${params.query}"` }], details: undefined };
      }

      // Format as structured context for the AI to synthesize (include provenance when present)
      const scores = loadScores(cwd);
      const memoryContext = relevant
        .slice(0, 15)
        .map(r => {
          const sim = r.similarity !== undefined ? ` (${r.similarity.toFixed(3)})` : "";
          const scored = scores.entries[entryHash(`- [${r.category}] ${r.text}`)];
          const prov = formatProvenance(scored);
          return `- [${r.category}] ${r.text}${sim}${prov}`;
        })
        .join("\n");

      const text = `## Recalled memories for: "${params.query}"\n\n${memoryContext}\n\n` +
        `*${relevant.length} memories found. Synthesize these into a coherent answer.*`;
      return { content: [{ type: "text", text }], details: undefined };
    },
  });
}

// ── memory_edit ─────────────────────────────────────────────────────

function registerMemoryEdit(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "memory_edit",
    label: "Memory Edit",
    exposure: "codemode",
    namespace: TOOL_NAMESPACES.memory,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    description: "Update or invalidate a memory in-place, preserving scoring history.",
    parameters: Type.Object({
      op: Type.Union([
        Type.Literal("update"),
        Type.Literal("invalidate"),
      ], { description: "'update'|'invalidate'" }),
      text: Type.String({ description: "Exact entry text" }),
      category: Type.String({ description: CATEGORY_DESC }),
      newText: Type.Optional(Type.String({ description: "New text (update)" })),
      supersededBy: Type.Optional(Type.String({ description: "Replacement text (invalidate)" })),
      sourceSession: Type.Optional(Type.String({ description: "Source session id" })),
      derivedFrom: Type.Optional(Type.String({ description: "Derived-from note" })),
      informs: Type.Optional(Type.Array(Type.String(), { description: "Targets informed" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const { op, text, category, newText, supersededBy } = params;

      if (op === "invalidate") {
        // Shared removal path — single read/remove, preserving non-tombstoned semantics.
        const res = removeMemoryEntry(cwd, category, text, { recordTombstone: false });
        if (res.status === "invalid_category") {
          return { content: [{ type: "text", text: `Invalid category "${category}". Valid: ${VALID_CATEGORIES.join(", ")}` }], details: undefined };
        }
        if (res.status === "topic_missing") {
          return { content: [{ type: "text", text: `Topic file not found for category "${category}".` }], details: undefined };
        }
        if (res.status === "not_found") {
          return { content: [{ type: "text", text: formatNotFoundWithCandidates(category, text, res.candidates) }], details: undefined };
        }

        let result = `Invalidated: [${category}] ${text}`;
        if (supersededBy) {
          result += `\nSuperseded by: ${supersededBy}`;
        }
        return { content: [{ type: "text", text: result }], details: undefined };
      }

      if (op === "update") {
        const res = await editMemoryEntry(cwd, {
          category,
          text,
          newText: newText ?? "",
          sourceSession: params.sourceSession,
          derivedFrom: params.derivedFrom,
          informs: params.informs,
        });
        return { content: [{ type: "text", text: res.message }], details: undefined };
      }

      return { content: [{ type: "text", text: `Unknown operation: ${op}` }], details: undefined };
    },
  });
}

// ── memory_consolidate ──────────────────────────────────────────────

function registerMemoryConsolidate(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "memory_consolidate",
    label: "Memory Consolidate",
    exposure: "deferred",
    namespace: TOOL_NAMESPACES.memory,
    annotations: READ_ONLY_LOCAL_ANNOTATIONS,
    description: "Group all memories by category for conflict resolution, merging, pruning, and promotion.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const topicEntries = readAllTopicEntries(cwd);
      if (topicEntries.length === 0) {
        return { content: [{ type: "text", text: "No memories to consolidate." }], details: undefined };
      }

      // Group entries by category
      const byCategory: Record<string, string[]> = {};
      for (const entry of topicEntries) {
        if (!byCategory[entry.category]) byCategory[entry.category] = [];
        byCategory[entry.category].push(`${entry.pinned ? "(pinned) " : ""}${entry.text}`);
      }

      // Build consolidation prompt for the AI
      let report = `## Memory Consolidation Report\n\n`;
      report += `**Total entries:** ${topicEntries.length}\n`;
      report += `**Categories:** ${Object.keys(byCategory).join(", ")}\n\n`;

      for (const [cat, entries] of Object.entries(byCategory)) {
        report += `### ${cat} (${entries.length})\n`;
        for (const e of entries) {
          report += `- ${e}\n`;
        }
        report += "\n";
      }

      report += `## Instructions\n\n`;
      report += `Review the above memories and take ALL of these actions:\n`;
      report += `1. **Identify contradictions** — if two entries conflict, keep the newer/more specific one. Use memory_edit to invalidate the stale one.\n`;
      report += `2. **Merge duplicates** — if entries say the same thing differently, keep the best version. Use memory_edit to update.\n`;
      report += `3. **Promotion destinations** — append candidates to \`.pi/memory/promotions.md\` with destination:\n`;
      report += `   \`memory\` | \`skill\` | \`enforcement\` | \`project_rule\` | \`discard\`.\n`;
      report += `   - skill: suggest /create-skill or note existing .pi/skills/; set skill_created if you write one\n`;
      report += `   - enforcement: propose trigger/action when mechanical; do not invent run_after\n`;
      report += `   - project_rule: propose only — NEVER write rules/ or .pi/rules/\n`;
      report += `   Block format: ### <id> then fields destination, status: proposed, category, text, reason, created\n`;
      report += `4. **Remove stale** — if entries reference things that no longer exist or apply, use memory_remove.\n`;
      report += `5. **NEVER touch pinned entries** — they are user-explicit and permanent.\n\n`;
      report += `*Take actions using memory_edit and memory_remove. Write promotions.md for graduation candidates.*`;

      return { content: [{ type: "text", text: report }], details: undefined };
    },
  });
}

// ── registerMemoryTools (entry point) ───────────────────────────────

const log = createLogger("memory");

export function registerMemoryTools(pi: ExtensionAPI): void {
  // Only register in the orchestrator, not subagents
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

  const state = { embeddingsMigrated: false };

  registerMemorySearch(pi, state);
  registerMemoryReinforce(pi);
  registerMemoryTopics(pi);
  registerMemoryAdd(pi);
  registerMemoryRemove(pi);
  registerMemoryReflect(pi);
  registerMemoryEdit(pi);
  registerMemoryConsolidate(pi);
}
