/**
 * Extended autocomplete — argument completions for slash commands.
 *
 * Two mechanisms:
 * 1. getArgumentCompletions on extension commands (dream-auto, etc.)
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
 *   /review-status <Tab>         → active worktree paths
 *   /create-skill <Tab>          → (free-text name)
 *   /cron <Tab>                  → add, list, list-all, remove
 *   /dream-auto <Tab>            → on, off
 *   /async-kill <Tab>            → all (or type name / id prefix)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { getCronFilePath } from "./cron.js";

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

// ── Shared types ────────────────────────────────────────────────────

type CompletionFn = (prefix: string) => AutocompleteItem[] | null;

interface AutocompleteContext {
  prCache: Cache<AutocompleteItem[]>;
  prUrlMap: Map<string, string>;
  branchCache: Cache<AutocompleteItem[]>;
  tagCache: Cache<AutocompleteItem[]>;
  modelCaches: Map<string, Cache<AutocompleteItem[]>>;
  lastCwd: string;
  fetchOpenPRs(cwd: string): Promise<void>;
  fetchBranches(cwd: string): Promise<void>;
  fetchModels(provider: string, cwd: string): Promise<void>;
  fetchTags(cwd: string): Promise<void>;
}

// ── Completions registration ────────────────────────────────────────

function registerCompletions(
  pi: ExtensionAPI,
  ctx: AutocompleteContext,
): Record<string, CompletionFn> {

  // ── Completion definitions ──────────────────────────────────────

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
          void ctx.fetchModels(provider, ctx.lastCwd);
          const cache = ctx.modelCaches.get(provider);
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
            void ctx.fetchModels(provider, ctx.lastCwd);
            const cache = ctx.modelCaches.get(provider);
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
      void ctx.fetchOpenPRs(ctx.lastCwd);
      if (!ctx.prCache.data) return null;
      const filtered = filter(ctx.prCache.data, prefix.replace(/^#/, ""));
      return filtered ? filtered.map((item) => ({ ...item, value: ctx.prUrlMap.get(item.value) || item.value })) : null;
    },

    "coderabbit-rate-limit": (prefix: string) => {
      void ctx.fetchOpenPRs(ctx.lastCwd);
      return ctx.prCache.data ? filter(ctx.prCache.data, prefix.replace(/^#/, "")) : null;
    },

    "review-local": (prefix: string) => {
      void ctx.fetchBranches(ctx.lastCwd);
      return ctx.branchCache.data ? filter(ctx.branchCache.data, prefix) : null;
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
        void ctx.fetchBranches(ctx.lastCwd);
        return ctx.branchCache.data ? filter(ctx.branchCache.data, lastPart) : null;
      }

      // After --tag-match: free-text pattern, no completions
      if (prevPart === "--tag-match") return null;

      // Collect used flags
      const usedFlags = new Set(parts.filter((p) => p.startsWith("--")));

      // Available flags (exclude already used)
      const availableFlags = RELEASE_FLAGS.filter((f) => !usedFlags.has(f.value.trim()));

      // Fetch tags
      void ctx.fetchTags(ctx.lastCwd);
      const tags = ctx.tagCache.data || [];

      // Combine flags and tags
      const combined = [...availableFlags, ...tags];
      return filter(combined, lastPart);
    },


    "review-handler": (prefix: string) => {
      const tokens = prefix.trim().split(/\s+/).filter(Boolean);
      const selected = new Set(tokens);
      const lastPart = prefix.endsWith(" ") ? "" : (tokens[tokens.length - 1] || "");
      const all = [
        { value: "--autorabbit", label: "--autorabbit", description: "Auto-fix CodeRabbit comments in a loop" },
        { value: "--autoqodo", label: "--autoqodo", description: "Auto-fix Qodo comments in a loop" },
      ];
      const available = all.filter(item => !selected.has(item.value));
      return filter(available, lastPart);
    },

    "review-status": (prefix: string) => {
      // List active worktrees (excluding main repo) as completion options
      try {
        // Use --git-common-dir to find the shared repo root (not worktree root).
        // This ensures we correctly identify the main repo even if ctx.lastCwd
        // happens to be inside a worktree.
        const gitCommonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
          cwd: ctx.lastCwd, encoding: "utf-8", timeout: 3000,
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        const mainRoot = path.dirname(path.resolve(ctx.lastCwd, gitCommonDir));
        const porcelain = execFileSync("git", ["worktree", "list", "--porcelain"], {
          cwd: ctx.lastCwd, encoding: "utf-8", timeout: 3000,
          stdio: ["ignore", "pipe", "ignore"],
        });
        const worktrees: AutocompleteItem[] = [];
        for (const line of porcelain.split("\n")) {
          if (!line.startsWith("worktree ")) continue;
          const wtPath = line.slice("worktree ".length).trim();
          if (wtPath === mainRoot) continue; // skip main repo
          const relative = path.relative(ctx.lastCwd, wtPath);
          worktrees.push({ value: relative, label: relative, description: `Worktree: ${wtPath}` });
        }
        return filter(worktrees, prefix);
      } catch {
        return null;
      }
    },

    "dream-auto": (prefix: string) => {
      return filter([
        { value: "on", label: "on", description: "Enable auto-dreaming (every 3h + session end)" },
        { value: "off", label: "off", description: "Disable auto-dreaming" },
      ], prefix);
    },

    "async-kill": (prefix: string) => {
      return filter([
        { value: "all", label: "all", description: "Kill all running/queued async agents" },
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
          const cronFile = getCronFilePath();
          if (!cronFile) return null;
          const cronTasks = JSON.parse(fs.readFileSync(cronFile, "utf-8"));
          if (Array.isArray(cronTasks)) {
            const alreadySelected = new Set(parts.slice(1).filter(p => p !== lastPart));
            return filter(cronTasks.filter((t: any) => !alreadySelected.has(String(t.id))).map((t: any) => ({
              value: String(t.id),
              label: `#${t.id}`,
              description: t.description || t.task || "",
            })), lastPart);
          }
        } catch (e: any) { console.debug("[autocomplete] cron task fetch failed:", e?.message || e); }
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

  return completions;
}

// ── Prompt template interceptor ─────────────────────────────────────

function setupPromptTemplateInterceptor(
  pi: ExtensionAPI,
  ctx: AutocompleteContext,
  completions: Record<string, CompletionFn>,
): void {
  // Prompt templates (acpx-prompt, review-local, etc.) are registered by
  // pi itself — not through our registerCommand wrapper. We intercept
  // them in the autocomplete provider, which runs before the built-in.

  // Set of prompt template names that we handle
  const promptTemplateCommands = new Set([
    "external-ai", "pr-review", "coderabbit-rate-limit",
    "review-local", "release", "review-handler", "cron", "create-skill", "create-coms-feature-manager",
  ]);

  // /external-ai-models-refresh command — clears cache and re-fetches
  pi.registerCommand("external-ai-models-refresh", {
    description: "Refresh AI CLI model cache (cursor, claude, gemini)",
    async handler(_args, handlerCtx) {
      ctx.modelCaches.clear();
      handlerCtx.ui.notify("Refreshing AI CLI models...", "info");
      await Promise.allSettled(
        ["cursor", "claude", "gemini"].map((p) => ctx.fetchModels(p, handlerCtx.cwd)),
      );
      const counts = ["cursor", "claude", "gemini"]
        .map((p) => `${p}: ${ctx.modelCaches.get(p)?.data?.length ?? 0}`)
        .join(", ");
      handlerCtx.ui.notify(`AI CLI models refreshed (${counts})`, "info");
    },
  });

  let modelsPrefetched = false;

  pi.on("session_start", (_event, sessionCtx) => {
    ctx.lastCwd = sessionCtx.cwd;

    // Pre-fetch AI CLI models once on first start (not on /new)
    if (!modelsPrefetched) {
      modelsPrefetched = true;
      for (const provider of ["cursor", "claude", "gemini"]) {
        void ctx.fetchModels(provider, sessionCtx.cwd);
      }
    }

    if (sessionCtx.mode !== "tui") return;

    sessionCtx.ui.addAutocompleteProvider((current: AutocompleteProvider) => ({
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

// ── Registration ────────────────────────────────────────────────────

export function registerExtendedAutocomplete(pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

  // Shared mutable context — caches, fetchers, and state passed to extracted functions
  const ctx = {} as AutocompleteContext;
  ctx.prCache = createCache<AutocompleteItem[]>();
  ctx.prUrlMap = new Map<string, string>();
  ctx.branchCache = createCache<AutocompleteItem[]>();
  ctx.tagCache = createCache<AutocompleteItem[]>();
  ctx.modelCaches = new Map<string, Cache<AutocompleteItem[]>>();
  ctx.lastCwd = "";

  // ── Fetchers (close over pi and ctx) ────────────────────────────

  ctx.fetchOpenPRs = async (cwd: string) => {
    if (isFresh(ctx.prCache) || ctx.prCache.loading) return;
    ctx.prCache.loading = true;
    try {
      const result = await pi.exec(
        "gh", ["pr", "list", "--state", "open", "--limit", "50", "--json", "number,title,url"],
        { cwd, timeout: 10_000 },
      );
      if (result.code === 0) {
        const prs = JSON.parse(result.stdout) as Array<{ number: number; title: string; url: string }>;
        ctx.prCache.data = prs.map((pr) => ({
          value: String(pr.number),
          label: `#${pr.number}`,
          description: pr.title,
        }));
        ctx.prCache.timestamp = Date.now();
        // URL-keyed version for pr-review (uses URL as completion value)
        ctx.prUrlMap = new Map(prs.map((pr) => [String(pr.number), pr.url || String(pr.number)]));
      }
    } catch (e: any) { console.debug("[autocomplete] PR fetch failed:", e?.message || e); }
    ctx.prCache.loading = false;
  };

  ctx.fetchBranches = async (cwd: string) => {
    if (isFresh(ctx.branchCache) || ctx.branchCache.loading) return;
    ctx.branchCache.loading = true;
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
        ctx.branchCache.data = items;
        ctx.branchCache.timestamp = Date.now();
      }
    } catch (e: any) { console.debug("[autocomplete] branch fetch failed:", e?.message || e); }
    ctx.branchCache.loading = false;
  };

  ctx.fetchModels = async (provider: string, cwd: string) => {
    let cache = ctx.modelCaches.get(provider);
    if (!cache) {
      cache = createCache<AutocompleteItem[]>();
      ctx.modelCaches.set(provider, cache);
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
        } catch (e: any) { console.debug("[autocomplete] model JSON parse failed:", e?.message || e); }
        cache.data = items;
        cache.timestamp = Date.now();
      }
    } catch (e: any) { console.debug("[autocomplete] model fetch failed:", e?.message || e); }
    cache.loading = false;
  };

  ctx.fetchTags = async (cwd: string) => {
    if (isFresh(ctx.tagCache) || ctx.tagCache.loading) return;
    ctx.tagCache.loading = true;
    try {
      const result = await pi.exec(
        "git", ["tag", "--sort=-version:refname", "-l"],
        { cwd, timeout: 5_000 },
      );
      if (result.code === 0) {
        ctx.tagCache.data = result.stdout
          .split("\n")
          .map((t) => t.trim())
          .filter((t) => t.length > 0)
          .slice(0, 20)
          .map((t) => ({ value: t, label: t, description: "git tag" }));
        ctx.tagCache.timestamp = Date.now();
      }
    } catch (e: any) { console.debug("[autocomplete] tag fetch failed:", e?.message || e); }
    ctx.tagCache.loading = false;
  };

  const completions = registerCompletions(pi, ctx);
  setupPromptTemplateInterceptor(pi, ctx, completions);
}
