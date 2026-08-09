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

/** Severity → styled badge for review findings */
export const SEVERITY_BADGES: Record<string, string> = {
  CRITICAL: "🔴 **CRITICAL**",
  WARNING: "🟡 **WARNING**",
  SUGGESTION: "🟢 SUGGESTION",
  INFO: "🔵 INFO",
};

/** Task status → styled badge */
export const TASK_STATUS_BADGES: Record<string, string> = {
  pending: "⏳",
  in_progress: "🔄",
  completed: "✅",
  deleted: "🗑️",
};

/** Async agent status → styled badge */
export const ASYNC_STATUS_BADGES: Record<string, string> = {
  running: "🟡 **running**",
  queued: "🟡 queued",
  complete: "🟢 **done**",
  failed: "🔴 **failed**",
  killed: "⚪ killed",
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

/** Escape markdown metacharacters in a string to prevent formatting corruption. */
function escapeMarkdown(text: string): string {
  return text.replace(/([*_~`\\[\]()#>+\-!|{}])/g, "\\$1");
}

/**
 * Wrap text in a CommonMark inline code span, safely handling backticks.
 * Uses a delimiter longer than the longest backtick run in the content.
 */
function inlineCode(text: string): string {
  const maxRun = (text.match(/`+/g) || []).reduce(
    (max, run) => Math.max(max, run.length),
    0,
  );
  const delim = "`".repeat(maxRun + 1);
  // CommonMark requires a space after/before delimiter when content starts/ends with backtick
  const needsSpace = text.startsWith("`") || text.endsWith("`");
  return needsSpace ? `${delim} ${text} ${delim}` : `${delim}${text}${delim}`;
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
 * `[from peer @ /path/to/cwd]` → `📨 **peer** \`@ /path/to/cwd\``
 * `[from peer → self @ /path/to/cwd]` → `📨 **peer** → **self** \`@ /path/to/cwd\``
 */
export function transformComsHeaders(markdown: string): string {
  return transformOutsideCodeBlocks(markdown, (text) =>
    text.replace(
      /\[from (\S+)(?: → (\S+))? @ ([^\]]+)\]/g,
      (_match, peer, self, cwd) => {
        const arrow = self ? ` → **${escapeMarkdown(self)}**` : "";
        return `📨 **${escapeMarkdown(peer)}**${arrow} ${inlineCode(`@ ${cwd.trim()}`)}`;
      },
    ),
  );
}

// ── Review findings (Deliverable 3) ──

/** Shape of a single review finding from code reviewers */
interface ReviewFinding {
  severity?: string;
  file?: string;
  line?: number;
  description?: string;
  suggestion?: string;
  impact?: string;
  rule?: string;
}

/**
 * Transform review findings JSON blocks into readable tables.
 * Matches ```json blocks containing {"findings": [...]} and renders
 * each finding with severity badges, file:line refs, and descriptions.
 */
export function transformReviewFindings(markdown: string): string {
  return markdown.replace(
    /```(?:json)?\s*\n(\{[\s\S]*?"findings"\s*:\s*\[[\s\S]*?\]\s*\})\s*\n```/g,
    (_match, jsonStr) => {
      try {
        const parsed = JSON.parse(jsonStr);
        if (!parsed || !Array.isArray(parsed.findings)) return _match;
        const findings: ReviewFinding[] = parsed.findings;
        if (findings.length === 0) return "✅ **No findings** — review passed";

        const lines: string[] = [`**${findings.length} finding${findings.length !== 1 ? "s" : ""}:**`, ""];
        for (const f of findings) {
          const sev = SEVERITY_BADGES[(f.severity || "INFO").toUpperCase()] || f.severity || "INFO";
          const loc = f.file ? `\`${f.file}${f.line ? `:${f.line}` : ""}\`` : "";
          lines.push(`${sev}${loc ? ` — ${loc}` : ""}`);
          if (f.description) lines.push(`  ${f.description}`);
          if (f.suggestion) lines.push(`  💡 ${f.suggestion}`);
          if (f.impact) lines.push(`  ⚡ ${f.impact}`);
          lines.push("");
        }
        return lines.join("\n");
      } catch {
        return _match;
      }
    },
  );
}

// ── Settings display (Deliverable 4) ──

/**
 * Transform settings display output into a styled table.
 * Matches lines like `key = value (source: project)` or `key: value`
 * from settings get output.
 */
export function transformSettingsDisplay(markdown: string): string {
  return transformOutsideCodeBlocks(markdown, (text) => {
    // Match blocks of settings lines: `key = value (source: ...)` pattern
    return text.replace(
      /^([ \t]*)([\w.]+)\s*=\s*(.+?)\s*\(source:\s*(\w+)\)\s*$/gm,
      (_match, indent, key, value, source) => {
        const sourceIcon = source === "project" ? "📁" : source === "global" ? "🌐" : source === "env" ? "🔧" : "⚙️";
        return `${indent}\`${key}\` = **${value.trim()}** ${sourceIcon} _${source}_`;
      },
    );
  });
}

// ── Task list formatting (Deliverable 5) ──

/**
 * Transform task list status markers into styled badges.
 * Matches patterns like `status: pending`, `status: in_progress`, `status: completed`
 * in task list output lines, and also `[pending]`, `[in_progress]`, `[completed]` markers.
 */
export function transformTaskStatus(markdown: string): string {
  return transformOutsideCodeBlocks(markdown, (text) => {
    // Match `status: <value>` patterns
    let result = text.replace(
      /\bstatus:\s*(pending|in_progress|completed|deleted)\b/g,
      (_match, status) => {
        const badge = TASK_STATUS_BADGES[status];
        return badge ? `status: ${badge} ${status}` : _match;
      },
    );
    // Match `[pending]`, `[in_progress]`, `[completed]` standalone markers
    result = result.replace(
      /\[(pending|in_progress|completed|deleted)\](?!\()/g,
      (_match, status) => {
        const badge = TASK_STATUS_BADGES[status];
        return badge ? `${badge} ${status}` : _match;
      },
    );
    return result;
  });
}

// ── Async agent status formatting (Deliverable 6) ──

/**
 * Transform async agent status indicators into styled badges.
 * Matches patterns like `status: running`, `[running]`, `[complete]`, etc.
 * Also formats duration strings like `duration: 45s` or `(12.3s)`.
 */
export function transformAsyncStatus(markdown: string): string {
  return transformOutsideCodeBlocks(markdown, (text) => {
    // Match `status: <value>` patterns for async agents
    let result = text.replace(
      /\bstatus:\s*(running|queued|complete|failed|killed)\b/g,
      (_match, status) => {
        const badge = ASYNC_STATUS_BADGES[status];
        return badge ? `status: ${badge}` : _match;
      },
    );
    // Match `[running]`, `[complete]`, `[failed]` standalone markers
    result = result.replace(
      /\[(running|queued|complete|failed|killed)\](?!\()/g,
      (_match, status) => {
        const badge = ASYNC_STATUS_BADGES[status];
        return badge ? badge : _match;
      },
    );
    return result;
  });
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
  result = transformSettingsDisplay(result);
  result = transformTaskStatus(result);
  result = transformAsyncStatus(result);
  // Review findings last — its output should not be mutated by other transforms
  result = transformReviewFindings(result);
  return result;
}

// ── Registration ──

export function registerMarkdownTransformer(pi: ExtensionAPI): void {
  if (typeof (pi as any).registerMarkdownTransformer !== "function") return;
  pi.registerMarkdownTransformer(transformMarkdown);
}
