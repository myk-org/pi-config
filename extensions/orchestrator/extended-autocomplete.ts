/**
 * Extended autocomplete — argument completions for slash commands.
 *
 * Two mechanisms:
 * 1. getArgumentCompletions on extension commands (dream-auto, pidash, etc.)
 *    — injected via registerCommand wrapping
 * 2. addAutocompleteProvider for prompt templates (external-ai, review-local, etc.)
 *    — stacked provider that intercepts /command <arg> patterns
 *
 * Completions:
 *   /external-ai <Tab>           → ai-cli provider names + --fix, --peer, --cli-flags
 *   /pr-review <Tab>             → open PR numbers
 *   /coderabbit-rate-limit <Tab> → open PR numbers
 *   /review-local <Tab>          → git branch names
 *   /release <Tab>               → recent git tags + --dry-run, --prerelease, --draft, --target <branch>, --tag-match <pattern>
 *   /review-handler <Tab>        → --autorabbit, --autoqodo
 *   /coderabbit-local-review <Tab>                    → --base <branch>, --base-commit <commit>, --type, --config
 *   /dream-auto <Tab>            → on, off
 *   /pidash <Tab>                → start, stop, restart, status
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { fuzzyFilter } from "@earendil-works/pi-tui";

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

const AI_CLI_PROVIDERS: AutocompleteItem[] = [
  "cursor", "claude", "gemini",
].map((a) => ({ value: a, label: a, description: "ai-cli provider" }));

const AI_CLI_FLAGS: AutocompleteItem[] = [
  { value: "--fix", label: "--fix", description: "Agent can modify files" },
  { value: "--peer", label: "--peer", description: "AI-to-AI peer review loop" },
  { value: "--resume", label: "--resume", description: "Continue most recent session" },
  { value: "--session-id ", label: "--session-id", description: "Resume a specific session by ID" },
  { value: "--model ", label: "--model", description: "Set model (e.g., gpt-5.4-high)" },
  { value: "--cli-flags ", label: "--cli-flags", description: "Extra flags passed to AI CLI binary" },
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
  const commitCache = createCache<AutocompleteItem[]>();
  const modelCaches = new Map<string, Cache<AutocompleteItem[]>>();
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

  async function fetchModels(provider: string, cwd: string): Promise<void> {
    let cache = modelCaches.get(provider);
    if (!cache) {
      cache = createCache<AutocompleteItem[]>();
      modelCaches.set(provider, cache);
    }
    if (isFresh(cache) || cache.loading) return;
    cache.loading = true;
    try {
      const result = await pi.exec(
        "myk-pi-tools", ["ai-cli", "models", provider],
        { cwd, timeout: 30_000 },
      );
      if (result.code === 0) {
        const items: AutocompleteItem[] = [];
        try {
          const parsed = JSON.parse(result.stdout);
          if (Array.isArray(parsed)) {
            for (const m of parsed) {
              if (m.id) {
                items.push({
                  value: m.id,
                  label: m.id,
                  description: m.name || m.id,
                });
              }
            }
          }
        } catch {}
        cache.data = items;
        cache.timestamp = Date.now();
      }
    } catch {}
    cache.loading = false;
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

  async function fetchCommits(cwd: string): Promise<void> {
    if (isFresh(commitCache) || commitCache.loading) return;
    commitCache.loading = true;
    try {
      const result = await pi.exec(
        "git", ["log", "-20", "--format=%h|%s"],
        { cwd, timeout: 5_000 },
      );
      if (result.code === 0) {
        commitCache.data = result.stdout
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0)
          .map((l) => {
            const [hash, ...rest] = l.split("|");
            return { value: hash, label: hash, description: rest.join("|") };
          });
        commitCache.timestamp = Date.now();
      }
    } catch {}
    commitCache.loading = false;
  }

  // ── Completion definitions ──────────────────────────────────────

  type CompletionFn = (prefix: string) => AutocompleteItem[] | null;

  const completions: Record<string, CompletionFn> = {
    "external-ai": (prefix: string) => {
      const parts = prefix.split(/\s+/);
      const lastPart = parts[parts.length - 1] || "";
      const prevPart = parts.length >= 2 ? parts[parts.length - 2] : "";

      // After --model: show model completions for the detected provider
      // After --cli-flags or --session-id: free-text, no completions
      if (prevPart === "--cli-flags" || prevPart === "--session-id") return null;

      if (prevPart === "--model") {
        // Find the provider from earlier tokens
        const knownProviders = ["cursor", "claude", "gemini"];
        let provider = "";
        for (const p of parts) {
          const base = p.includes(":") ? p.split(":")[0] : p;
          if (knownProviders.includes(base)) { provider = base; break; }
        }
        if (provider) {
          void fetchModels(provider, lastCwd);
          const cache = modelCaches.get(provider);
          if (cache?.data) {
            return filter(cache.data, lastPart);
          }
        }
        return null;
      }

      // First token: provider or provider:model
      if (parts.length <= 1) {
        // Check if user typed "provider:" — show models for that provider
        const colonIdx = lastPart.indexOf(":");
        if (colonIdx >= 0) {
          const provider = lastPart.substring(0, colonIdx);
          const modelPrefix = lastPart.substring(colonIdx + 1);
          const knownProviders = ["cursor", "claude", "gemini"];
          if (knownProviders.includes(provider)) {
            void fetchModels(provider, lastCwd);
            const cache = modelCaches.get(provider);
            if (cache?.data) {
              const items = cache.data.map((m) => ({
                ...m,
                value: `${provider}:${m.value}`,
              }));
              return filter(items, modelPrefix ? `${provider}:${modelPrefix}` : "");
            }
            return null;
          }
        }
        return filter(AI_CLI_PROVIDERS, lastPart);
      }

      // Subsequent tokens: flags
      if (lastPart.startsWith("-") || lastPart === "") {
        const usedFlags = new Set(parts.filter((p) => p.startsWith("--")));
        const available = AI_CLI_FLAGS.filter((f) => !usedFlags.has(f.value.trim()));
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
      const parts = prefix.split(/\s+/);
      const lastPart = parts[parts.length - 1] || "";
      const prevPart = parts.length >= 2 ? parts[parts.length - 2] : "";

      const RELEASE_FLAGS: AutocompleteItem[] = [
        { value: "--dry-run", label: "--dry-run", description: "Preview without creating" },
        { value: "--prerelease", label: "--prerelease", description: "Create prerelease" },
        { value: "--draft", label: "--draft", description: "Create draft release" },
        { value: "--target ", label: "--target", description: "Target specific branch" },
        { value: "--tag-match ", label: "--tag-match", description: "Filter tags by pattern" },
      ];

      // After --target: show branch completions
      if (prevPart === "--target") {
        void fetchBranches(lastCwd);
        return branchCache.data ? filter(branchCache.data, lastPart) : null;
      }

      // After --tag-match: free-text pattern, no completions
      if (prevPart === "--tag-match") return null;

      // Collect used flags
      const usedFlags = new Set(parts.filter((p) => p.startsWith("--")));

      // Available flags (exclude already used)
      const availableFlags = RELEASE_FLAGS.filter((f) => !usedFlags.has(f.value.trim()));

      // Fetch tags
      void fetchTags(lastCwd);
      const tags = tagCache.data || [];

      // Combine flags and tags
      const combined = [...availableFlags, ...tags];
      return filter(combined, lastPart);
    },

    "coderabbit-local-review": (prefix: string) => {
      const parts = prefix.split(/\s+/);
      const lastPart = parts[parts.length - 1] || "";
      const prevPart = parts.length >= 2 ? parts[parts.length - 2] : "";

      const CR_FLAGS: AutocompleteItem[] = [
        { value: "--autorabbit", label: "--autorabbit", description: "Auto-fix loop until approved" },
        { value: "--base ", label: "--base", description: "Base branch for comparison" },
        { value: "--base-commit ", label: "--base-commit", description: "Base commit for comparison" },
        { value: "--type ", label: "--type", description: "Review type (all/committed/uncommitted)" },
        { value: "--config ", label: "--config", description: "Additional instructions file" },
      ];

      const CR_TYPES: AutocompleteItem[] = [
        { value: "all", label: "all", description: "Review all changes (default)" },
        { value: "committed", label: "committed", description: "Review only committed changes" },
        { value: "uncommitted", label: "uncommitted", description: "Review only uncommitted changes" },
      ];

      // After --base: show branch completions
      if (prevPart === "--base") {
        void fetchBranches(lastCwd);
        return branchCache.data ? filter(branchCache.data, lastPart) : null;
      }

      // After --base-commit: show recent commits
      if (prevPart === "--base-commit") {
        void fetchCommits(lastCwd);
        return commitCache.data ? filter(commitCache.data, lastPart) : null;
      }

      // After --type: show type options
      if (prevPart === "--type") {
        return filter(CR_TYPES, lastPart);
      }

      // After --config: file path, no completions
      if (prevPart === "--config") return null;

      // Show available flags (exclude already used)
      const usedFlags = new Set(parts.filter((p) => p.startsWith("--")));
      const availableFlags = CR_FLAGS.filter((f) => !usedFlags.has(f.value.trim()));
      return filter(availableFlags, lastPart);
    },

    "review-handler": (prefix: string) => {
      return filter([
        { value: "--autorabbit", label: "--autorabbit", description: "Auto-trigger CodeRabbit review" },
        { value: "--autoqodo", label: "--autoqodo", description: "Auto-fix Qodo comments in a loop" },
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

    "pidiff": (prefix: string) => {
      return filter([
        { value: "start", label: "start", description: "Start pidiff server" },
        { value: "stop", label: "stop", description: "Stop pidiff server" },
        { value: "restart", label: "restart", description: "Restart pidiff server" },
        { value: "status", label: "status", description: "Show pidiff status" },
      ], prefix);
    },

    "cron": (prefix: string) => {
      const parts = prefix.split(/\s+/);
      const lastPart = parts[parts.length - 1] || "";
      const sub = parts[0]?.toLowerCase();

      // First level: subcommands
      if (parts.length <= 1 && !(["add", "list", "list-all", "remove", "rm", "delete", "kill"].includes(sub))) {
        return filter([
          { value: "add ", label: "add", description: "Add a scheduled task" },
          { value: "list", label: "list", description: "List scheduled tasks" },
          { value: "list-all", label: "list-all", description: "List crons from all sessions" },
          { value: "remove ", label: "remove", description: "Remove a scheduled task" },
        ], lastPart);
      }
      // After "add"
      if (sub === "add" && parts.length <= 2) {
        return filter([{ value: "every", label: "every", description: "Interval-based (e.g., every 2h)" }, { value: "at", label: "at", description: "Time-based (e.g., at 12:00)" }], lastPart);
      }
      // After "remove" — show task IDs (supports multi-select)
      if (sub === "remove" || sub === "rm" || sub === "delete" || sub === "kill") {
        try {
          const cronFile = require("node:path").join(require("node:os").tmpdir(), `pi-cron-${process.pid}.json`);
          const cronTasks = JSON.parse(require("node:fs").readFileSync(cronFile, "utf-8"));
          if (Array.isArray(cronTasks)) {
            const alreadySelected = new Set(parts.slice(1).filter(p => p !== lastPart));
            return filter(cronTasks.filter((t: any) => !alreadySelected.has(String(t.id))).map((t: any) => ({
              value: String(t.id),
              label: `#${t.id}`,
              description: t.description || t.task || "",
            })), lastPart);
          }
        } catch {}
        return null;
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
    "external-ai", "pr-review", "coderabbit-rate-limit",
    "review-local", "release", "review-handler", "cron", "coderabbit-local-review",
  ]);

  // /external-ai-models-refresh command — clears cache and re-fetches
  pi.registerCommand("external-ai-models-refresh", {
    description: "Refresh AI CLI model cache (cursor, claude, gemini)",
    async handler(_args, ctx) {
      modelCaches.clear();
      ctx.ui.notify("Refreshing AI CLI models...", "info");
      await Promise.allSettled(
        ["cursor", "claude", "gemini"].map((p) => fetchModels(p, ctx.cwd)),
      );
      const counts = ["cursor", "claude", "gemini"]
        .map((p) => `${p}: ${modelCaches.get(p)?.data?.length ?? 0}`)
        .join(", ");
      ctx.ui.notify(`AI CLI models refreshed (${counts})`, "info");
    },
  });

  let modelsPrefetched = false;

  pi.on("session_start", (_event, ctx) => {
    lastCwd = ctx.cwd;

    // Pre-fetch AI CLI models once on first start (not on /new)
    if (!modelsPrefetched) {
      modelsPrefetched = true;
      for (const provider of ["cursor", "claude", "gemini"]) {
        void fetchModels(provider, ctx.cwd);
      }
    }

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
