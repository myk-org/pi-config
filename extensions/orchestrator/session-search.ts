/**
 * Session Search — keyword search over past conversation summaries.
 *
 * Indexes compacted conversation summaries into a JSON file with simple
 * keyword matching. Provides a tool for the LLM to recall past discussions
 * at zero LLM cost.
 *
 * Inspired by Hermes Agent's session search layer.
 * Uses JSON storage instead of SQLite for portability (no native deps).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ── Storage ────────────────────────────────────────────────────────────────

interface SessionEntry {
  sessionId: string;
  timestamp: string;
  summary: string;
}

interface SessionStore {
  entries: SessionEntry[];
}

function getStorePath(cwd: string): string {
  return join(cwd, ".pi", "data", "session-search.json");
}

function loadStore(cwd: string): SessionStore {
  const storePath = getStorePath(cwd);
  if (!existsSync(storePath)) return { entries: [] };
  try {
    const raw = JSON.parse(readFileSync(storePath, "utf-8"));
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.entries)) {
      console.error("[session-search] corrupt store shape, resetting");
      return { entries: [] };
    }
    // Filter to only valid entries
    const entries = raw.entries.filter(
      (e: unknown): e is SessionEntry =>
        typeof e === "object" && e !== null &&
        typeof (e as any).sessionId === "string" &&
        typeof (e as any).timestamp === "string" &&
        typeof (e as any).summary === "string"
    );
    return { entries };
  } catch (err) {
    console.error("[session-search] corrupt store, resetting:", err);
    return { entries: [] };
  }
}

function saveStore(cwd: string, store: SessionStore): void {
  const dir = join(cwd, ".pi", "data");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(getStorePath(cwd), JSON.stringify(store, null, 2), "utf-8");
}

// ── Index a session summary ────────────────────────────────────────────────

export function indexSessionSummary(
  cwd: string,
  sessionId: string,
  summary: string,
): void {
  if (!summary || !summary.trim()) return;
  const store = loadStore(cwd);

  // Avoid duplicate entries for the same session
  const exists = store.entries.some(
    (e) => e.sessionId === sessionId && e.summary === summary.trim(),
  );
  if (exists) return;

  store.entries.push({
    sessionId,
    timestamp: new Date().toISOString(),
    summary: summary.trim(),
  });

  // Keep max 500 entries (oldest dropped)
  if (store.entries.length > 500) {
    store.entries = store.entries.slice(-500);
  }

  saveStore(cwd, store);
}

// ── Search sessions ────────────────────────────────────────────────────────

export interface SearchResult {
  sessionId: string;
  timestamp: string;
  snippet: string;
  score: number;
}

export function searchSessions(
  cwd: string,
  query: string,
  limit: number = 10,
): SearchResult[] {
  const store = loadStore(cwd);
  if (store.entries.length === 0) return [];

  const queryWords = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (queryWords.length === 0) return [];

  const results: SearchResult[] = [];

  for (const entry of store.entries) {
    const summaryLower = entry.summary.toLowerCase();

    // Score: count how many query words match
    let matchCount = 0;
    for (const word of queryWords) {
      if (summaryLower.includes(word)) matchCount++;
    }

    if (matchCount === 0) continue;

    // Extract snippet around first match
    const firstWord = queryWords.find((w) => summaryLower.includes(w))!;
    const matchIdx = summaryLower.indexOf(firstWord);
    const snippetStart = Math.max(0, matchIdx - 80);
    const snippetEnd = Math.min(entry.summary.length, matchIdx + 120);
    let snippet = entry.summary.slice(snippetStart, snippetEnd).trim();
    if (snippetStart > 0) snippet = "..." + snippet;
    if (snippetEnd < entry.summary.length) snippet = snippet + "...";

    results.push({
      sessionId: entry.sessionId,
      timestamp: entry.timestamp,
      snippet,
      score: matchCount / queryWords.length,
    });
  }

  // Sort by score (desc), then recency (desc)
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.timestamp.localeCompare(a.timestamp);
  });

  return results.slice(0, limit);
}



// ── Tool Registration ──────────────────────────────────────────────────────

export function registerSessionSearch(pi: ExtensionAPI): void {
  // Only register in the orchestrator, not subagents
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

  pi.registerTool({
    name: "session_search",
    label: "Session Search",
    description:
      "Search past conversation summaries by keyword. Use when the user references " +
      "something from a past session, or when you need to recall what was discussed " +
      "previously. Returns matching snippets from past sessions at zero LLM cost.",
    parameters: Type.Object({
      query: Type.String({
        description: "Search query — keywords or phrases to find in past conversations",
      }),
      limit: Type.Optional(
        Type.Number({
          description: "Max results to return (default: 10)",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const results = searchSessions(ctx.cwd, params.query, params.limit ?? 10);

      if (results.length === 0) {
        return {
          content: [{
            type: "text",
            text: `No past sessions found matching "${params.query}".`,
          }],
        };
      }

      const lines = results.map((r) =>
        `**${r.timestamp.split("T")[0]}** (${r.sessionId.slice(0, 8)})\n${r.snippet}`
      );

      return {
        content: [{
          type: "text",
          text: `Found ${results.length} past session(s) matching "${params.query}":\n\n${lines.join("\n\n---\n\n")}`,
        }],
      };
    },
  });

  // Accumulate user messages for session-end indexing
  let sessionMessages: string[] = [];
  let sessionCwd = "";
  let sessionId = "";

  pi.on("session_start", (_event, ctx) => {
    sessionMessages = [];
    sessionCwd = ctx.cwd;
    sessionId = ctx.sessionManager?.getSessionId?.() || `session-${Date.now()}`;
  });

  pi.on("input", (event, _ctx) => {
    const text = event?.text;
    if (!text || text.length < 15) return;
    // Skip slash commands and system-injected text
    if (text.startsWith("/") || text.startsWith("[IMPORTANT:") || text.startsWith("[SYSTEM:")) return;
    sessionMessages.push(text.slice(0, 200));
  });

  // Index compaction summaries when context is compacted
  pi.on("session_compact", (event, _ctx) => {
    try {
      const summary = event?.compactionEntry?.summary;
      if (!summary || summary.length < 50) return;
      indexSessionSummary(sessionCwd, sessionId, summary);
    } catch (err) {
      console.error("[session-search] indexing failed on compact:", err);
    }
  });

  // Index accumulated messages on session shutdown
  pi.on("session_shutdown", () => {
    try {
      if (sessionMessages.length < 3 || !sessionCwd) return;
      const summary = sessionMessages.join(" | ").slice(0, 1000);
      indexSessionSummary(sessionCwd, sessionId, summary);
    } catch (err) {
      console.error("[session-search] indexing failed on shutdown:", err);
    }
  });
}
