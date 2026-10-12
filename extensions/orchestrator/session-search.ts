/**
 * Session Search — keyword search over past conversation summaries.
 *
 * Indexes conversation summaries (pi's own LLM-written compaction and branch
 * summaries, harvested from the session file) into a JSONL store with simple
 * keyword matching. Provides a tool for the LLM to recall past discussions
 * at zero LLM cost.
 *
 * Inspired by Hermes Agent's session search layer.
 * JSONL persistence (issue #915 / #724 pattern) — no native deps.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createLogger } from "../shared/logger.js";
import { getProjectDataDir } from "./utils.js";
import { createCachedStore } from "./state-jsonl.js";
import type { JsonlStateStore } from "./state-jsonl.js";

const log = createLogger("memory");

// ── Storage ────────────────────────────────────────────────────────────────

interface SessionEntry {
  sessionId: string;
  timestamp: string;
  summary: string;
}

interface SessionStore {
  entries: SessionEntry[];
}

const STORE_FILENAME_JSONL = "session-search.jsonl";
const LEGACY_STORE_FILENAME = "session-search.json";

function getStore(cwd: string): JsonlStateStore<SessionStore> {
  return createCachedStore<SessionStore>(
    getProjectDataDir(cwd), STORE_FILENAME_JSONL, LEGACY_STORE_FILENAME, { compactThreshold: 50 },
  );
}

function getStorePath(cwd: string): string {
  return join(getProjectDataDir(cwd), STORE_FILENAME_JSONL);
}

function loadStore(cwd: string): SessionStore {
  const data = getStore(cwd).read();
  if (data === null) return { entries: [] };
  if (!data || typeof data !== "object" || !Array.isArray(data.entries)) {
    log.warn("session-search: corrupt store shape, resetting");
    return { entries: [] };
  }
  // Filter to only valid entries
  const entries = data.entries.filter(
    (e: unknown): e is SessionEntry =>
      typeof e === "object" && e !== null &&
      typeof (e as any).sessionId === "string" &&
      typeof (e as any).timestamp === "string" &&
      typeof (e as any).summary === "string"
  );
  return { entries };
}

function saveStore(cwd: string, store: SessionStore): void {
  getStore(cwd).write(store);
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

// ── Harvest pi session summaries ──────────────────────────────────────────

/**
 * Extract the LLM-written summaries pi persists in a session JSONL file
 * (issue #915): compaction summaries and branch summaries are real
 * summaries, far better input for session search than joined user messages.
 */
export function extractSessionSummaries(sessionFilePath: string): string[] {
  if (!existsSync(sessionFilePath)) return [];
  try {
    const raw = readFileSync(sessionFilePath, "utf-8");
    const summaries: string[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        if (
          (entry?.type === "compaction" || entry?.type === "branch_summary") &&
          typeof entry?.summary === "string" &&
          entry.summary.length >= 50
        ) {
          summaries.push(entry.summary);
        }
      } catch {
        continue; // skip corrupt/truncated lines
      }
    }
    return summaries;
  } catch {
    return [];
  }
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
  let sessionFile = "";

  pi.on("session_start", (_event, ctx) => {
    sessionMessages = [];
    sessionCwd = ctx.cwd;
    sessionId = ctx.sessionManager?.getSessionId?.() || `session-${Date.now()}`;
    sessionFile = (ctx as any).sessionManager?.getSessionFile?.() || "";
  });

  pi.on("input", (event, _ctx) => {
    const text = event?.text;
    if (!text || text.length < 15) return;
    // Skip slash commands and system-injected text
    if (text.startsWith("/") || text.startsWith("[IMPORTANT:") || text.startsWith("[SYSTEM:")) return;
    sessionMessages.push(text.slice(0, 200));
  });

  // Index compaction summaries when context is compacted
  pi.on("session_compact", (event, ctx) => {
    try {
      // Overflow retries produce the real summary on the next attempt —
      // indexing the aborted attempt would duplicate content (issue #915).
      if ((event as any)?.willRetry) {
        log.debug("session-search: skipping willRetry compaction summary");
        return;
      }
      const summary = event?.compactionEntry?.summary;
      if (!summary || summary.length < 50) return;
      const cwd = sessionCwd || ctx.cwd;
      const sid = sessionId || ctx.sessionManager?.getSessionId?.() || `session-${Date.now()}`;
      indexSessionSummary(cwd, sid, summary);
      log.debug("session-search: indexed compaction summary", { reason: (event as any)?.reason });
    } catch (err) {
      log.warn("session-search: indexing failed on compact:", err);
    }
  });

  // Index summaries on session shutdown — prefer pi's own LLM-written
  // compaction and branch summaries from the session file (issue #915);
  // fall back to joined user messages when none exist.
  pi.on("session_shutdown", (_event, ctx) => {
    try {
      if (!sessionCwd) return;
      const file = sessionFile || (ctx ? (ctx as any).sessionManager?.getSessionFile?.() || "" : "");
      const summaries = file ? extractSessionSummaries(file) : [];

      if (summaries.length > 0) {
        for (const summary of summaries) {
          indexSessionSummary(sessionCwd, sessionId, summary);
        }
        log.info("session-search: harvested session summaries", summaries.length);
        return;
      }

      // Fallback: crude join of user messages (pre-#915 behavior)
      if (sessionMessages.length < 3) return;
      const summary = sessionMessages.join(" | ").slice(0, 1000);
      indexSessionSummary(sessionCwd, sessionId, summary);
    } catch (err) {
      log.warn("session-search: indexing failed on shutdown:", err);
    }
  });
}
