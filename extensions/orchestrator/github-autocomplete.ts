/**
 * GitHub issue & PR autocomplete — type # to get suggestions from the current repo.
 *
 * Leverages pi 0.69.0's ctx.ui.addAutocompleteProvider() API.
 * Lazy-loads on first # keystroke, caches for 5 minutes, includes both issues and PRs.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  fuzzyFilter,
} from "@mariozechner/pi-tui";

type GitHubItem = {
  number: number;
  title: string;
  state: string;
  kind: "issue" | "pr";
};

const MAX_ITEMS = 100;
const MAX_SUGGESTIONS = 20;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function extractIssueToken(textBeforeCursor: string): string | undefined {
  const match = textBeforeCursor.match(/(?:^|[ \t])#([^\s#]*)$/);
  return match?.[1];
}

function parseGitHubRepo(remoteUrl: string): string | undefined {
  const sshMatch = remoteUrl.match(
    /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/,
  );
  if (sshMatch) return sshMatch[1];

  const httpsMatch = remoteUrl.match(
    /^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/,
  );
  if (httpsMatch) return httpsMatch[1];

  return undefined;
}

function formatItem(item: GitHubItem): AutocompleteItem {
  const tag = item.kind === "pr" ? "pr" : "issue";
  return {
    value: `#${item.number}`,
    label: `#${item.number}`,
    description: `[${tag}] ${item.title}`,
  };
}

function filterItems(
  items: GitHubItem[],
  query: string,
): AutocompleteItem[] {
  if (!query.trim()) {
    return items.slice(0, MAX_SUGGESTIONS).map(formatItem);
  }

  // Numeric prefix match first
  if (/^\d+$/.test(query)) {
    const numericMatches = items
      .filter((item) => String(item.number).startsWith(query))
      .slice(0, MAX_SUGGESTIONS)
      .map(formatItem);
    if (numericMatches.length > 0) return numericMatches;
  }

  // Fuzzy search on number + title
  return fuzzyFilter(
    items,
    query,
    (item) => `${item.number} ${item.title}`,
  )
    .slice(0, MAX_SUGGESTIONS)
    .map(formatItem);
}

function createAutocompleteProvider(
  current: AutocompleteProvider,
  getItems: () => Promise<GitHubItem[] | undefined>,
): AutocompleteProvider {
  return {
    async getSuggestions(
      lines,
      cursorLine,
      cursorCol,
      options,
    ): Promise<AutocompleteSuggestions | null> {
      const currentLine = lines[cursorLine] ?? "";
      const textBeforeCursor = currentLine.slice(0, cursorCol);
      const token = extractIssueToken(textBeforeCursor);

      if (token === undefined) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      const items = await getItems();
      if (options.signal.aborted || !items || items.length === 0) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      const suggestions = filterItems(items, token);
      if (suggestions.length === 0) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      return { items: suggestions, prefix: `#${token}` };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(
        lines,
        cursorLine,
        cursorCol,
        item,
        prefix,
      );
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return (
        current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ??
        true
      );
    },
  };
}

export function registerGithubAutocomplete(pi: ExtensionAPI): void {
  // Skip in subagent children — they have no UI
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    // Resolve GitHub repo from git remote
    const remoteResult = await pi.exec("git", ["remote", "-v"], {
      cwd: ctx.cwd,
      timeout: 5_000,
    });
    if (remoteResult.code !== 0) return; // Not a git repo

    let repo: string | undefined;
    for (const line of remoteResult.stdout.split("\n")) {
      const columns = line.trim().split(/\s+/);
      const remoteUrl = columns[1];
      if (remoteUrl) {
        repo = parseGitHubRepo(remoteUrl);
        if (repo) break;
      }
    }
    if (!repo) return; // Not a GitHub repo

    // Cache state — lazy-loaded on first # keystroke, refreshed after TTL
    let cachedItems: GitHubItem[] | undefined;
    let cacheTimestamp = 0;
    let fetchPromise: Promise<GitHubItem[] | undefined> | undefined;

    async function fetchItems(): Promise<GitHubItem[] | undefined> {
      // Fetch issues and PRs in parallel
      const [issuesResult, prsResult] = await Promise.all([
        pi.exec(
          "gh",
          [
            "issue", "list",
            "--repo", repo!,
            "--state", "open",
            "--limit", String(MAX_ITEMS),
            "--json", "number,title,state",
          ],
          { cwd: ctx.cwd, timeout: 10_000 },
        ),
        pi.exec(
          "gh",
          [
            "pr", "list",
            "--repo", repo!,
            "--state", "open",
            "--limit", String(MAX_ITEMS),
            "--json", "number,title,state",
          ],
          { cwd: ctx.cwd, timeout: 10_000 },
        ),
      ]);

      const items: GitHubItem[] = [];

      if (issuesResult.code === 0) {
        try {
          const issues = JSON.parse(issuesResult.stdout) as Array<{ number: number; title: string; state: string }>;
          for (const issue of issues) {
            items.push({ ...issue, state: issue.state.toLowerCase(), kind: "issue" });
          }
        } catch {}
      }

      if (prsResult.code === 0) {
        try {
          const prs = JSON.parse(prsResult.stdout) as Array<{ number: number; title: string; state: string }>;
          for (const pr of prs) {
            items.push({ ...pr, state: pr.state.toLowerCase(), kind: "pr" });
          }
        } catch {}
      }

      if (items.length === 0) return undefined;

      // Sort by number descending (newest first)
      items.sort((a, b) => b.number - a.number);
      return items;
    }

    const getItems = async (): Promise<GitHubItem[] | undefined> => {
      const now = Date.now();

      // Return cache if fresh
      if (cachedItems && now - cacheTimestamp < CACHE_TTL_MS) {
        return cachedItems;
      }

      // Deduplicate concurrent fetches
      if (!fetchPromise) {
        fetchPromise = fetchItems().then((result) => {
          if (result) {
            cachedItems = result;
            cacheTimestamp = Date.now();
          }
          fetchPromise = undefined;
          return cachedItems;
        }).catch(() => {
          fetchPromise = undefined;
          return cachedItems;
        });
      }

      return fetchPromise;
    };

    // Register autocomplete provider — fetches lazily on first # keystroke
    ctx.ui.addAutocompleteProvider((current) =>
      createAutocompleteProvider(current, getItems),
    );
  });
}
