/**
 * Parse `git ls-files -oi --directory --exclude-standard` for chokidar skip lists.
 *
 * Only a top-level ignore (no slash) skips that whole directory. Nested ignores
 * like `extensions/pidiff/pidiff-ui/node_modules/` must not skip `extensions/`.
 */

import { createLogger } from "../extensions/shared/logger.ts";

const log = createLogger("pidiff");

export interface GitIgnoredWatchFilter {
  topLevel: Set<string>;
  /** POSIX relative prefixes (no trailing slash). */
  nested: string[];
}

export function parseGitIgnoredWatchFilter(raw: string): GitIgnoredWatchFilter {
  const topLevel = new Set<string>();
  const nested = new Set<string>();
  if (!raw.trim()) {
    log.debug("parseGitIgnoredWatchFilter empty input");
    return { topLevel, nested: [] };
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.replace(/\/$/, "").trim();
    if (!trimmed) continue;
    if (!trimmed.includes("/")) topLevel.add(trimmed);
    else nested.add(trimmed);
  }
  const filter = { topLevel, nested: [...nested].sort() };
  log.debug("parseGitIgnoredWatchFilter", { topLevel: topLevel.size, nested: filter.nested.length });
  return filter;
}

const ALWAYS_IGNORED = new Set([".git", "node_modules"]);

export function isGitIgnoredRelPath(relPosix: string, filter: GitIgnoredWatchFilter): boolean {
  if (relPosix === "" || relPosix === ".") {
    log.debug("isGitIgnoredRelPath skip-root", relPosix);
    return false;
  }
  const first = relPosix.split("/")[0];
  if (ALWAYS_IGNORED.has(first) || filter.topLevel.has(first)) {
    if (log.isDebugEnabled()) log.debug("isGitIgnoredRelPath topLevel", relPosix);
    return true;
  }
  for (const prefix of filter.nested) {
    if (relPosix === prefix || relPosix.startsWith(`${prefix}/`)) {
      if (log.isDebugEnabled()) log.debug("isGitIgnoredRelPath nested", prefix);
      return true;
    }
  }
  return false;
}
