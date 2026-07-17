/**
 * Preference Auto-Extractor — detects user preferences from conversation.
 *
 * Listens to user input and automatically adds detected preference statements
 * to the preferences topic file. Uses pattern matching to find phrases like
 * "I prefer...", "always use...", "never...", etc.
 *
 * Architecture inspired by OpenHuman (https://github.com/tinyhumansai/openhuman).
 * Clean-room TypeScript implementation under MIT — not a code translation.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extractPreferences, entryHash, loadScores, saveScores } from "./memory-scoring.js";
import type { ScoredEntry } from "./memory-scoring.js";

// Debounce: don't extract from every message, only meaningful ones
const MIN_MESSAGE_LENGTH = 20;

// Cooldown: don't re-extract the same preference within 1 hour
const COOLDOWN_MS = 60 * 60 * 1000;
const recentExtractions = new Map<string, number>();

export function registerPreferenceExtractor(pi: ExtensionAPI): void {
  // Only run in the orchestrator, not in subagents
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

  pi.on("input", async (event, ctx) => {
    const text = event.text;
    if (!text || text.length < MIN_MESSAGE_LENGTH) return;
    // Skip slash commands
    if (text.startsWith("/")) return;

    const preferences = extractPreferences(text);
    if (preferences.length === 0) return;

    const topicsDir = join(ctx.cwd, ".pi", "memory", "topics");
    const prefPath = join(topicsDir, "preferences.md");

    // Ensure topics directory exists
    if (!existsSync(topicsDir)) {
      mkdirSync(topicsDir, { recursive: true });
    }

    // Read existing preferences topic file
    let content = "";
    if (existsSync(prefPath)) {
      content = readFileSync(prefPath, "utf-8");
    } else {
      content = "# Preferences\n\n";
    }

    const scores = loadScores(ctx.cwd);
    let added = 0;
    const sourceSession =
      (ctx as any).sessionManager?.getSessionId?.() || undefined;

    for (const pref of preferences) {
      const entryLine = `- [preference] ${pref}`;
      const hash = entryHash(entryLine);

      // Cooldown check
      const lastExtracted = recentExtractions.get(hash);
      if (lastExtracted && Date.now() - lastExtracted < COOLDOWN_MS) continue;

      // Check if already exists
      if (content.includes(pref)) {
        // Reinforce existing entry
        if (scores.entries[hash]) {
          scores.entries[hash]!.evidenceCount += 1;
          scores.entries[hash]!.lastReinforced = new Date().toISOString();
          if (sourceSession && !scores.entries[hash]!.sourceSession) {
            scores.entries[hash]!.sourceSession = sourceSession;
          }
        }
        recentExtractions.set(hash, Date.now());
        continue;
      }

      // Append to preferences topic file
      content = content.trimEnd() + "\n" + entryLine + "\n";

      // Add score entry
      scores.entries[hash] = {
        class: "preference",
        score: 1.0,
        evidenceCount: 1,
        cue: "explicit",
        firstSeen: new Date().toISOString(),
        lastReinforced: new Date().toISOString(),
        userState: "auto",
        lifecycle: "active",
        ...(sourceSession ? { sourceSession } : {}),
      } as ScoredEntry;

      recentExtractions.set(hash, Date.now());
      added++;
    }

    if (added > 0) {
      writeFileSync(prefPath, content, "utf-8");
      saveScores(ctx.cwd, scores);
    }
  });
}
