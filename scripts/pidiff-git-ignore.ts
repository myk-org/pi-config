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
  /** O(1) lookup index for nested prefixes (populated by parseGitIgnoredWatchFilter). */
  nestedSet?: ReadonlySet<string>;
}

const nestedSetCache = new WeakMap<readonly string[], ReadonlySet<string>>();

function getNestedSet(nested: readonly string[]): ReadonlySet<string> {
  let set = nestedSetCache.get(nested);
  if (!set) {
    set = new Set(nested);
    nestedSetCache.set(nested, set);
  }
  return set;
}

export function parseGitIgnoredWatchFilter(raw: string): GitIgnoredWatchFilter {
  const topLevel = new Set<string>();
  const nestedSet = new Set<string>();
  if (!raw.trim()) {
    log.debug("parseGitIgnoredWatchFilter empty input");
    return { topLevel, nested: [], nestedSet };
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.replace(/\/$/, "").trim();
    if (!trimmed) continue;
    if (!trimmed.includes("/")) topLevel.add(trimmed);
    else nestedSet.add(trimmed);
  }
  const nested = [...nestedSet].sort();
  nestedSetCache.set(nested, nestedSet);
  const filter: GitIgnoredWatchFilter = { topLevel, nested, nestedSet };
  log.debug("parseGitIgnoredWatchFilter", { topLevel: topLevel.size, nested: filter.nested.length });
  return filter;
}

const ALWAYS_IGNORED = new Set([".git", "node_modules"]);

export function isGitIgnoredRelPath(relPosix: string, filter: GitIgnoredWatchFilter): boolean {
  if (relPosix === "" || relPosix === ".") {
    if (log.isDebugEnabled()) log.debug("isGitIgnoredRelPath skip-root", relPosix);
    return false;
  }
  const slashIdx = relPosix.indexOf("/");
  const first = slashIdx === -1 ? relPosix : relPosix.slice(0, slashIdx);
  if (ALWAYS_IGNORED.has(first) || filter.topLevel.has(first)) {
    if (log.isDebugEnabled()) log.debug("isGitIgnoredRelPath topLevel", relPosix);
    return true;
  }
  if (filter.nested.length === 0) return false;
  const nestedSet = filter.nestedSet ?? getNestedSet(filter.nested);
  if (nestedSet.has(relPosix)) {
    if (log.isDebugEnabled()) log.debug("isGitIgnoredRelPath nested", relPosix);
    return true;
  }
  let idx = slashIdx;
  while (idx !== -1) {
    const prefix = relPosix.slice(0, idx);
    if (nestedSet.has(prefix)) {
      if (log.isDebugEnabled()) log.debug("isGitIgnoredRelPath nested", prefix);
      return true;
    }
    idx = relPosix.indexOf("/", idx + 1);
  }
  return false;
}
