/**
 * Extended autocomplete — argument completions for slash commands.
 *
 * Two mechanisms:
 * 1. getArgumentCompletions on extension commands (dream-auto, pidash, etc.)
 *    — injected via registerCommand wrapping
 * 2. addAutocompleteProvider for prompt templates (acpx-prompt, review-local, etc.)
 *    — stacked provider that intercepts /command <arg> patterns
 *
 * Completions:
 *   /acpx-prompt <Tab>           → acpx agent names + --fix, --peer
 *   /pr-review <Tab>             → open PR numbers
 *   /coderabbit-rate-limit <Tab> → open PR numbers
 *   /review-local <Tab>          → git branch names
 *   /release <Tab>               → recent git tags
 *   /review-handler <Tab>        → --autorabbit
 *   /dream-auto <Tab>            → on, off
 *   /pidash <Tab>                → start, stop, restart, status
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@mariozechner/pi-tui";
import { fuzzyFilter } from "@mariozechner/pi-tui";

// ── Cache infrastructure ────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface Cache<T> {
  data: T | undefined;
  timestamp: number;
  loading: boolean;
}

function createCache<T>(): Cache<T> {
  return { data: undefined, timestamp: 0, loading: false };
}

function isFresh<T>(cache: Cache<T>): boolean {
  return !!cache.data && Date.now() - cache.timestamp < CACHE_TTL_MS;
}

// ── Static completions ──────────────────────────────────────────────

const ACPX_AGENTS: AutocompleteItem[] = [
  "pi", "openclaw", "codex", "claude", "gemini", "cursor",
  "copilot", "droid", "iflow", "kilocode", "kimi", "kiro", "opencode", "qwen",
].map((a) => ({ value: a, label: a, description: "acpx agent" }));

const ACPX_FLAGS: AutocompleteItem[] = [
  { value: "--fix", label: "--fix", description: "Agent can modify files" },
  { value: "--peer", label: "--peer", description: "AI-to-AI peer review loop" },
];

// ── Filter helper ───────────────────────────────────────────────────

const MAX_SUGGESTIONS = 20;

function filter(items: AutocompleteItem[], prefix: string): AutocompleteItem[] | null {
  if (!prefix.trim()) {
    const result = items.slice(0, MAX_SUGGESTIONS);
    return result.length > 0 ? result : null;
  }
  const filtered = fuzzyFilter(items, prefix, (item) => `${item.label} ${item.description || ""}`)
    .slice(0, MAX_SUGGESTIONS);
  return filtered.length > 0 ? filtered : null;
}

// ── Registration ────────────────────────────────────────────────────

export function registerExtendedAutocomplete(pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

  // Caches (populated lazily on first Tab)
  const prCache = createCache<AutocompleteItem[]>();
  const branchCache = createCache<AutocompleteItem[]>();
  const tagCache = createCache<AutocompleteItem[]>();
  let lastCwd = "";

  // ── Fetchers ────────────────────────────────────────────────────

  async function fetchOpenPRs(cwd: string): Promise<void> {
    if (isFresh(prCache) || prCache.loading) return;
    prCache.loading = true;
    try {
      const result = await pi.exec(
        "gh", ["pr", "list", "--state", "open", "--limit", "50", "--json", "number,title"],
        { cwd, timeout: 10_000 },
      );
      if (result.code === 0) {
        const prs = JSON.parse(result.stdout) as Array<{ number: number; title: string }>;
        prCache.data = prs.map((pr) => ({
          value: String(pr.number),
          label: `#${pr.number}`,
          description: pr.title,
        }));
        prCache.timestamp = Date.now();
      }
    } catch {}
    prCache.loading = false;
  }

  async function fetchBranches(cwd: string): Promise<void> {
    if (isFresh(branchCache) || branchCache.loading) return;
    branchCache.loading = true;
    try {
      const result = await pi.exec(
        "git", ["branch", "-a", "--format=%(HEAD)|%(refname:short)"],
        { cwd, timeout: 5_000 },
      );
      if (result.code === 0) {
        const seen = new Set<string>();
        const items: AutocompleteItem[] = [];
        for (const line of result.stdout.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const [head, ref] = trimmed.split("|");
          if (!ref) continue;
          const name = ref.replace(/^origin\//, "");
          if (name === "HEAD" || seen.has(name)) continue;
          seen.add(name);
          items.push({
            value: name,
            label: name,
            description: head === "*" ? "← current" : undefined,
          });
        }
        branchCache.data = items;
        branchCache.timestamp = Date.now();
      }
    } catch {}
    branchCache.loading = false;
  }

  async function fetchTags(cwd: string): Promise<void> {
    if (isFresh(tagCache) || tagCache.loading) return;
    tagCache.loading = true;
    try {
      const result = await pi.exec(
        "git", ["tag", "--sort=-version:refname", "-l"],
        { cwd, timeout: 5_000 },
      );
      if (result.code === 0) {
        tagCache.data = result.stdout
          .split("\n")
          .map((t) => t.trim())
          .filter((t) => t.length > 0)
          .slice(0, 20)
          .map((t) => ({ value: t, label: t, description: "git tag" }));
        tagCache.timestamp = Date.now();
      }
    } catch {}
    tagCache.loading = false;
  }

  // ── Completion definitions ──────────────────────────────────────

  type CompletionFn = (prefix: string) => AutocompleteItem[] | null;

  const completions: Record<string, CompletionFn> = {
    "acpx-prompt": (prefix: string) => {
      const parts = prefix.split(/\s+/);
      const lastPart = parts[parts.length - 1] || "";
      if (parts.length <= 1) return filter(ACPX_AGENTS, lastPart);
      if (lastPart.startsWith("-") || lastPart === "") {
        const usedFlags = new Set(parts.filter((p) => p.startsWith("--")));
        const available = ACPX_FLAGS.filter((f) => !usedFlags.has(f.value));
        return filter(available, lastPart);
      }
      return null;
    },

    "pr-review": (prefix: string) => {
      void fetchOpenPRs(lastCwd);
      return prCache.data ? filter(prCache.data, prefix.replace(/^#/, "")) : null;
    },

    "coderabbit-rate-limit": (prefix: string) => {
      void fetchOpenPRs(lastCwd);
      return prCache.data ? filter(prCache.data, prefix.replace(/^#/, "")) : null;
    },

    "review-local": (prefix: string) => {
      void fetchBranches(lastCwd);
      return branchCache.data ? filter(branchCache.data, prefix) : null;
    },

    "release": (prefix: string) => {
      void fetchTags(lastCwd);
      return tagCache.data ? filter(tagCache.data, prefix) : null;
    },

    "review-handler": (prefix: string) => {
      return filter([
        { value: "--autorabbit", label: "--autorabbit", description: "Auto-trigger CodeRabbit review" },
      ], prefix);
    },

    "dream-auto": (prefix: string) => {
      return filter([
        { value: "on", label: "on", description: "Enable auto-dreaming (every 3h + session end)" },
        { value: "off", label: "off", description: "Disable auto-dreaming" },
      ], prefix);
    },

    "pidash": (prefix: string) => {
      return filter([
        { value: "start", label: "start", description: "Start pidash server" },
        { value: "stop", label: "stop", description: "Stop pidash server" },
        { value: "restart", label: "restart", description: "Restart pidash server" },
        { value: "status", label: "status", description: "Show pidash status" },
      ], prefix);
    },

    "cron": (prefix: string) => {
      const parts = prefix.split(/\s+/);
      const lastPart = parts[parts.length - 1] || "";
      if (parts.length <= 1) {
        return filter([{ value: "add", label: "add", description: "Add a scheduled task" }, { value: "list", label: "list", description: "List scheduled tasks" }, { value: "remove", label: "remove", description: "Remove a scheduled task" }], lastPart);
      }
      if (parts[0] === "add" && parts.length <= 2) {
        return filter([{ value: "every", label: "every", description: "Interval-based (e.g., every 2h)" }, { value: "at", label: "at", description: "Time-based (e.g., at 12:00)" }], lastPart);
      }
      return null;
    },
  };

  // ── Mechanism 1: registerCommand wrapping for extension commands ─

  const originalRegisterCommand = pi.registerCommand.bind(pi);
  pi.registerCommand = (name: string, options: any) => {
    const completionFn = completions[name];
    if (completionFn && !options.getArgumentCompletions) {
      options.getArgumentCompletions = completionFn;
    }
    return originalRegisterCommand(name, options);
  };

  // ── Mechanism 2: autocomplete provider for prompt templates ─────
  //
  // Prompt templates (acpx-prompt, review-local, etc.) are registered by
  // pi itself — not through our registerCommand wrapper. We intercept
  // them in the autocomplete provider, which runs before the built-in.

  // Set of prompt template names that we handle
  const promptTemplateCommands = new Set([
    "acpx-prompt", "pr-review", "coderabbit-rate-limit",
    "review-local", "release", "review-handler", "cron",
  ]);

  pi.on("session_start", (_event, ctx) => {
    lastCwd = ctx.cwd;
    if (!ctx.hasUI) return;

    ctx.ui.addAutocompleteProvider((current: AutocompleteProvider) => ({
      async getSuggestions(
        lines: string[],
        cursorLine: number,
        cursorCol: number,
        options: { signal: AbortSignal; force?: boolean },
      ): Promise<AutocompleteSuggestions | null> {
        const line = lines[cursorLine] ?? "";
        const before = line.slice(0, cursorCol);
        // Match /command <args> — only for our prompt template commands
        const match = before.match(/^\/(\S+)\s+([\s\S]*)$/);
        if (match) {
          const cmdName = match[1];
          const argText = match[2];

          if (promptTemplateCommands.has(cmdName)) {
            const completionFn = completions[cmdName];
            if (completionFn) {
              // Extract the last "word" for prefix matching
              const lastSpaceIdx = argText.lastIndexOf(" ");
              const lastWord = lastSpaceIdx >= 0 ? argText.slice(lastSpaceIdx + 1) : argText;

              const items = completionFn(argText);
              if (items && items.length > 0) {
                return { items, prefix: lastWord };
              }
            }
          }
        }

        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      },

      applyCompletion(
        lines: string[],
        cursorLine: number,
        cursorCol: number,
        item: AutocompleteItem,
        prefix: string,
      ) {
        return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      },

      shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number) {
        // Override: allow Tab completion when cursor is after a command we handle
        const line = lines[cursorLine] ?? "";
        const before = line.slice(0, cursorCol);
        const cmdMatch = before.match(/^\/(\S+)\s/);
        if (cmdMatch && promptTemplateCommands.has(cmdMatch[1])) {
          return true; // Let Tab through so our getSuggestions can handle it
        }
        return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
      },
    }));
  });
}
