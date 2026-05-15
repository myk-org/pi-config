/**
 * Memory Tools — AI-accessible tools for searching, recalling, and reinforcing memories.
 *
 * Registers pi tools that the LLM can call to interact with the memory system:
 * - memory_search: search memories by keyword
 * - memory_reinforce: reinforce an existing memory (bump evidence)
 *
 * Architecture inspired by OpenHuman (https://github.com/tinyhumansai/openhuman).
 * Clean-room TypeScript implementation under MIT — not a code translation.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadScores,
  parseMemoryFile,
  entryHash,
  reinforce,
  getActiveEntries,
} from "./memory-scoring.js";
import { listTopics, type TopicInfo } from "./memory-tree.js";

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
      const memPath = join(cwd, ".pi", "memory", "memory.md");
      if (!existsSync(memPath)) {
        return { content: [{ type: "text", text: "No memory file found." }] };
      }

      const content = readFileSync(memPath, "utf-8");
      const parsed = parseMemoryFile(content);
      const scores = loadScores(cwd);
      const queryLower = params.query.toLowerCase();

      const results = parsed
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
            section: entry.section,
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
        const pin = r.section === "pinned" ? " (pinned)" : "";
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
}
