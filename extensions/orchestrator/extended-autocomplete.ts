/**
 * Extended autocomplete — argument completions for slash commands.
 *
 * Two mechanisms:
 * 1. getArgumentCompletions on extension commands (review-status, etc.)
 *    — injected via registerCommand wrapping
 * 2. addAutocompleteProvider for prompt templates (pr-review, review-local, etc.)
 *    — stacked provider that intercepts /command <arg> patterns
 *
 * Completions:
 *   /pr-review <Tab>             → open PR numbers
 *   /retro <Tab>                 → recently merged PR numbers
 *   /coderabbit-rate-limit <Tab> → open PR numbers
 *   /review-local <Tab>          → git branch names
 *   /release <Tab>               → recent git tags + --dry-run, --prerelease, --draft, --target <branch>, --tag-match <pattern>
 *   /review-handler <Tab>        → --autorabbit, --autoqodo
 *   /qodo-review <Tab>           → --autofix, --fast, --deep, --ticket
 *   /review-status <Tab>         → active worktree paths
 *   /create-skill <Tab>          → (free-text name)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import * as path from "node:path";
import { createLogger } from "../shared/logger.js";
import { listWorktreesAsync, type GitAsyncRunner } from "./git-helpers.js";

const log = createLogger("autocomplete");

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

export function qodoReviewArgumentCompletions(prefix: string): AutocompleteItem[] | null {
  const tokens = prefix.trim().split(/\s+/).filter(Boolean);
  log.debug("Completing qodo-review arguments", { tokenCount: tokens.length });
  const selected = new Set(tokens);
  const lastPart = /\s$/.test(prefix) ? "" : (tokens[tokens.length - 1] || "");
  if ((lastPart && tokens.at(-2) === "--ticket") || (!lastPart && tokens.at(-1) === "--ticket")) return null;

  const flags = [
    { value: "--autofix", label: "--autofix", description: "Fix findings in up to 3 cycles" },
    { value: "--fast", label: "--fast", description: "Run a quick review" },
    { value: "--deep", label: "--deep", description: "Run a thorough review" },
    { value: "--ticket ", label: "--ticket", description: "Attach a ticket URL" },
  ];
  const available = flags.filter(({ value }) => {
    const flag = value.trim();
    if (flag !== "--ticket" && selected.has(flag)) return false;
    return !((flag === "--fast" && selected.has("--deep")) || (flag === "--deep" && selected.has("--fast")));
  });
  return filter(available, lastPart);
}

// ── Shared types ────────────────────────────────────────────────────

type CompletionFn = (prefix: string) => AutocompleteItem[] | null;

interface AutocompleteContext {
  prCache: Cache<AutocompleteItem[]>;
  prUrlMap: Map<string, string>;
  mergedPrCache: Cache<AutocompleteItem[]>;
  issueCache: Cache<AutocompleteItem[]>;
  branchCache: Cache<AutocompleteItem[]>;
  tagCache: Cache<AutocompleteItem[]>;
  worktreeCaches: Map<string, Cache<AutocompleteItem[]>>;
  lastCwd: string;
  fetchOpenPRs(cwd: string): Promise<void>;
  fetchMergedPRs(cwd: string): Promise<void>;
  fetchOpenIssues(cwd: string): Promise<void>;
  fetchBranches(cwd: string): Promise<void>;
  fetchTags(cwd: string): Promise<void>;
  fetchWorktrees(cwd: string): Promise<void>;
}

// ── Completions registration ────────────────────────────────────────

function registerCompletions(
  pi: ExtensionAPI,
  ctx: AutocompleteContext,
): Record<string, CompletionFn> {
  log.debug("Registering extended autocomplete completions");

  // ── Completion definitions ──────────────────────────────────────

  const completions: Record<string, CompletionFn> = {
    "pr-review": (prefix: string) => {
      void ctx.fetchOpenPRs(ctx.lastCwd);
      if (!ctx.prCache.data) return null;
      const filtered = filter(ctx.prCache.data, prefix.replace(/^#/, ""));
      return filtered ? filtered.map((item) => ({ ...item, value: ctx.prUrlMap.get(item.value) || item.value })) : null;
    },

    "issue-review": (prefix: string) => {
      void ctx.fetchOpenIssues(ctx.lastCwd);
      return ctx.issueCache.data ? filter(ctx.issueCache.data, prefix.replace(/^#/, "")) : null;
    },

    "coderabbit-rate-limit": (prefix: string) => {
      void ctx.fetchOpenPRs(ctx.lastCwd);
      return ctx.prCache.data ? filter(ctx.prCache.data, prefix.replace(/^#/, "")) : null;
    },

    "retro": (prefix: string) => {
      void ctx.fetchMergedPRs(ctx.lastCwd);
      return ctx.mergedPrCache.data ? filter(ctx.mergedPrCache.data, prefix.replace(/^#/, "")) : null;
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

    "qodo-review": qodoReviewArgumentCompletions,

    "review-status": (prefix: string) => {
      void ctx.fetchWorktrees(ctx.lastCwd);
      const cache = ctx.worktreeCaches.get(ctx.lastCwd);
      if (!cache?.data) return null;
      return filter(cache.data, prefix);
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
  log.debug("Setting up prompt template autocomplete interceptor");
  // Prompt templates (pr-review, review-local, etc.) are registered by
  // pi itself — not through our registerCommand wrapper. We intercept
  // them in the autocomplete provider, which runs before the built-in.

  // Set of prompt template names that we handle
  const promptTemplateCommands = new Set([
    "pr-review", "retro", "issue-review", "coderabbit-rate-limit",
    "review-local", "release", "review-handler", "qodo-review", "create-skill", "create-coms-feature-manager",
  ]);

  pi.on("session_start", (_event, sessionCtx) => {
    ctx.lastCwd = sessionCtx.cwd;

    if (sessionCtx.mode !== "tui") return;

    // Warm the worktree cache in interactive TUI sessions so the first /review-status Tab has suggestions ready.
    void ctx.fetchWorktrees(sessionCtx.cwd);

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
        const line = lines[cursorLine] ?? "";
        // We own only argument suggestions. Delegate slash-command completion
        // unchanged, otherwise selecting `/pi-config-settings` drops its slash.
        if (!/^\/\S+\s/.test(line.slice(0, cursorCol))) {
          const result = current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
          // Some wrapped providers return a bare command value. Keep the slash
          // that put the editor into command mode so Enter dispatches it.
          const completed = result.lines[result.cursorLine] ?? "";
          if (line.startsWith("/") && !completed.startsWith("/")) {
            const nextLines = [...result.lines];
            nextLines[result.cursorLine] = `/${completed}`;
            return { ...result, lines: nextLines, cursorCol: result.cursorCol + 1 };
          }
          return result;
        }
        // Pi passes the wrapped provider's prefix here, which can be broader
        // than our argument token. Replace only the current argument token.
        const start = line.lastIndexOf(" ", Math.max(0, cursorCol - 1)) + 1;
        const nextLines = [...lines];
        nextLines[cursorLine] = `${line.slice(0, start)}${item.value}${line.slice(cursorCol)}`;
        return { lines: nextLines, cursorLine, cursorCol: start + item.value.length };
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
  ctx.mergedPrCache = createCache<AutocompleteItem[]>();
  ctx.issueCache = createCache<AutocompleteItem[]>();
  ctx.branchCache = createCache<AutocompleteItem[]>();
  ctx.tagCache = createCache<AutocompleteItem[]>();
  ctx.worktreeCaches = new Map<string, Cache<AutocompleteItem[]>>();
  ctx.lastCwd = "";

  const piGitRunner: GitAsyncRunner = async (args, dir) => {
    const r = await pi.exec("git", args, { cwd: dir, timeout: 3_000 });
    return { stdout: r.stdout, code: r.code };
  };

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

  ctx.fetchMergedPRs = async (cwd: string) => {
    if (isFresh(ctx.mergedPrCache) || ctx.mergedPrCache.loading) return;
    ctx.mergedPrCache.loading = true;
    try {
      const result = await pi.exec(
        "gh", ["pr", "list", "--state", "merged", "--limit", "50", "--json", "number,title,url"],
        { cwd, timeout: 10_000 },
      );
      if (result.code === 0) {
        const prs = JSON.parse(result.stdout) as Array<{ number: number; title: string; url: string }>;
        ctx.mergedPrCache.data = prs.map((pr) => ({
          value: String(pr.number),
          label: `#${pr.number}`,
          description: pr.title,
        }));
        ctx.mergedPrCache.timestamp = Date.now();
      }
    } catch (e: any) { log.debug("merged PR fetch failed", { error: e?.message || String(e) }); }
    ctx.mergedPrCache.loading = false;
  };

  ctx.fetchOpenIssues = async (cwd: string) => {
    if (isFresh(ctx.issueCache) || ctx.issueCache.loading) return;
    ctx.issueCache.loading = true;
    try {
      const result = await pi.exec(
        "gh", ["issue", "list", "--state", "open", "--limit", "50", "--json", "number,title"],
        { cwd, timeout: 10_000 },
      );
      if (result.code === 0) {
        const issues = JSON.parse(result.stdout) as Array<{ number: number; title: string }>;
        ctx.issueCache.data = issues.map((issue) => ({
          value: String(issue.number),
          label: `#${issue.number}`,
          description: issue.title,
        }));
        ctx.issueCache.timestamp = Date.now();
      }
    } catch (e: any) { console.debug("[autocomplete] issue fetch failed:", e?.message || e); }
    ctx.issueCache.loading = false;
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

  ctx.fetchWorktrees = async (cwd: string) => {
    if (!cwd) return;
    let cache = ctx.worktreeCaches.get(cwd);
    if (!cache) {
      cache = createCache<AutocompleteItem[]>();
      ctx.worktreeCaches.set(cwd, cache);
    }
    if (isFresh(cache) || cache.loading) return;
    cache.loading = true;
    try {
      const entries = await listWorktreesAsync(cwd, { runGitAsync: piGitRunner });
      const worktrees: AutocompleteItem[] = entries
        .filter((wt) => !wt.isMain)
        .map((wt) => {
          const relative = path.relative(cwd, wt.path) || ".";
          return { value: relative, label: relative, description: `Worktree: ${wt.path}` };
        });
      cache.data = worktrees;
      cache.timestamp = Date.now();
    } catch (e: any) {
      log.debug("worktree fetch failed", { error: e?.message || String(e) });
    }
    cache.loading = false;
  };

  const completions = registerCompletions(pi, ctx);
  // Completions live with the command that owns them: `/coms kill|tell` (and their `--project`)
  // are completed from `extensions/coms/coms-wrapper.ts`, where the live registry rows are, so a
  // gone peer never completes. A pointer, not a second enumeration — one source, next to the handler.
  setupPromptTemplateInterceptor(pi, ctx, completions);
}
