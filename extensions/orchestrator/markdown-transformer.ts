/**
 * Markdown transformer for rich TUI display formatting.
 *
 * Transforms assistant message markdown for display only —
 * doesn't affect stored messages or model context.
 *
 * Uses pi 0.84.0's registerMarkdownTransformer() API.
 */

import type {
  ExtensionAPI,
  MarkdownTransformContext,
} from "@earendil-works/pi-coding-agent";

// ── Badge definitions ──

/** Memory category → styled badge (inline code for visual distinction in TUI) */
export const MEMORY_BADGES: Record<string, string> = {
  preference: "`🎯 pref`",
  lesson: "`📝 lesson`",
  mistake: "`⚠️ mistake`",
  pattern: "`🔄 pattern`",
  decision: "`📌 decision`",
  done: "`✅ done`",
};

/** Memory section header → emoji prefix */
const SECTION_ICONS: Record<string, string> = {
  "Active Preferences": "🎯",
  "Active Lessons": "📝",
  "Vetoes & Mistakes": "⚠️",
  Patterns: "🔄",
  "Recent Decisions": "📌",
  "Recent Completions": "✅",
  Pinned: "📌",
  "Project Memory": "🧠",
};

// ── Code block protection ──

/**
 * Apply a transform function only to text outside fenced code blocks.
 * Code blocks (``` or ~~~) are preserved as-is.
 */
export function transformOutsideCodeBlocks(
  markdown: string,
  transform: (text: string) => string,
): string {
  const parts = markdown.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g);
  return parts
    .map((part, i) => (i % 2 === 1 ? part : transform(part)))
    .join("");
}

// ── Transform functions (exported for testing) ──

/**
 * Transform memory category tags into styled badges.
 * Matches `- [category] text` in memory list items.
 */
export function transformMemoryBadges(markdown: string): string {
  return transformOutsideCodeBlocks(markdown, (text) =>
    text.replace(
      /^(- )\[(preference|lesson|mistake|pattern|decision|done)\] /gm,
      (_match, prefix, category) => {
        const badge = MEMORY_BADGES[category];
        return badge ? `${prefix}${badge} ` : _match;
      },
    ),
  );
}

/**
 * Transform memory section headers with emoji icons.
 * `## Active Preferences` → `## 🎯 Active Preferences`
 *
 * Only matches exact section header lines (end-of-line or followed by ` [`
 * for the Project Memory capacity header).
 */
export function transformMemorySectionHeaders(markdown: string): string {
  const sectionPattern = Object.keys(SECTION_ICONS)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const re = new RegExp(
    `^(#{1,3}) (${sectionPattern})(?= \\[|$)`,
    "gm",
  );
  return transformOutsideCodeBlocks(markdown, (text) =>
    text.replace(re, (_match, hashes, section) => {
      const icon = SECTION_ICONS[section];
      return icon ? `${hashes} ${icon} ${section}` : _match;
    }),
  );
}

/**
 * Transform coms message headers with styled formatting.
 * `[from peer @ /path/to/cwd]` → `📨 **peer** _@ /path/to/cwd_`
 */
export function transformComsHeaders(markdown: string): string {
  return transformOutsideCodeBlocks(markdown, (text) =>
    text.replace(
      /\[from (\S+) @ ([^\]]+)\]/g,
      (_match, peer, cwd) => `📨 **${peer}** _@ ${cwd.trim()}_`,
    ),
  );
}

// ── Main dispatcher ──

/**
 * Main markdown transformer — dispatches to individual transformers.
 * Only transforms completed assistant messages; skips streaming to avoid flicker.
 */
export function transformMarkdown(
  markdown: string,
  context: MarkdownTransformContext,
): string {
  if (context.messageType !== "assistant" || context.isStreaming) {
    return markdown;
  }

  let result = markdown;
  result = transformMemoryBadges(result);
  result = transformMemorySectionHeaders(result);
  result = transformComsHeaders(result);
  return result;
}

// ── Registration ──

export function registerMarkdownTransformer(pi: ExtensionAPI): void {
  pi.registerMarkdownTransformer(transformMarkdown);
}
