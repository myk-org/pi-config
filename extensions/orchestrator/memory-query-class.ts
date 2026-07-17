/**
 * Query-class classifier for memory injection routing.
 * Cheap heuristics only — no LLM call.
 */

export type QueryClass = "pr_review" | "git_release" | "debug" | "general";

export interface QueryClassBias {
  /** Categories to boost (higher section budget / earlier priority) */
  boostCategories: string[];
  /** Vector topK override */
  vectorTopK: number;
  /** Extra note injected into situation report when relevant */
  hint?: string;
}

const CLASS_BIAS: Record<QueryClass, QueryClassBias> = {
  pr_review: {
    boostCategories: ["mistake", "pattern", "lesson"],
    vectorTopK: 7,
    hint: "PR review context — prefer mistakes/patterns; check `.pi/data/review-guidelines.md` when reviewing.",
  },
  git_release: {
    boostCategories: ["lesson", "decision", "preference"],
    vectorTopK: 6,
    hint: "Git/release context — prefer enforced lessons and decisions.",
  },
  debug: {
    boostCategories: ["mistake", "lesson"],
    vectorTopK: 7,
    hint: "Debug context — prefer mistakes and lessons.",
  },
  general: {
    boostCategories: [],
    vectorTopK: 5,
  },
};

const PR_REVIEW_RE =
  /\b(pr review|code review|review (this |the )?(pr|pull request)|gh pr\b|pull request)\b/i;
const GIT_RELEASE_RE =
  /\b(git (commit|push|tag|rebase|merge)|release|changelog|semver|deploy(ment)?)\b/i;
const DEBUG_RE =
  /\b(error|stack( ?trace)?|traceback|fail(ed|ing|ure)?|exception|bug|debug|segfault|panic)\b/i;

/**
 * Classify the user prompt into a query class for injection bias.
 */
export function classifyQueryClass(prompt: string): QueryClass {
  const text = (prompt || "").trim();
  if (!text) return "general";

  if (PR_REVIEW_RE.test(text)) return "pr_review";
  if (GIT_RELEASE_RE.test(text)) return "git_release";
  if (DEBUG_RE.test(text)) return "debug";
  return "general";
}

export function getQueryClassBias(queryClass: QueryClass): QueryClassBias {
  return CLASS_BIAS[queryClass];
}

/**
 * Reorder section priority: boosted categories get a modest priority lift
 * (lower number = earlier). Non-boosted keep base order.
 */
export function sectionPriorityBoost(
  sectionName: string,
  basePriority: number,
  queryClass: QueryClass,
): number {
  const bias = getQueryClassBias(queryClass);
  if (bias.boostCategories.length === 0) return basePriority;

  const topicMap: Record<string, string> = {
    "Active Preferences": "preference",
    "Active Lessons": "lesson",
    "Vetoes & Mistakes": "mistake",
    Patterns: "pattern",
    "Recent Decisions": "decision",
    "Recent Completions": "done",
  };
  const cat = topicMap[sectionName];
  if (cat && bias.boostCategories.includes(cat)) {
    // Lower number sorts earlier; allow 0/negative so boosted sections
    // beat unboosted priority-1 sections (e.g. preferences).
    return basePriority - 3;
  }
  return basePriority;
}
