/**
 * Preference Auto-Extractor — detects user preferences from conversation.
 *
 * Listens to user input and routes detected preference statements through the
 * unified memory write path (memory-write.ts, issue #915). Extraction filters
 * out questions and one-off permission grants; the write path enforces the
 * topic cap, near-duplicate dedup, and the contradiction gate — the extractor
 * no longer bypasses any memory_add safeguard.
 *
 * Architecture inspired by OpenHuman (https://github.com/tinyhumansai/openhuman).
 * Clean-room TypeScript implementation under MIT — not a code translation.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../shared/logger.js";
import { extractPreferences, entryHash } from "./memory-scoring.js";
import { addMemoryEntry } from "./memory-write.js";

const log = createLogger("memory");

// Debounce: don't extract from every message, only meaningful ones
const MIN_MESSAGE_LENGTH = 20;

// Cooldown: don't re-extract the same preference within 1 hour. Tracked
// per pending write and only STAMPED once the write actually lands (added or
// reinforced) — a rejected write (conflict gate, cap, guardrail) must not
// suppress the next attempt for an hour (Qodo #14, PR #916).
const COOLDOWN_MS = 60 * 60 * 1000;
const recentExtractions = new Map<string, number>();

// Pending fire-and-forget writes — drained on session shutdown so a write is
// never lost to process exit (Qodo #13, PR #916).
const pendingWrites = new Set<Promise<unknown>>();

export function registerPreferenceExtractor(pi: ExtensionAPI): void {
  // Only run in the orchestrator, not in subagents
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

  pi.on("session_shutdown", async () => {
    if (pendingWrites.size === 0) return;
    const pending = [...pendingWrites];
    log.debug("preference-extractor: draining pending memory writes on shutdown", pending.length);
    try {
      await Promise.allSettled(pending);
    } catch {
      // allSettled never rejects — belt and braces
    }
    log.info("preference-extractor: drained pending memory writes", pending.length);
  });

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
      const hash = entryHash(`- [preference] ${pref}`);

      // Cooldown check (against LANDED writes only)
      const lastExtracted = recentExtractions.get(hash);
      if (lastExtracted && Date.now() - lastExtracted < COOLDOWN_MS) continue;

      // Fire-and-forget: the write path may load the embedding model on first
      // use (~2.7s) — never block user input on it. The promise is tracked so
      // session_shutdown can drain it before the process exits.
      const write = addMemoryEntry(ctx.cwd, {
        text: pref,
        category: "preference",
        sourceSession,
      })
        .then((result) => {
          log.info("preference_extracted", pref.slice(0, 60), result.status);
          // Stamp cooldown only on success — a rejected write must retry
          if (result.status !== "rejected") {
            recentExtractions.set(hash, Date.now());
          }
        })
        .catch((err) => {
          log.warn("preference extraction failed:", err?.message || err);
        })
        .finally(() => {
          pendingWrites.delete(write);
        });
      pendingWrites.add(write);
    }
  });
}
