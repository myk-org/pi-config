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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  loadScores,
  entryHash,
  reinforce,
  mutateScores,
  VALID_CATEGORIES,
  type MemoryCategory,
} from "./memory-scoring.js";
import {
  listTopics,
  readAllTopicEntries,
  CATEGORY_TO_TOPIC,
  MAX_TOPIC_CHARS,
  findTopicLine,
  invalidateTopicFileCache,
  type TopicInfo,
} from "./memory-tree.js";
import { embedEntry, removeEmbedding, vectorSearch, embedMissing } from "./memory-embeddings.js";
import { maybePromoteAfterReinforce } from "./memory-promotion.js";
import { addMemoryEntry } from "./memory-write.js";

const NEAR_DUPLICATE_THRESHOLD = 0.90;

// ── memory_search ────────────────────────────────────────────────────

function registerMemorySearch(pi: ExtensionAPI, state: { embeddingsMigrated: boolean }): void {
  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description:
      "Search project memories by keyword. Use before answering questions about " +
      "prior sessions, user preferences, past decisions, or recurring patterns. " +
      "Returns matching entries with their scores and categories.",
    parameters: Type.Object({
      query: Type.String({ description: "Search keyword or phrase" }),
      category: Type.Optional(
        Type.String({
          description: "Filter by category: preference, lesson, pattern, decision, done, mistake",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;

      // Read from topics (source of truth)
      const topicEntries = readAllTopicEntries(cwd);

      // Lazy migration: embed any entries missing from the vector store
      if (!state.embeddingsMigrated) {
        try {
          await embedMissing(cwd, topicEntries);
          state.embeddingsMigrated = true; // Only mark done on success
        } catch {
          log.debug("memory: embedding migration failed, will retry next search");
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
        return { content: [{ type: "text", text: "No memories found." }] };
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

      // Merge: union of keyword + vector results, deduplicated by text
      const seen = new Set<string>();
      const merged: { text: string; category: string; pinned: boolean; similarity?: number }[] = [];

      // Add vector results first (sorted by similarity)
      for (const vm of vectorMatches) {
        const dedupKey = `${vm.category}:${vm.text}`;
        if (!seen.has(dedupKey)) {
          seen.add(dedupKey);
          merged.push(vm);
        }
      }
      // Add keyword-only results (not already in vector results)
      for (const km of keywordMatches) {
        const dedupKey = `${km.category}:${km.text}`;
        if (!seen.has(dedupKey)) {
          seen.add(dedupKey);
          merged.push({ text: km.text, category: km.category, pinned: km.pinned });
        }
      }

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
        };
      }

      const lines = results.map((r) => {
        const pin = r.pinned ? " (pinned)" : "";
        const sim = r.similarity !== undefined ? `, similarity: ${r.similarity.toFixed(3)}` : "";
        const scored = scores.entries[entryHash(`- [${r.category}] ${r.text}`)];
        const provParts: string[] = [];
        if (scored?.sourceSession) provParts.push(`session: ${scored.sourceSession}`);
        if (scored?.derivedFrom) provParts.push(`from: ${scored.derivedFrom}`);
        if (scored?.informs?.length) provParts.push(`informs: ${scored.informs.join(", ")}`);
        const prov = provParts.length ? ` [${provParts.join("; ")}]` : "";
        return `- [${r.category}] ${r.text}${pin} — score: ${typeof r.score === "number" ? r.score.toFixed(2) : r.score}, evidence: ${r.evidenceCount}${sim}${prov}`;
      });

      log.info("memory_search", params.query, results.length);
      const text = `Found ${results.length} memories matching "${params.query}":\n\n${lines.join("\n")}`;
      return { content: [{ type: "text", text }] };
    },
  });
}

// ── memory_reinforce ─────────────────────────────────────────────────

function registerMemoryReinforce(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "memory_reinforce",
    label: "Memory Reinforce",
    description:
      "Reinforce an existing memory entry — call this when you notice a memory " +
      "is relevant to the current task. Bumps the evidence count and refreshes " +
      "the last-reinforced timestamp, increasing its stability score.",
    parameters: Type.Object({
      entryText: Type.String({
        description: "The exact text of the memory entry to reinforce (without category prefix)",
      }),
      category: Type.String({
        description: "Category: preference, lesson, pattern, decision, done, mistake",
      }),
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
        };
      }

      return {
        content: [{
          type: "text",
          text: `Memory not found: [${params.category}] ${params.entryText}\nUse memory_search to find the exact text.`,
        }],
      };
    },
  });
}

