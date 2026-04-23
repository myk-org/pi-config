/**
 * GitHub issue autocomplete — type # to get issue suggestions from the current repo.
 *
 * Leverages pi 0.69.0's ctx.ui.addAutocompleteProvider() API.
 * Based on pi's github-issue-autocomplete.ts example extension.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  fuzzyFilter,
} from "@mariozechner/pi-tui";

type GitHubIssue = {
  number: number;
  title: string;
  state: string;
};

const MAX_ISSUES = 100;
const MAX_SUGGESTIONS = 20;

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

function formatIssueItem(issue: GitHubIssue): AutocompleteItem {
  return {
    value: `#${issue.number}`,
    label: `#${issue.number}`,
    description: `[${issue.state.toLowerCase()}] ${issue.title}`,
  };
}

function filterIssues(
  issues: GitHubIssue[],
  query: string,
): AutocompleteItem[] {
  if (!query.trim()) {
    return issues.slice(0, MAX_SUGGESTIONS).map(formatIssueItem);
  }

  // Numeric prefix match first
  if (/^\d+$/.test(query)) {
    const numericMatches = issues
      .filter((issue) => String(issue.number).startsWith(query))
      .slice(0, MAX_SUGGESTIONS)
      .map(formatIssueItem);
    if (numericMatches.length > 0) return numericMatches;
  }

  // Fuzzy search on number + title
  return fuzzyFilter(
    issues,
    query,
    (issue) => `${issue.number} ${issue.title}`,
  )
    .slice(0, MAX_SUGGESTIONS)
    .map(formatIssueItem);
}

function createIssueAutocompleteProvider(
  current: AutocompleteProvider,
  getIssues: () => Promise<GitHubIssue[] | undefined>,
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

      const issues = await getIssues();
      if (options.signal.aborted || !issues || issues.length === 0) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      const suggestions = filterIssues(issues, token);
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

    // Lazy-load issues (first autocomplete trigger fetches them)
    let issuesPromise: Promise<GitHubIssue[] | undefined> | undefined;

    const getIssues = async (): Promise<GitHubIssue[] | undefined> => {
      issuesPromise ||= (async () => {
        const result = await pi.exec(
          "gh",
          [
            "issue",
            "list",
            "--repo",
            repo!,
            "--state",
            "open",
            "--limit",
            String(MAX_ISSUES),
            "--json",
            "number,title,state",
          ],
          { cwd: ctx.cwd, timeout: 10_000 },
        );
        if (result.code !== 0) return undefined;

        try {
          return JSON.parse(result.stdout) as GitHubIssue[];
        } catch {
          return undefined;
        }
      })();
      return issuesPromise;
    };

    // Pre-fetch issues in background
    void getIssues();

    // Register autocomplete provider
    ctx.ui.addAutocompleteProvider((current) =>
      createIssueAutocompleteProvider(current, getIssues),
    );
  });
}
