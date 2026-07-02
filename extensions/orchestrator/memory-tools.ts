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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  loadScores,
  saveScores,
  entryHash,
  reinforce,
  getActiveEntries,
  PINNED_SCORE,
  type ScoredEntry,
} from "./memory-scoring.js";
import { listTopics, readAllTopicEntries, CATEGORY_TO_TOPIC, MAX_TOPIC_CHARS, type TopicInfo } from "./memory-tree.js";
import { embedEntry, removeEmbedding, vectorSearch, embedMissing } from "./memory-embeddings.js";

const NEAR_DUPLICATE_THRESHOLD = 0.85;

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
          console.debug("[memory] embedding migration failed, will retry next search");
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
        return `- [${r.category}] ${r.text}${pin} — score: ${typeof r.score === "number" ? r.score.toFixed(2) : r.score}, evidence: ${r.evidenceCount}${sim}`;
      });

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
        const scores = loadScores(ctx.cwd);
        const hash = entryHash(entryLine);
        const entry = scores.entries[hash];
        return {
          content: [{
            type: "text",
            text: `Reinforced: [${params.category}] ${params.entryText}\nNew evidence count: ${entry?.evidenceCount ?? "?"}, score: ${entry?.score?.toFixed(2) ?? "?"}`,
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
      "completed work. Keep entries short (one line, ~100 chars max), specific, and actionable.",
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
          description: "Semantic verifier condition (e.g., 'tool_called ask_user before gh pr merge'). Checked at turn_end.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const category = params.category;
      const text = params.text;
      const isPinned = params.pinned ?? false;

      // Validate category
      const validCategories = ["preference", "lesson", "pattern", "decision", "done", "mistake"];
      if (!validCategories.includes(category)) {
        return { content: [{ type: "text", text: `Invalid category "${category}". Valid: ${validCategories.join(", ")}` }] };
      }

      // Validate enforcement parameters
      if (params.trigger) {
        const validPrefixes = ["bash_contains ", "bash_regex ", "tool_name ", "file_modified "];
        if (!validPrefixes.some(p => params.trigger!.startsWith(p))) {
          return {
            content: [{
              type: "text",
              text: `Invalid trigger format "${params.trigger}". Must start with: ${validPrefixes.map(p => p.trim()).join(", ")}`,
            }],
          };
        }
      }
      if (params.action) {
        const validActions = ["block", "warn"];
        const isRunAfter = params.action.startsWith("run_after ");
        if (!validActions.includes(params.action) && !isRunAfter) {
          return {
            content: [{
              type: "text",
              text: `Invalid action "${params.action}". Valid: block, warn, run_after <command>`,
            }],
          };
        }
        if (isRunAfter && !params.action.slice("run_after ".length).trim()) {
          return {
            content: [{
              type: "text",
              text: `Invalid action "${params.action}". run_after requires a command (e.g., 'run_after .dev/deploy-all.sh')`,
            }],
          };
        }
      }

      // Canonical line (no markers) — used for hashing/scoring
      const canonicalLine = `- [${category}] ${text}`;
      // File line — includes markers for display
      const isEnforced = !!(params.trigger || params.action || params.verifier);
      let entryLine = canonicalLine;
      if (isPinned && isEnforced) entryLine = `- [${category}] ${text} *(pinned)* *(enforced)*`;
      else if (isPinned) entryLine = `- [${category}] ${text} *(pinned)*`;
      else if (isEnforced) entryLine = `- [${category}] ${text} *(enforced)*`;

      // Check for duplicates — vector similarity first, then exact match
      const topicEntries = readAllTopicEntries(cwd);

      // Check for near-duplicates via vector similarity (catches same lesson with different wording)
      try {
        const seen = new Set<string>();
        const sameCategoryEntries = topicEntries.filter(te => {
          if (te.category !== category || seen.has(te.text)) return false;
          seen.add(te.text);
          return true;
        });
        await embedMissing(cwd, sameCategoryEntries);
        // Embed the new entry now so vectorSearch can use the cached embedding
        // and embedEntry() later is a no-op (already in store)
        await embedEntry(cwd, text, category);
        const vectorMatches = await vectorSearch(cwd, text, sameCategoryEntries, 20);
        for (const vm of vectorMatches) {
          if (vm.similarity >= NEAR_DUPLICATE_THRESHOLD) {
            const existingLine = `- [${vm.category}] ${vm.text}`;
            if (reinforce(cwd, existingLine)) {
              // Merge enforcement fields into existing entry if new entry has them
              let merged = false;
              if (params.trigger || params.action || params.verifier) {
                const scores = loadScores(cwd);
                const existingHash = entryHash(existingLine);
                const existingEntry = scores.entries[existingHash];
                if (existingEntry) {
                  if (params.trigger) {
                    existingEntry.trigger = params.trigger as any;
                  }
                  if (params.action) {
                    if (params.action.startsWith("run_after ")) {
                      existingEntry.action = "run_after";
                      existingEntry.actionCommand = params.action.slice("run_after ".length);
                    } else if (params.action === "block" || params.action === "warn") {
                      existingEntry.action = params.action;
                    }
                  }
                  if (params.verifier) {
                    existingEntry.verifier = params.verifier;
                  }
                  saveScores(cwd, scores);
                  merged = true;
                }
              }
              // Remove the just-embedded entry since we're reinforcing instead of adding
              await removeEmbedding(cwd, text, category);
              const enforcementNote = merged ? " (enforcement fields merged)" : "";
              return {
                content: [{
                  type: "text",
                  text: `Near-duplicate found (similarity: ${vm.similarity.toFixed(3)}) — reinforced instead: [${vm.category}] ${vm.text}${enforcementNote}`,
                }],
              };
            }
            // reinforce() failed (score entry missing) — try next candidate
            continue;
          }
        }
      } catch (err) {
        console.debug(`[memory] memory_add: vector dedup skipped: ${err}`);
      }

      // Exact match check (fast O(n) string comparison after expensive vector check)
      for (const te of topicEntries) {
        if (te.text === text && te.category === category) {
          // Reinforce instead of duplicating — always use canonical line (no pinned marker)
          reinforce(cwd, canonicalLine);
          // Merge enforcement fields into existing entry if new entry has them
          let merged = false;
          if (params.trigger || params.action || params.verifier) {
            const scores = loadScores(cwd);
            const existingHash = entryHash(canonicalLine);
            const existingEntry = scores.entries[existingHash];
            if (existingEntry) {
              if (params.trigger) {
                existingEntry.trigger = params.trigger as any;
              }
              if (params.action) {
                if (params.action.startsWith("run_after ")) {
                  existingEntry.action = "run_after";
                  existingEntry.actionCommand = params.action.slice("run_after ".length);
                } else if (params.action === "block" || params.action === "warn") {
                  existingEntry.action = params.action;
                }
              }
              if (params.verifier) {
                existingEntry.verifier = params.verifier;
              }
              saveScores(cwd, scores);
              merged = true;
            }
          }
          // No removeEmbedding here — same text/category key as existing entry, embedding is still valid
          const enforcementNote = merged ? " (enforcement fields merged)" : "";
          return { content: [{ type: "text", text: `Already exists — reinforced instead: [${category}] ${text}${enforcementNote}` }] };
        }
      }

      const topicName = CATEGORY_TO_TOPIC[category as keyof typeof CATEGORY_TO_TOPIC];
      const topicsDir = join(cwd, ".pi", "memory", "topics");
      const topicPath = join(topicsDir, `${topicName}.md`);

      // Ensure directory exists
      if (!existsSync(topicsDir)) {
        mkdirSync(topicsDir, { recursive: true });
      }

      // Read or create topic file
      let content = "";
      if (existsSync(topicPath)) {
        content = readFileSync(topicPath, "utf-8");
      } else {
        const title = topicName.replace(/-/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
        content = `# ${title}\n`;
      }

      // Check topic size cap before writing
      const newContent = content.trimEnd() + "\n" + entryLine + "\n";
      if (newContent.length > MAX_TOPIC_CHARS) {
        return {
          content: [{
            type: "text",
            text: `Topic "${topicName}" would exceed size limit (${newContent.length}/${MAX_TOPIC_CHARS} chars). Consolidate or remove entries first using memory_remove.`,
          }],
        };
      }

      // Append entry
      content = newContent;
      writeFileSync(topicPath, content, "utf-8");

      // Add score entry — always hash the canonical line (no pinned marker)
      const scores = loadScores(cwd);
      const hash = entryHash(canonicalLine);
      const entry: ScoredEntry = {
        class: category,
        score: isPinned ? PINNED_SCORE : 1.0,
        evidenceCount: 1,
        cue: "explicit",
        firstSeen: new Date().toISOString(),
        lastReinforced: new Date().toISOString(),
        userState: isPinned ? "pinned" : "auto",
        lifecycle: "active",
      };

      // Add enforcement fields if provided
      if (params.trigger) {
        entry.trigger = params.trigger as any;
        // Parse action — "run_after <cmd>" splits into action + actionCommand
        if (params.action) {
          if (params.action.startsWith("run_after ")) {
            entry.action = "run_after";
            entry.actionCommand = params.action.slice("run_after ".length);
          } else if (params.action === "block" || params.action === "warn") {
            entry.action = params.action;
          }
        }
      }
      if (params.verifier) {
        entry.verifier = params.verifier;
      }

      scores.entries[hash] = entry;
      saveScores(cwd, scores);

      // Embed the new entry (no-op if already embedded during dedup check above)
      await embedEntry(cwd, text, category);

      const pin = isPinned ? " (pinned)" : "";
      return {
        content: [{ type: "text", text: `Added: [${category}] ${text}${pin}` }],
      };
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
      const validCategories = ["preference", "lesson", "pattern", "decision", "done", "mistake"];
      if (!validCategories.includes(category)) {
        return { content: [{ type: "text", text: `Invalid category "${category}". Valid: ${validCategories.join(", ")}` }] };
      }

      const topicName = CATEGORY_TO_TOPIC[category as keyof typeof CATEGORY_TO_TOPIC];
      const topicPath = join(cwd, ".pi", "memory", "topics", `${topicName}.md`);

      if (!existsSync(topicPath)) {
        return { content: [{ type: "text", text: `Topic file not found for category "${category}".` }] };
      }

      const content = readFileSync(topicPath, "utf-8");
      const pinnedEnforcedLine = `- [${category}] ${text} *(pinned)* *(enforced)*`;
      const pinnedLine = `- [${category}] ${text} *(pinned)*`;
      const enforcedLine = `- [${category}] ${text} *(enforced)*`;
      const learnedLine = `- [${category}] ${text}`;

      // Find which line matches
      const lines = content.split("\n");
      let removedLine: string | null = null;
      for (const candidate of [pinnedEnforcedLine, pinnedLine, enforcedLine, learnedLine]) {
        if (lines.some(l => l.trimEnd() === candidate)) {
          removedLine = candidate;
          break;
        }
      }

      if (!removedLine) {
        return { content: [{ type: "text", text: `Memory not found: [${category}] ${text}\nUse memory_search to find the exact text.` }] };
      }

      // Remove the line and collapse consecutive blank lines
      const newLines = lines.filter(l => l.trimEnd() !== removedLine);
      const cleaned = newLines.join("\n").replace(/\n{3,}/g, "\n\n");
      writeFileSync(topicPath, cleaned, "utf-8");

      // Remove embedding
      removeEmbedding(cwd, text, category);

      // Clean up scores — always use canonical line for hash (no pinned marker)
      const scores = loadScores(cwd);
      const canonicalLine = `- [${category}] ${text}`;
      const hash = entryHash(canonicalLine);
      if (scores.entries[hash]) {
        delete scores.entries[hash];
        saveScores(cwd, scores);
      }

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
      "Synthesize an answer from long-term memory. Instead of returning raw entries, " +
      "this tool searches memory and produces a coherent summary answering the question. " +
      "Use when you need to understand a pattern, process, or context from past sessions.",
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

      // Format as structured context for the AI to synthesize
      const memoryContext = relevant
        .slice(0, 15)
        .map(r => {
          const sim = r.similarity !== undefined ? ` (${r.similarity.toFixed(3)})` : "";
          return `- [${r.category}] ${r.text}${sim}`;
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
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const { op, text, category, newText, supersededBy } = params;

      const validCategories = ["preference", "lesson", "pattern", "decision", "done", "mistake"];
      if (!validCategories.includes(category)) {
        return { content: [{ type: "text", text: `Invalid category "${category}". Valid: ${validCategories.join(", ")}` }] };
      }

      const topicName = CATEGORY_TO_TOPIC[category as keyof typeof CATEGORY_TO_TOPIC];
      const topicPath = join(cwd, ".pi", "memory", "topics", `${topicName}.md`);

      if (!existsSync(topicPath)) {
        return { content: [{ type: "text", text: `Topic file not found for category "${category}".` }] };
      }

      const content = readFileSync(topicPath, "utf-8");
      const oldLine = `- [${category}] ${text}`;
      const oldLinePinnedEnforced = `- [${category}] ${text} *(pinned)* *(enforced)*`;
      const oldLinePinned = `- [${category}] ${text} *(pinned)*`;
      const oldLineEnforced = `- [${category}] ${text} *(enforced)*`;

      // Find the matching line
      const lines = content.split("\n");
      let matchIndex = -1;
      let wasPinned = false;
      let wasEnforced = false;
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trimEnd();
        if (trimmed === oldLinePinnedEnforced) { matchIndex = i; wasPinned = true; wasEnforced = true; break; }
        if (trimmed === oldLinePinned) { matchIndex = i; wasPinned = true; break; }
        if (trimmed === oldLineEnforced) { matchIndex = i; wasEnforced = true; break; }
        if (trimmed === oldLine) { matchIndex = i; break; }
      }

      if (matchIndex === -1) {
        return { content: [{ type: "text", text: `Memory not found: [${category}] ${text}\nUse memory_search to find the exact text.` }] };
      }

      if (op === "update") {
        if (!newText) {
          return { content: [{ type: "text", text: "newText is required for update operation." }] };
        }
        // Enforce single-line content
        if (newText.includes("\n")) {
          return { content: [{ type: "text", text: "newText must be a single line (no newlines)." }] };
        }
        // Check topic size cap
        const currentContent = readFileSync(topicPath, "utf-8");
        const markers = `${wasPinned ? " *(pinned)*" : ""}${wasEnforced ? " *(enforced)*" : ""}`;
        const newContent = currentContent.replace(lines[matchIndex], `- [${category}] ${newText}${markers}`);
        if (newContent.length > MAX_TOPIC_CHARS) {
          return { content: [{ type: "text", text: `Update would exceed topic size limit (${newContent.length}/${MAX_TOPIC_CHARS} chars).` }] };
        }
        // Replace the line
        lines[matchIndex] = `- [${category}] ${newText}${markers}`;
        writeFileSync(topicPath, lines.join("\n"), "utf-8");

        // Update scores: transfer old entry's score to new entry
        const scores = loadScores(cwd);
        const oldHash = entryHash(`- [${category}] ${text}`);
        const newHash = entryHash(`- [${category}] ${newText}`);
        if (scores.entries[oldHash]) {
          scores.entries[newHash] = { ...scores.entries[oldHash] };
          delete scores.entries[oldHash];
          saveScores(cwd, scores);
        }

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

        // Clean up scores and embeddings for old entry
        const scores = loadScores(cwd);
        const oldHash = entryHash(`- [${category}] ${text}`);
        if (scores.entries[oldHash]) {
          delete scores.entries[oldHash];
          saveScores(cwd, scores);
        }
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
      report += `3. **Identify skill candidates** — if you see a multi-step workflow (3+ steps) that recurs across entries,\n`;
      report += `   report it and suggest using /create-skill <name> to capture it.\n`;
      report += `4. **Remove stale** — if entries reference things that no longer exist or apply, use memory_remove.\n`;
      report += `5. **NEVER touch pinned entries** — they are user-explicit and permanent.\n\n`;
      report += `*Take actions using memory_edit and memory_remove. Report skill candidates for user to create.*`;

      return { content: [{ type: "text", text: report }] };
    },
  });
}

// ── registerMemoryTools (entry point) ───────────────────────────────

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