// ── memory_topics ────────────────────────────────────────────────────

function registerMemoryTopics(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "memory_topics",
    label: "Memory Topics",
    description:
      "List all memory topic files with their hotness scores and entry counts. " +
      "Use to understand what the project memory covers and which topics are most active.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const topics = listTopics(ctx.cwd);

      if (topics.length === 0) {
        return { content: [{ type: "text", text: "No memory topics found." }] };
      }

      const lines = topics.map((t: TopicInfo) =>
        `- **${t.name}**: ${t.entryCount} entries, hotness: ${t.hotness.toFixed(1)}, ${(t.chars / 4).toFixed(0)} tokens`
      );

      const text = `Memory topics (${topics.length}):\n\n${lines.join("\n")}`;
      return { content: [{ type: "text", text }] };
    },
  });
}

// ── memory_add ──────────────────────────────────────────────────────

function registerMemoryAdd(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "memory_add",
    label: "Memory Add",
    description:
      "Add a new memory entry. Use proactively when you learn something worth " +
      "remembering: user preferences, environment facts, corrections, conventions, " +
      "completed work. Keep entries short (one line, ~100 chars max), specific, and actionable. " +
      "One-off permissions (\"you can merge this PR\") are session instructions, NOT memories — never add them.",
    parameters: Type.Object({
      text: Type.String({ description: "The memory entry text (short, specific, actionable)" }),
      category: Type.String({
        description: "Category: preference, lesson, pattern, decision, done, mistake",
      }),
      pinned: Type.Optional(
        Type.Boolean({
          description: "Pin this memory (never decays, never removed by dreaming). Only when user explicitly says 'remember this'.",
        }),
      ),
      trigger: Type.Optional(
        Type.String({
          description: "Enforcement trigger (e.g., 'bash_contains git add .', 'tool_name write', 'file_modified *.py'). When set, this memory becomes code-enforced.",
        }),
      ),
      action: Type.Optional(
        Type.String({
          description: "Enforcement action: 'block' (prevent), 'run_after <command>' (execute after), 'warn' (append warning)",
        }),
      ),
      verifier: Type.Optional(
        Type.String({
          description: "Semantic verifier condition (e.g., 'tool_called ask_user before pushing to main'). Checked at turn_end.",
        }),
      ),
      scope: Type.Optional(
        Type.String({
          description: "Scope: 'session' (transient — expires, never injected in later sessions), 'task', or 'project' (default: durable). Only set for genuinely non-durable facts; standing rules are project scope.",
        }),
      ),
      sourceSession: Type.Optional(
        Type.String({
          description: "Optional provenance: session id or basename this memory came from",
        }),
      ),
      derivedFrom: Type.Optional(
        Type.String({
          description: "Optional provenance: short note or prior entry this was derived from",
        }),
      ),
      informs: Type.Optional(
        Type.Array(Type.String(), {
          description: "Optional provenance: what this memory informs (e.g. pr-review, git, skill name)",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // Unified write path (issue #915): validation, grant-phrase guardrail,
      // contradiction gate, dedup, topic cap, scope — all in memory-write.ts.
      const result = await addMemoryEntry(ctx.cwd, params);
      log.info("memory_add", params.category, params.text.slice(0, 60), result.status);
      return { content: [{ type: "text", text: result.message }] };
    },
  });
}

// ── memory_remove ────────────────────────────────────────────────────

function registerMemoryRemove(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "memory_remove",
    label: "Memory Remove",
    description:
      "Remove a memory entry that is no longer relevant or accurate. " +
      "Use when information is outdated, wrong, or superseded by a newer entry.",
    parameters: Type.Object({
      text: Type.String({
        description: "The exact text of the memory entry to remove (without category prefix)",
      }),
      category: Type.String({
        description: "Category: preference, lesson, pattern, decision, done, mistake",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const category = params.category;
      const text = params.text;

      // Validate category
      const validCategories = VALID_CATEGORIES;
      if (!validCategories.includes(category as MemoryCategory)) {
        return { content: [{ type: "text", text: `Invalid category "${category}". Valid: ${validCategories.join(", ")}` }] };
      }

      const topicName = CATEGORY_TO_TOPIC[category as keyof typeof CATEGORY_TO_TOPIC];
      const topicPath = join(cwd, ".pi", "memory", "topics", `${topicName}.md`);

      if (!existsSync(topicPath)) {
        return { content: [{ type: "text", text: `Topic file not found for category "${category}".` }] };
      }

      const content = readFileSync(topicPath, "utf-8");

      // Marker-agnostic match (pinned/enforced/id combinations, issue #915)
      const match = findTopicLine(content, category, text);
      if (!match) {
        return { content: [{ type: "text", text: `Memory not found: [${category}] ${text}\nUse memory_search to find the exact text.` }] };
      }

      // Remove the line and collapse consecutive blank lines
      const lines = content.split("\n");
      const newLines = lines.filter((_, i) => i !== match.index);
      const cleaned = newLines.join("\n").replace(/\n{3,}/g, "\n\n");
      writeFileSync(topicPath, cleaned, "utf-8");
      invalidateTopicFileCache(topicPath);

      // Remove embedding
      removeEmbedding(cwd, text, category);

      // Clean up scores — always use canonical line for hash (no markers).
      // Locked RMW; also drop an id-bound score entry when the line carried one.
      const canonicalLine = `- [${category}] ${text}`;
      const removedId = match.id;
      mutateScores(cwd, (scores) => {
        delete scores.entries[entryHash(canonicalLine)];
        if (removedId) {
          for (const [hash, entry] of Object.entries(scores.entries)) {
            if (entry.id === removedId) delete scores.entries[hash];
          }
        }
      });

      log.info("memory_remove", category, text.slice(0, 60));
      return {
        content: [{ type: "text", text: `Removed: [${category}] ${text}` }],
      };
    },
  });
}

// ── memory_reflect ──────────────────────────────────────────────────

function registerMemoryReflect(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "memory_reflect",
    label: "Memory Reflect",
    description:
      "Retrieve memories relevant to a question and return them as structured, " +
      "ranked context (vector + keyword, with provenance). You synthesize the " +
      "answer yourself from the returned entries. Use when you need to understand " +
      "a pattern, process, or context from past sessions.",
    parameters: Type.Object({
      query: Type.String({ description: "Question to answer from memory" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const topicEntries = readAllTopicEntries(cwd);
      if (topicEntries.length === 0) {
        return { content: [{ type: "text", text: "No memories to reflect on." }] };
      }

      // Get relevant memories via vector + keyword search
      const vectorMatches = await vectorSearch(cwd, params.query, topicEntries, 10);
      const queryLower = params.query.toLowerCase();
      const keywordMatches = topicEntries.filter(e =>
        e.text.toLowerCase().includes(queryLower)
      );

      // Merge and deduplicate
      const seen = new Set<string>();
      const relevant: { text: string; category: string; similarity?: number }[] = [];
      for (const vm of vectorMatches) {
        const dedupKey = `${vm.category}:${vm.text}`;
        if (!seen.has(dedupKey)) { seen.add(dedupKey); relevant.push(vm); }
      }
      for (const km of keywordMatches) {
        const dedupKey = `${km.category}:${km.text}`;
        if (!seen.has(dedupKey)) { seen.add(dedupKey); relevant.push({ text: km.text, category: km.category }); }
      }

      if (relevant.length === 0) {
        return { content: [{ type: "text", text: `No relevant memories found for: "${params.query}"` }] };
      }

      // Format as structured context for the AI to synthesize (include provenance when present)
      const scores = loadScores(cwd);
      const memoryContext = relevant
        .slice(0, 15)
        .map(r => {
          const sim = r.similarity !== undefined ? ` (${r.similarity.toFixed(3)})` : "";
          const scored = scores.entries[entryHash(`- [${r.category}] ${r.text}`)];
          const provParts: string[] = [];
          if (scored?.sourceSession) provParts.push(`session: ${scored.sourceSession}`);
          if (scored?.derivedFrom) provParts.push(`from: ${scored.derivedFrom}`);
          if (scored?.informs?.length) provParts.push(`informs: ${scored.informs.join(", ")}`);
          const prov = provParts.length ? ` [${provParts.join("; ")}]` : "";
          return `- [${r.category}] ${r.text}${sim}${prov}`;
        })
        .join("\n");

      const text = `## Recalled memories for: "${params.query}"\n\n${memoryContext}\n\n` +
        `*${relevant.length} memories found. Synthesize these into a coherent answer.*`;
      return { content: [{ type: "text", text }] };
    },
  });
}

// ── memory_edit ─────────────────────────────────────────────────────

function registerMemoryEdit(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "memory_edit",
    label: "Memory Edit",
    description:
      "Update, invalidate, or supersede a memory entry in-place. " +
      "Use 'update' to change content, 'invalidate' to mark as superseded by another entry. " +
      "More precise than remove+add — preserves scoring history.",
    parameters: Type.Object({
      op: Type.Union([
        Type.Literal("update"),
        Type.Literal("invalidate"),
      ], { description: "Operation: update (change content) or invalidate (supersede)" }),
      text: Type.String({ description: "Exact text of the memory entry to edit" }),
      category: Type.String({ description: "Category: preference, lesson, pattern, decision, done, mistake" }),
      newText: Type.Optional(Type.String({ description: "New text content (for update)" })),
      supersededBy: Type.Optional(Type.String({ description: "Text of the replacement entry (for invalidate)" })),
      sourceSession: Type.Optional(Type.String({ description: "Optional provenance: session id" })),
      derivedFrom: Type.Optional(Type.String({ description: "Optional provenance: derived-from note" })),
      informs: Type.Optional(Type.Array(Type.String(), { description: "Optional provenance: informs targets" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const { op, text, category, newText, supersededBy } = params;

      const validCategories = VALID_CATEGORIES;
      if (!validCategories.includes(category as MemoryCategory)) {
        return { content: [{ type: "text", text: `Invalid category "${category}". Valid: ${validCategories.join(", ")}` }] };
      }

      const topicName = CATEGORY_TO_TOPIC[category as keyof typeof CATEGORY_TO_TOPIC];
      const topicPath = join(cwd, ".pi", "memory", "topics", `${topicName}.md`);

      if (!existsSync(topicPath)) {
        return { content: [{ type: "text", text: `Topic file not found for category "${category}".` }] };
      }

      const content = readFileSync(topicPath, "utf-8");

      // Marker-agnostic match (pinned/enforced/id combinations, issue #915)
      const match = findTopicLine(content, category, text);
      if (!match) {
        return { content: [{ type: "text", text: `Memory not found: [${category}] ${text}\nUse memory_search to find the exact text.` }] };
      }
      const { index: matchIndex, pinned: wasPinned, enforced: wasEnforced, id: wasId } = match;
      const lines = content.split("\n");

      if (op === "update") {
        if (!newText) {
          return { content: [{ type: "text", text: "newText is required for update operation." }] };
        }
        // Enforce single-line content
        if (newText.includes("\n")) {
          return { content: [{ type: "text", text: "newText must be a single line (no newlines)." }] };
        }
        // Check topic size cap. The rewritten line keeps its markers and id
        // so the enforcement binding survives the text change (issue #915).
        const markers = `${wasPinned ? " *(pinned)*" : ""}${wasEnforced ? " *(enforced)*" : ""}${wasId ? ` {#${wasId}}` : ""}`;
        const replacement = `- [${category}] ${newText}${markers}`;
        const newContent = content.replace(lines[matchIndex]!, replacement);
        if (newContent.length > MAX_TOPIC_CHARS) {
          return { content: [{ type: "text", text: `Update would exceed topic size limit (${newContent.length}/${MAX_TOPIC_CHARS} chars).` }] };
        }
        // Replace the line
        lines[matchIndex] = replacement;
        writeFileSync(topicPath, lines.join("\n"), "utf-8");
        invalidateTopicFileCache(topicPath);

        // Update scores: transfer old entry's score to the new key, keeping
        // the stable id (and enforcement fields) — locked RMW (issue #915).
        const oldHash = entryHash(`- [${category}] ${text}`);
        const newHash = entryHash(`- [${category}] ${newText}`);
        mutateScores(cwd, (scores) => {
          if (scores.entries[oldHash]) {
            scores.entries[newHash] = { ...scores.entries[oldHash]! };
            delete scores.entries[oldHash];
          }
          const target = scores.entries[newHash];
          if (target) {
            if (!target.id && wasId) target.id = wasId;
            if (params.sourceSession !== undefined) target.sourceSession = params.sourceSession;
            if (params.derivedFrom !== undefined) target.derivedFrom = params.derivedFrom;
            if (params.informs !== undefined) target.informs = params.informs;
          }
        });

        // Update embeddings
        removeEmbedding(cwd, text, category);
        await embedEntry(cwd, newText, category);

        return { content: [{ type: "text", text: `Updated: [${category}] ${text}\n     → [${category}] ${newText}` }] };
      }

      if (op === "invalidate") {
        // Remove the old entry
        lines.splice(matchIndex, 1);
        const cleaned = lines.join("\n").replace(/\n{3,}/g, "\n\n");
        writeFileSync(topicPath, cleaned, "utf-8");
        invalidateTopicFileCache(topicPath);

        // Clean up scores and embeddings for old entry (locked RMW)
        const oldHash = entryHash(`- [${category}] ${text}`);
        const removedId = wasId;
        mutateScores(cwd, (scores) => {
          delete scores.entries[oldHash];
          if (removedId) {
            for (const [hash, entry] of Object.entries(scores.entries)) {
              if (entry.id === removedId) delete scores.entries[hash];
            }
          }
        });
        removeEmbedding(cwd, text, category);

        let result = `Invalidated: [${category}] ${text}`;
        if (supersededBy) {
          result += `\nSuperseded by: ${supersededBy}`;
        }
        return { content: [{ type: "text", text: result }] };
      }

      return { content: [{ type: "text", text: `Unknown operation: ${op}` }] };
    },
  });
}

// ── memory_consolidate ──────────────────────────────────────────────

function registerMemoryConsolidate(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "memory_consolidate",
    label: "Memory Consolidate",
    description:
      "Analyze all memories and produce a consolidated summary. " +
      "Identifies patterns, removes contradictions, merges related entries, " +
      "and generates reusable skills from recurring multi-step workflows. " +
      "Run periodically or when memory is getting large.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const topicEntries = readAllTopicEntries(cwd);
      if (topicEntries.length === 0) {
        return { content: [{ type: "text", text: "No memories to consolidate." }] };
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

      return { content: [{ type: "text", text: report }] };
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
