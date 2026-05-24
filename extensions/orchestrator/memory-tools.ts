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
import { listTopics, readAllTopicEntries, CATEGORY_TO_TOPIC, type TopicInfo } from "./memory-tree.js";

export function registerMemoryTools(pi: ExtensionAPI): void {
  // Only register in the orchestrator, not subagents
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

  // ── memory_search ────────────────────────────────────────────────────

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

      const results = searchEntries
        .filter((entry) => {
          if (params.category && entry.category !== params.category) return false;
          return entry.text.toLowerCase().includes(queryLower) ||
            entry.category.includes(queryLower);
        })
        .map((entry) => {
          const hash = entryHash(entry.fullLine);
          const scored = scores.entries[hash];
          return {
            text: entry.text,
            category: entry.category,
            pinned: entry.pinned,
            score: scored?.score ?? 0,
            lifecycle: scored?.lifecycle ?? "unknown",
            evidenceCount: scored?.evidenceCount ?? 0,
            lastReinforced: scored?.lastReinforced ?? "unknown",
          };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, 20);

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `No memories found matching "${params.query}".` }],
        };
      }

      const lines = results.map((r) => {
        const pin = r.pinned ? " (pinned)" : "";
        return `- [${r.category}] ${r.text}${pin} — score: ${typeof r.score === "number" ? r.score.toFixed(2) : r.score}, evidence: ${r.evidenceCount}, lifecycle: ${r.lifecycle}`;
      });

      const text = `Found ${results.length} memories matching "${params.query}":\n\n${lines.join("\n")}`;
      return { content: [{ type: "text", text }] };
    },
  });

  // ── memory_reinforce ─────────────────────────────────────────────────

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

  // ── memory_topics ────────────────────────────────────────────────────

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

  // ── memory_add ──────────────────────────────────────────────────────

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

      // Build entry line
      const entryLine = isPinned
        ? `- [${category}] ${text} *(pinned)*`
        : `- [${category}] ${text}`;

      // Check for duplicates
      const topicEntries = readAllTopicEntries(cwd);
      for (const te of topicEntries) {
        if (te.text === text && te.category === category) {
          // Reinforce instead of duplicating
          const reinforceLine = te.pinned
            ? `- [${category}] ${text} *(pinned)*`
            : `- [${category}] ${text}`;
          reinforce(cwd, reinforceLine);
          return { content: [{ type: "text", text: `Already exists — reinforced instead: [${category}] ${text}` }] };
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

      // Append entry
      content = content.trimEnd() + "\n" + entryLine + "\n";
      writeFileSync(topicPath, content, "utf-8");

      // Add score entry
      const scores = loadScores(cwd);
      const hash = entryHash(entryLine);
      scores.entries[hash] = {
        class: category,
        score: isPinned ? PINNED_SCORE : 1.0,
        evidenceCount: 1,
        cue: "explicit",
        firstSeen: new Date().toISOString(),
        lastReinforced: new Date().toISOString(),
        userState: isPinned ? "pinned" : "auto",
        lifecycle: "active",
      } as ScoredEntry;
      saveScores(cwd, scores);

      const pin = isPinned ? " (pinned)" : "";
      return {
        content: [{ type: "text", text: `Added: [${category}] ${text}${pin}` }],
      };
    },
  });

  // ── memory_remove ────────────────────────────────────────────────────

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
      const pinnedLine = `- [${category}] ${text} *(pinned)*`;
      const learnedLine = `- [${category}] ${text}`;

      // Find which line matches
      const lines = content.split("\n");
      let removedLine: string | null = null;
      for (const candidate of [pinnedLine, learnedLine]) {
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

      // Clean up scores
      const scores = loadScores(cwd);
      const hash = entryHash(removedLine);
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
