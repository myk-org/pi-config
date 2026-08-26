/**
 * Parse `git ls-files -oi --directory --exclude-standard` for chokidar skip lists.
 *
 * Only a top-level ignore (no slash) skips that whole directory. Nested ignores
 * like `extensions/pidiff/pidiff-ui/node_modules/` must not skip `extensions/`.
 */

export interface GitIgnoredWatchFilter {
  topLevel: Set<string>;
  /** POSIX relative prefixes (no trailing slash). */
  nested: string[];
}

export function parseGitIgnoredWatchFilter(raw: string): GitIgnoredWatchFilter {
  const topLevel = new Set<string>();
  const nested = new Set<string>();
  if (!raw.trim()) return { topLevel, nested: [] };
  for (const line of raw.split("\n")) {
    const trimmed = line.replace(/\/$/, "").trim();
    if (!trimmed) continue;
    if (!trimmed.includes("/")) topLevel.add(trimmed);
    else nested.add(trimmed);
  }
  return { topLevel, nested: [...nested].sort() };
}

const ALWAYS_IGNORED = new Set([".git", "node_modules"]);

export function isGitIgnoredRelPath(relPosix: string, filter: GitIgnoredWatchFilter): boolean {
  if (relPosix === "" || relPosix === ".") return false;
  const first = relPosix.split("/")[0];
  if (ALWAYS_IGNORED.has(first) || filter.topLevel.has(first)) return true;
  for (const prefix of filter.nested) {
    if (relPosix === prefix || relPosix.startsWith(`${prefix}/`)) return true;
  }
  return false;
}
