/**
 * Preference Auto-Extractor — detects user preference statements from
 * conversation and queues them for dreaming review (issue #961).
 *
 * The extractor no longer lands memories directly. Regex extraction fires
 * on PHRASE, not meaning, so direct writes stored verbatim sentences —
 * including half-finished, task-scoped thoughts — as durable preferences
 * (e.g. "for the tag normalization we should have maping for datadog in
 * the settings, i always prefer to have", cut mid-sentence at the 100-char
 * topic-line cap). Candidates now go to
 * .pi/memory/preference-candidates.jsonl (full sentence, source session)
 * and dreaming distills/lands only the durable standing preferences.
 * Questions, one-off grants, and task-scoped instructions are filtered
 * before queueing; the LLM path (memory_add + guardrails) remains for
 * immediate capture.
 *
 * Architecture inspired by OpenHuman (https://github.com/tinyhumansai/openhuman).
 * Clean-room TypeScript implementation under MIT — not a code translation.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import { join } from "node:path";
import { createLogger } from "../shared/logger.js";
import { extractPreferences } from "./memory-scoring.js";
import { getProjectMemoryDir } from "./utils.js";

const log = createLogger("memory");

// Debounce: don't extract from every message, only meaningful ones
const MIN_MESSAGE_LENGTH = 20;

// Candidate queue bounds: the file stays small (dreaming consumes it each
// cycle), but a repo where dreaming never runs must not grow it unbounded.
const MAX_CANDIDATES = 200;
const CANDIDATE_FILE = "preference-candidates.jsonl";

export function candidateQueuePath(cwd: string): string {
  return join(getProjectMemoryDir(cwd), CANDIDATE_FILE);
}

interface PreferenceCandidate {
  text: string;
  sourceSession: string | null;
  timestamp: string;
}

function readCandidates(file: string): PreferenceCandidate[] {
  try {
    return fs
      .readFileSync(file, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          const parsed = JSON.parse(line) as Partial<PreferenceCandidate>;
          return {
            text: String(parsed.text ?? ""),
            sourceSession: parsed.sourceSession ?? null,
            timestamp: String(parsed.timestamp ?? ""),
          };
        } catch {
          return null; // malformed line — dropped below
        }
      })
      .filter((c): c is PreferenceCandidate => c !== null && c.text.length > 0);
  } catch {
    return []; // no file yet
  }
}

/** Append a preference candidate for dreaming review. Synchronous by
 *  design: a single sub-millisecond line append. APPEND-ONLY (Qodo PR
 *  #964): the old read-modify-write lost a concurrent session's candidate
 *  when both read the same snapshot and each replaced the whole file.
 *  `appendFileSync` composes line appends from concurrent writers — the
 *  read-before-append dedup keeps the common case duplicate-free, and a
 *  race-window duplicate is harmless (dreaming dedups at distillation).
 *  The size cap is enforced during dream compaction, not here: a rewrite
 *  here would reintroduce the lost-update race. */
export function appendPreferenceCandidate(
  cwd: string,
  text: string,
  sourceSession?: string,
): "queued" | "duplicate" {
  const file = candidateQueuePath(cwd);
  const existing = readCandidates(file);
  if (existing.some((c) => c.text === text)) return "duplicate";
  fs.appendFileSync(
    file,
    JSON.stringify({ text, sourceSession: sourceSession ?? null, timestamp: new Date().toISOString() }) + "\n",
  );
  return "queued";
}

/** Read the pending preference candidates (used by dreaming tooling/tests). */
export function readPreferenceCandidates(cwd: string): PreferenceCandidate[] {
  return readCandidates(candidateQueuePath(cwd));
}

export function registerPreferenceExtractor(pi: ExtensionAPI): void {
  // Only run in the orchestrator, not in subagents
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

  pi.on("input", (event, ctx) => {
    const text = event.text;
    if (!text || text.length < MIN_MESSAGE_LENGTH) return;
    // Skip slash commands
    if (text.startsWith("/")) return;

    const preferences = extractPreferences(text);
    if (preferences.length === 0) return;

    const sourceSession =
      (ctx as any).sessionManager?.getSessionId?.() || undefined;

    for (const pref of preferences) {
      try {
        const status = appendPreferenceCandidate(ctx.cwd, pref, sourceSession);
        // Routine queue/duplicate writes are debug, not info (Qodo PR
        // #964): every user message with a preference-shaped sentence
        // logs here — the queue file itself is the record, and info-level
        // noise drowns real events. Failures stay warn.
        log.debug("preference_candidate", status, pref.slice(0, 60));
      } catch (err) {
        log.warn("preference candidate queue append failed:", (err as Error)?.message || err);
      }
    }
  });
}
