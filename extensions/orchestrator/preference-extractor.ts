/**
 * Preference Auto-Extractor — detects user preferences from conversation.
 *
 * Listens to user input and automatically adds detected preference statements
 * to the memory file. Uses pattern matching to find phrases like "I prefer...",
 * "always use...", "never...", etc.
 *
 * Architecture inspired by OpenHuman (https://github.com/tinyhumansai/openhuman).
 * Clean-room TypeScript implementation under MIT — not a code translation.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
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

    const memDir = join(ctx.cwd, ".pi", "memory");
    const memPath = join(memDir, "memory.md");

    // Ensure memory directory exists
    if (!existsSync(memDir)) {
      mkdirSync(memDir, { recursive: true });
    }

    // Read existing memory file
    let content = "";
    if (existsSync(memPath)) {
      content = readFileSync(memPath, "utf-8");
    } else {
      content = "# Memories\n\n## Pinned (user requested — never auto-remove)\n\n## Learned (auto-extracted — dream may reorganize/remove)\n";
    }

    const scores = loadScores(ctx.cwd);
    let added = 0;

    for (const pref of preferences) {
      const entryLine = `- [preference] ${pref}`;
      const hash = entryHash(entryLine);

      // Cooldown check
      const lastExtracted = recentExtractions.get(hash);
      if (lastExtracted && Date.now() - lastExtracted < COOLDOWN_MS) continue;

      // Check if already exists in memory
      if (content.includes(pref)) {
        // Reinforce existing entry
        if (scores.entries[hash]) {
          scores.entries[hash]!.evidenceCount += 1;
          scores.entries[hash]!.lastReinforced = new Date().toISOString();
        }
        recentExtractions.set(hash, Date.now());
        continue;
      }

      // Add to Learned section
      const learnedMarker = "## Learned";
      const learnedIdx = content.indexOf(learnedMarker);
      if (learnedIdx !== -1) {
        const afterMarker = content.indexOf("\n", learnedIdx);
        if (afterMarker !== -1) {
          // Find the next non-empty line after the section header
          let insertIdx = afterMarker + 1;
          // Skip the section description line if present
          const nextLine = content.indexOf("\n", insertIdx);
          if (nextLine !== -1 && content.slice(insertIdx, nextLine).trim().startsWith("-")) {
            // There are already entries, insert before first entry
          } else if (nextLine !== -1) {
            insertIdx = nextLine + 1;
          }
          content = content.slice(0, insertIdx) + entryLine + "\n" + content.slice(insertIdx);
        }
      }

      // Add score entry
      scores.entries[hash] = {
        class: "preference",
        score: 1.0, // explicit cue weight × fresh recency
        evidenceCount: 1,
        cue: "explicit",
        firstSeen: new Date().toISOString(),
        lastReinforced: new Date().toISOString(),
        userState: "auto",
        lifecycle: "active",
      } as ScoredEntry;

      recentExtractions.set(hash, Date.now());
      added++;
    }

    if (added > 0) {
      writeFileSync(memPath, content, "utf-8");
      saveScores(ctx.cwd, scores);
    }
  });
}
