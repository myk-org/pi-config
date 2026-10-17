/**
 * memory-write.ts — unified memory write path (issue #915).
 *
 * Single entry point for adding memory entries from every producer
 * (memory_add tool, preference extractor). Enforces, in order:
 *
 *   1. category / trigger / action / scope validation
 *   2. grant-phrase guardrail — one-off permissions are session
 *      instructions, not memories
 *   3. contradiction gate — refuses adds that contradict existing
 *      entries (always refuses contradictions of pinned entries).
 *      Clause-scoped + quote-stripped (#936): polarity markers govern
 *      only their own clause, so complementary rules (procedure vs
 *      scheduling constraint, conditional vs unconditional) both store;
 *      quoted payloads are never polarity markers
 *   4. near-duplicate / exact dedup — reinforces instead of adding
 *   5. topic size cap, score entry, embedding upkeep
 *
 * Having one write path means every producer gets the same safeguards;
 * previously preference-extractor bypassed cap, dedup, and conflict checks.
 */

import { createLogger } from "../shared/logger.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getProjectMemoryDir } from "./utils.js";
import {
  type MemoryCategory,
  type MemoryScope,
  type ScoredEntry,
  VALID_CATEGORIES,
  PINNED_SCORE,
  entryHash,
  loadScores,
  mutateScores,
  newEntryId,
  reinforce,
  isGrantText,
} from "./memory-scoring.js";
import { CATEGORY_TO_TOPIC, MAX_TOPIC_CHARS, readAllTopicEntries, formatTopicLine, findTopicLine, invalidateTopicFileCache } from "./memory-tree.js";
import { embedEntry, removeEmbedding, vectorSearch } from "./memory-embeddings.js";
import { getSetting } from "./project-settings.js";

const log = createLogger("memory");

const DEFAULT_NEAR_DUPLICATE_THRESHOLD = 0.90;
/** Vector similarity floor for contradiction candidates (issue #915). */
const DEFAULT_CONFLICT_SIMILARITY_THRESHOLD = 0.55;

/** Near-duplicate threshold from settings (issue #915). */
function getNearDuplicateThreshold(cwd: string): number {
  const v = Number(getSetting(cwd, "memory_near_duplicate_threshold"));
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : DEFAULT_NEAR_DUPLICATE_THRESHOLD;
}

/** Conflict-candidate similarity floor from settings (issue #915). */
function getConflictSimilarityThreshold(cwd: string): number {
  const v = Number(getSetting(cwd, "memory_conflict_similarity"));
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : DEFAULT_CONFLICT_SIMILARITY_THRESHOLD;
}
/** Safety-net expiry for session-scoped entries (issue #915). */
const SESSION_SCOPE_TTL_MS = 24 * 60 * 60 * 1000;
const VALID_SCOPES: readonly MemoryScope[] = ["session", "task", "project"];

export interface AddMemoryInput {
  text: string;
  category: string;
  pinned?: boolean;
  trigger?: string;
  action?: string;
  verifier?: string;
  /** "session" | "task" | "project" — validated in addMemoryEntry. */
  scope?: string;
  /** Confirm a conflict override — only set after the user explicitly
   *  confirmed the rule changed. Supersedes the conflicting (non-pinned) entry. */
  overrideConflicts?: boolean;
  sourceSession?: string;
  derivedFrom?: string;
  informs?: string[];
}

export type AddMemoryStatus =
  | "added"
  | "reinforced" // exact or near-duplicate match — existing entry reinforced
  | "rejected"; // validation, guardrail, conflict, or capacity rejection

export interface AddMemoryResult {
  status: AddMemoryStatus;
  message: string;
}

// ── Validation ─────────────────────────────────────────────────────────────

function validateTrigger(trigger: string): string | null {
  const validPrefixes = ["bash_contains ", "bash_regex ", "tool_name ", "file_modified "];
  if (!validPrefixes.some((p) => trigger.startsWith(p))) {
    log.warn("memory-write: invalid trigger rejected", trigger.slice(0, 80));
    return (
      `Invalid trigger format "${trigger}". Must start with: ` +
      validPrefixes.map((p) => p.trim()).join(", ")
    );
  }
  return null;
}

function validateAction(action: string): string | null {
  const validActions = ["block", "warn"];
  const isRunAfter = action.startsWith("run_after ");
  if (!validActions.includes(action) && !isRunAfter) {
    log.warn("memory-write: invalid action rejected", action.slice(0, 80));
    return `Invalid action "${action}". Valid: block, warn, run_after <command>`;
  }
  if (isRunAfter && !action.slice("run_after ".length).trim()) {
    log.warn("memory-write: run_after action without a command rejected");
    return `Invalid action "${action}". run_after requires a command (e.g., 'run_after npm test')`;
  }
  return null;
}

/** Shell commands that are NOT pi tools — a `tool_name` trigger naming one
 *  can never fire because these run INSIDE bash (#936 secondary: the
 *  incident's `tool_name curl` + block would have silently blocked nothing,
 *  or worse been assumed to gate sanctioned curl usage). */
const SHELL_COMMAND_TOOL_NAMES = new Set([
  "curl", "wget", "jq", "gh", "docker", "podman", "kubectl", "oc",
  "ssh", "scp", "rsync", "git", "npm", "npx", "pip", "pip3", "uv",
  "tox", "pytest", "python", "python3", "node", "deno", "bun", "make",
  "cargo", "go", "java", "mvn", "gradle",
]);

/** Write-time warning for over-broad or ineffective `tool_name` triggers
 *  (#936). Advisory only — the entry is stored; the warning tells the writer
 *  the trigger may not do what they intend. */
function toolNameTriggerWarning(trigger: string | undefined, action: string | undefined): string | null {
  if (!trigger?.startsWith("tool_name ")) return null;
  const tool = trigger.slice("tool_name ".length).trim();
  // Lookups are case-insensitive (Qodo 53d6b3d0): "Bash" and "Curl" are
  // misspellings of the lowercase pi tool / shell commands — they never
  // fire, so they deserve the same advisories as the exact spellings.
  const toolLower = tool.toLowerCase();
  // No action = dead trigger (Qodo 792c27a3): enforcement loading requires
  // BOTH a trigger and an action, so a bare tool_name trigger never fires —
  // say that instead of describing enforcement that will not occur.
  if (!action) {
    return `warning: trigger "tool_name ${tool}" has no action — it will never fire; add an action (block, warn, or run_after <command>) for enforcement to load it`;
  }
  if (SHELL_COMMAND_TOOL_NAMES.has(toolLower)) {
    return `warning: trigger "tool_name ${tool}" names a shell command, not a pi tool — ${toolLower} runs inside bash, so this trigger never fires; use a bash_contains pattern for the specific command instead`;
  }
  if (toolLower === "bash") {
    return `warning: trigger "tool_name ${tool}" with action ${action ?? "(none)"} applies to EVERY bash call — usually over-broad; prefer a bash_contains pattern targeting the specific command`;
  }
  return null;
}

// ── Contradiction gate ─────────────────────────────────────────────────────

/** Prohibition markers — text forbids an action. */
const NEGATION_RE =
  /\b(never|not|no|don'?t|do not|doesn'?t|didn'?t|cannot|can'?t|won'?t|mustn'?t|must not|forbidden|avoid|stop)\b/i;
/** Permission markers — text allows an action. "always" is a permit by
 *  force: "always use X" vs "never use X" is the canonical flip, and
 *  without it the near-duplicate path silently REINFORCES the opposite
 *  rule (live battery, round 7, PR #916). A bare "only" is deliberately
 *  NOT here (Qodo round 8): sentence-initial or trailing "only" is a
 *  restrictive qualifier ("only stage files after tests pass") and
 *  treating it as permission falsely rejected unrelated restrictions. */
const PERMIT_RE =
  /\b(can|may|allowed|permit(ted|s)?|okay|ok|go ahead|feel free|fine to|(is|are|'s) fine|acceptable|safe to|always)\b/i;
/** Affirmative-exclusive instruction — `only` IMMEDIATELY AFTER an action
 *  verb AND followed by a permitted object/tool, not a temporal continuation
 *  ("use only uv", "install only via pip", "commit only through git-expert"):
 *  the sentence exclusively permits that action's tool, so it opposes a
 *  prohibition of the same action (Qodo rounds 9+10, PR #916). A bare or
 *  sentence-initial `only` never matches (round 8), and `only after/when/
 *  until/...` is a temporal restriction, not a permission (round 10). */
const ONLY_PERMIT_RE =
  /\b(?:use|uses|using|install|installs|installing|run|runs|running|execute|executes|executing|deploy|deploys|deploying|commit|commits|push|pushes|merge|merges|write|writes|call|calls|invoke|invokes)\s+only\s+(?!(?:after|before|when|while|until|once|if|unless|during|upon|prior|in\s+case)\b)[a-z0-9"'`_*\x00]/i;

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "for", "with",
  "you", "your", "we", "our", "user", "agent", "llm", "this", "that", "these",
  "those", "is", "are", "am", "was", "were", "be", "been", "it", "its", "as",
  "at", "by", "from", "not", "no", "yes", "do", "does", "did", "will", "would",
  "should", "could", "can", "may", "must", "shall", "when", "what", "which",
]);

/** Light stem so inflected verbs match their base form (Qodo adbd3504):
 *  push/pushing, merge/merges/merging, commit/committed must compare
 *  equal — exact tokens with only a trailing-s strip let reworded
 *  opposites ("Never push to main" vs "Pushing to main is okay") slip
 *  past the gate. Strips -ing/-ed/-es/-s with a min-stem-length guard
 *  (sing, thing stay intact) and repairs doubled consonants left by
 *  suffix removal (running→run, committing→commit). */
function stem(word: string): string {
  // Clipping expansions run FIRST (Qodo d44e182b, 7ed1ea1e): "app" and
  // "application" are the same target, and expanding before suffix
  // handling keeps the pair consistent — expanding at the end left k8s →
  // "kubernetes" unstemmed while a literal "kubernetes" stemmed to
  // "kubernet", so the synonym never matched.
  let w = CLIPPING_EXPANSIONS[word] ?? word;
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (w.length > suffix.length + 2 && w.endsWith(suffix)) {
      const base = w.slice(0, -suffix.length);
      // Doubled-consonant repair (Qodo 59932c0a): running→runn→run needs
      // the repair, but ll/ss/ff/zz are letters that double in BASE words
      // (install→installing keeps both ls) — repairing those split
      // "installing" from "install".
      const dbl = /([a-z])\1$/.exec(base);
      w = dbl && !"lsfz".includes(dbl[1]!) && base.length > 3 ? base.slice(0, -1) : base;
      break;
    }
  }
  // Silent-e (Qodo 833b46be): "packages" strips -es to "packag" while
  // singular "package" kept its e — the pair never matched. Drop a final
  // e on long words so singular/plural/inflected forms converge.
  if (w.endsWith("e") && w.length >= 5) w = w.slice(0, -1);
  return w;
}

/** Common clippings expanded to their full form during stemming so a
 *  short and long spelling of the same target compare equal. Keep this a
 *  small, domain-relevant list — every entry is a pair that genuinely
 *  names the same thing, never two different products (git/github). */
const CLIPPING_EXPANSIONS: Record<string, string> = {
  app: "application",
  repo: "repository",
  config: "configuration",
  auth: "authentication",
  info: "information",
  doc: "documentation",
  prod: "production",
  k8s: "kubernetes",
};

function contentWords(text: string): Set<string> {
  // Lowercase content words with naive plural stripping, for overlap scoring
  // (Qodo 10865d53: this doc was stranded above the stem helper).
  const words = text.toLowerCase().match(/[a-z][a-z0-9#-]*/g) ?? [];
  const out = new Set<string>();
  for (const w of words) {
    // Stop-word check on the RAW form too (Qodo 72013bb5): stem drops the
    // silent e (these→thes, those→thos), and the stemmed forms are not in
    // STOP_WORDS — the demonstratives then counted as shared content words
    // and manufactured clause overlap.
    if (STOP_WORDS.has(w)) continue;
    const norm = stem(w);
    if (norm.length >= 2 && !STOP_WORDS.has(norm)) out.add(norm);
  }
  return out;
}

/** True when one text permits what the other forbids (permission flip).
 *  The non-negated side must carry the OPPOSING permission: a candidate that
 *  mixes negation and permission in its own text ("Enforce via code, not
 *  rules — code can't be ignored, rules can") must not clash with a neutral
 *  new entry that merely shares a topic word.
 *
 *  CLAUSE-SCOPED (#936): a polarity marker only governs its own clause, not
 *  the whole sentence. "never publish with a dead token" does not contradict
 *  "always publish to npm" — the polarized clauses share no action, so the
 *  rules are complementary. A clash requires a negation clause from one text
 *  and a permission clause from the other that share the action (≥ 2 content
 *  words), e.g. "never merge code PRs" vs "can merge code PRs".
 *
 *  QUOTED SPANS ARE STRIPPED first: a literal payload inside quotes —
 *  "with 'say OK'" in a test procedure — is not a permission marker. The
 *  #936 incident: a pinned how-to containing 'say OK' was treated as a
 *  permit and blocked an unrelated scheduling rule containing "never". */
function polarityClash(a: string, b: string): boolean {
  // Clause lists keep the RAW text — a quoted tool name ('uv') IS an action
  // object for the overlap check (Qodo 0f0ad673) — while polarity MARKERS
  // are detected per clause on the quote-stripped clause, so literal
  // payloads ('say OK') never read as markers (#936).
  const aNeg = negationClauses(a);
  const aPerm = permissionClauses(a);
  const bNeg = negationClauses(b);
  const bPerm = permissionClauses(b);
  return (
    polarizedClausesClash(aNeg, aPerm, bNeg, bPerm) ||
    polarizedClausesClash(bNeg, bPerm, aNeg, aPerm)
  );
}

/** Curly-quote partners (Qodo 9c430f3d): “ ” and ‘ ’ pair with each other;
 *  straight quotes and backticks pair with themselves. */
const QUOTE_PARTNER: Record<string, string> = {
  "\u201c": "\u201d",
  "\u201d": "\u201c",
  "\u2018": "\u2019",
  "\u2019": "\u2018",
};
const OPENING_QUOTES = new Set(["'", '"', "`", "\u201c", "\u2018"]);

/** Same-length mask: characters inside contraction-safe quoted spans are
 *  replaced with \x00, so separators, polarity words, and permission markers
 *  inside a quoted payload are invisible to clause splitting and marker
 *  regexes (Qodo 652e15cd: 'ok; sure' must not split or permit; Qodo
 *  874f0adc: 'don't use npm' must not prohibit). Quote state opens only at
 *  a non-word boundary and closes only when the next char is not a word
 *  char — apostrophes inside contractions (don't, users') and inside quoted
 *  payloads are content, never delimiters. */
export function quotedMask(text: string, initialBanned: ReadonlySet<number> = new Set()): string {
  // Word-char classes are UNICODE (Qodo ad3da7c8): an apostrophe after an
  // accented letter (Beyoncé's) must not open a quote span — ASCII \w
  // would miss é and mask the rest of the text, hiding real prohibitions.
  const WORD_CHAR = /[\p{L}\p{N}\p{M}_\uD800-\uDFFF]/u;
  const BOUNDARY_CHAR = /[\p{L}\p{N}\p{M}_'"\u2018\u2019\u201c\u201d\uD800-\uDFFF]/u;
  const src = text.split("");
  const banned = new Set(initialBanned);
  // Iterative retry, not recursion (Qodo 2a41ba6b): each unclosed opener
  // needs a fresh pass, and recursion depth grows with the number of
  // unmatched apostrophes — thousands of them overflowed the stack. The
  // cap bounds the (inherently one-opener-per-pass) retry loop for
  // adversarial inputs; real memory texts never approach it.
  const MAX_RETRY_PASSES = 1024;
  for (let pass = 0; ; pass++) {
    const out = src.slice();
    let quote: string | null = null;
    let openIndex = -1;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i]!;
      // Backslash-escaped quote chars are CONTENT (Qodo bfca536f): in
      // `say \"ok; sure\"` the escaped quotes never open or close a span.
      // Parity matters (Qodo 9468b527): a quote after TWO backslashes is
      // NOT escaped — the first backslash escapes the second — so it is a
      // real delimiter.
      let bs = 0;
      for (let j = i - 1; j >= 0 && src[j] === "\\"; j--) bs++;
      const escaped = bs % 2 === 1;
      if (escaped && (OPENING_QUOTES.has(ch) || QUOTE_PARTNER[ch] !== undefined)) {
        out[i] = "\x00";
        continue;
      }
      if (quote === null) {
        if (!banned.has(i) && OPENING_QUOTES.has(ch) && !BOUNDARY_CHAR.test(i > 0 ? src[i - 1]! : "")) {
          quote = ch;
          openIndex = i;
          out[i] = "\x00";
        }
      } else if (ch === (QUOTE_PARTNER[quote] ?? quote)) {
        if (!WORD_CHAR.test(src[i + 1] ?? "")) quote = null;
        out[i] = "\x00";
      } else {
        out[i] = "\x00";
      }
    }
    // Unclosed quote (Qodo c23b9d86): an elision like 'til or a stray
    // apostrophe opened a span that never closed and would mask the rest
    // of the text — hiding later separators and polarity markers. Redo
    // the pass treating that opener as plain content. Banned openers
    // ACCUMULATE across retries (Qodo b0c6383f): banning only the latest
    // one let two stray apostrophes alternate forever. The pass cap keeps
    // adversarial inputs from spinning the loop (Qodo 2a41ba6b), and when
    // it is reached the still-open span is RESTORED, not left masked —
    // masked-at-cap would hide a prohibition trailing the unmatched
    // openers from polarity detection (Qodo bc5a3517).
    if (quote !== null && !banned.has(openIndex)) {
      if (pass < MAX_RETRY_PASSES) {
        banned.add(openIndex);
        continue;
      }
      for (let i = openIndex; i < out.length; i++) out[i] = src[i]!;
    }
    return out.join("");
  }
}

/** Split into clauses: polarity markers only govern their own clause.
 *  QUOTE-AWARE (Qodo 652e15cd): separators inside quoted payloads do not
 *  split — the mask is same-length, so the mask's split indices slice the
 *  original text and clauses keep their RAW content (quoted tool names
 *  remain action objects for the overlap check). Colons do NOT split (Qodo
 *  0ae964c1): words after a colon routinely complete the preceding action
 *  ("Never publish: npm packages"), and label prefixes merging into the
 *  following clause is harmless — labels carry no polarity markers. */
function splitClauses(text: string): string[] {
  let mask = quotedMask(text);
  // Paired dashes are parenthetical (Qodo 9e179121): "NEVER — under any
  // circumstances — push to main" — a dash-bounded segment WITHOUT a
  // polarity marker, whose continuation after the pair also carries no
  // marker, is a modifier of the surrounding action, not its own clause
  // (Qodo 20adf2da: when the text after the closing dash starts its own
  // polarized instruction — "… — always deploy production" — the dashes
  // separate independent instructions and must keep splitting).
  // Neutralize qualifying dash PAIRS in the mask (same length); a pair
  // whose content carries a polarity marker stays a separator, and so does
  // every unpaired dash.
  const dashIdx: number[] = [];
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === "\u2014" || mask[i] === "\u2013") dashIdx.push(i);
  }
  if (dashIdx.length >= 2) {
    const chars = mask.split("");
    for (let p = 0; p + 1 < dashIdx.length; p += 2) {
      const a = dashIdx[p]!;
      const b = dashIdx[p + 1]!;
      const between = mask.slice(a + 1, b);
      const afterEnd = (() => {
        let e = mask.length;
        for (let i = b + 1; i < mask.length; i++) {
          const c = mask[i]!;
          if (c === ";" || c === "\n" || c === "\u2014" || c === "\u2013") {
            e = i;
            break;
          }
        }
        return e;
      })();
      const after = mask.slice(b + 1, afterEnd);
      const markerFree =
        !NEGATION_RE.test(between) && !PERMIT_RE.test(between) && !ONLY_PERMIT_RE.test(between);
      const continuation =
        !NEGATION_RE.test(after) && !PERMIT_RE.test(after) && !ONLY_PERMIT_RE.test(after);
      if (markerFree && continuation) {
        chars[a] = "\x00";
        chars[b] = "\x00";
      }
    }
    mask = chars.join("");
  }
  const bounds: number[] = [0];
  // Case-insensitive (Qodo eb263200): "However," and "BUT" must split
  // exactly like their lowercase spellings. Sentence-ending periods split
  // too (Qodo d59a6de5): "Never push to main. You can push to feature
  // branches." must not stay one clause — its permission sentence was
  // discarded by negation-dominance and the pinned rule then rejected its
  // own exception. A period must be followed by whitespace, so decimals
  // (3.5), file names (file.ts) and ellipses stay intact.
  // Sentence-ending periods split clauses, but abbreviation periods do
  // not (Qodo ab8d2a82, d6fa46c0): "e.g." and "i.e." are covered by the
  // two-letter rule (their first period follows a single letter), while
  // multi-letter abbreviations — "etc.", "vs.", "approx.", "inc.",
  // "ltd.", "dept." — are excluded by an explicit lookbehind list, since
  // two letters precede their period and the length rule alone would
  // split "Never run rm, mv, etc. on shared hosts" and cut the trailing
  // scope off the negation clause.
  const re =
    /[\n;\u2014\u2013]|(?<=[a-z]{2})(?<!\betc\b)(?<!\bvs\b)(?<!\bapprox\b)(?<!\binc\b)(?<!\bltd\b)(?<!\bdept\b)\.(?=\s)|\bbut\b|\bhowever\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(mask))) {
    bounds.push(m.index + m[0].length);
  }
  // Coordinated clauses (Qodo 1ad018b0, 438cc007): "Never use npm and
  // always run tests" — an "and"/"or" whose continuation LEADS with a
  // polarity marker (within its first two words) starts a new clause. A
  // marker deeper in the tail does NOT split: "Never publish npm and PyPI
  // packages and always update docs" — the first and joins the OBJECTS of
  // the prohibition (PyPI packages is banned too), only the marker-led
  // and opens a clause.
  const andRe = /\b(?:and|or)\b/gi;
  while ((m = andRe.exec(mask))) {
    const start = m.index + m[0].length;
    let nextBound = mask.length;
    for (const b of bounds) {
      if (b > start && b < nextBound) nextBound = b;
    }
    const tail = mask.slice(start, nextBound);
    const lead = tail.trim().split(/\s+/).slice(0, 2).join(" ");
    if (NEGATION_RE.test(lead) || PERMIT_RE.test(lead) || ONLY_PERMIT_RE.test(lead)) {
      bounds.push(start);
    }
  }
  bounds.sort((x, y) => x - y);
  const clauses: string[] = [];
  for (let i = 0; i < bounds.length; i++) {
    const raw = text.slice(bounds[i]!, bounds[i + 1] ?? text.length).trim();
    if (raw) clauses.push(raw);
  }
  return clauses;
}

function negationClauses(text: string): string[] {
  return splitClauses(text).filter((c) => NEGATION_RE.test(quotedMask(c)));
}

/** Permission clauses — a clause that ALSO matches a negation marker is a
 *  prohibition, not a permission (Qodo e788f4b2): "may not", "can't",
 *  "not allowed", "not okay" contain permit words (may/can/allowed/okay)
 *  but mean the opposite. Without this, a pinned "You may not merge PRs"
 *  counts as its own permission and rejects the faithful restatement
 *  "Never merge PRs". */
function permissionClauses(text: string): string[] {
  return splitClauses(text).filter(
    (c) =>
      !NEGATION_RE.test(quotedMask(c)) &&
      (PERMIT_RE.test(quotedMask(c)) || ONLY_PERMIT_RE.test(quotedMask(c))),
  );
}

/** Restatement-grade clause agreement (Qodo f464da16): the agreeing clause
 *  must share ≥ 2 content words AND cover ≥ 80% of the shorter clause's
 *  content words. "never publish PyPI packages" vs "never publish npm
 *  packages" share only the generic action (publish, package) — 2 of 3 — so
 *  swapped compound rules still conflict; an exact or lightly reworded
 *  restatement agrees and dedup reinforces it. */
/** Action words: clause content minus polarity markers (Qodo 8f4191ef).
 *  "Never deploy" and "Always deploy" must compare as the SAME single-word
 *  action — polarity words never count toward action overlap, and a clash
 *  is not skipped just because one clause adds objects the other omits. */
const ACTION_MARKER_WORDS_RE =
  /\b(?:never|always|not|no|don'?t|do\s+not|doesn'?t|didn'?t|cannot|can'?t|won'?t|mustn'?t|must\s+not|forbidden|avoid|stop|can|may|might|allowed|allow|permits?|permitted|okay|ok|go\s+ahead|feel\s+free|fine|acceptable|safe\s+to|only|but|however)\b/gi;

function actionWords(clause: string): Set<string> {
  return contentWords(clause.replace(ACTION_MARKER_WORDS_RE, " "));
}

/** Raw (unstemmed) action words (Qodo 2fb4dd7e): the distinct-target
 *  exclusion must see the SURFACE forms — stem() over-merges bases/bass
 *  into "bas", so stemmed diff sets never contained the differing word
 *  and the exclusion could not fire for complementary rules about them. */
function rawActionWords(clause: string): Set<string> {
  const cleaned = clause.replace(ACTION_MARKER_WORDS_RE, " ");
  const words = cleaned.toLowerCase().match(/[a-z][a-z0-9#-]*/g) ?? [];
  const out = new Set<string>();
  for (const w of words) {
    if (STOP_WORDS.has(w)) continue;
    if (w.length >= 2) out.add(w);
  }
  return out;
}

/** Leading condition of a clause: the content words BEFORE the first
 *  polarity marker (live battery, #936). "When npm whoami fails with E401
 *  during a release, never continue publishing" — the words ahead of
 *  "never" are the CONDITION the prohibition is scoped to. Only spans
 *  containing a conditional subordinator count: "Pushing to main is okay"
 *  has words before its marker, but they are the action, not a condition.
 *  Uses String.search so the shared global marker regex's lastIndex is
 *  not consumed. */
/** Fixed adverbial idioms that BEGIN with a subordinator word but carry
 *  no condition (Qodo 7c839ae6): "Once again, never push" is a discourse
 *  marker, not a scoped ban. */
const LEADING_CONDITION_IDIOMS =
  /^(?:once\s+again|after\s+all|when\s+in\s+doubt|in\s+any\s+case|if\s+anything|when\s+all\s+is\s+said)\b/i;

/** Polarity markers that END a leading condition (Qodo d689acbf): unlike
 *  ACTION_MARKER_WORDS_RE this excludes qualifier and discourse words
 *  (only, but, however, may, can, might, allow, ok, fine) that appear
 *  INSIDE conditions — "When only the release branch is ready, never
 *  deploy" must treat the whole span before "never" as the condition, not
 *  cut it at "only" and lose the scoping. */
const CONDITION_BOUNDARY_RE =
  /\b(?:never|always|not|no|don'?t|do\s+not|doesn'?t|didn'?t|cannot|can'?t|won'?t|mustn'?t|must\s+not|forbidden|avoid|stop|allowed|permit(?:ted|s)?|okay|go\s+ahead|feel\s+free|fine\s+to|acceptable|safe\s+to)\b/i;

/** Leading condition of a clause: the content words BEFORE the first
 *  polarity marker (live battery, #936). "When npm whoami fails with E401
 *  during a release, never continue publishing" — the words ahead of
 *  "never" are the CONDITION the prohibition is scoped to. Only spans
 *  containing a conditional subordinator count: "Pushing to main is okay"
 *  has words before its marker, but they are the action, not a condition.
 *  `escape` marks UNLESS-led clauses (Qodo 7c839ae6): "Unless the user
 *  says otherwise, never push" is a GENERAL ban whose condition is the
 *  escape hatch, not the scope — it inverts which permissions coexist. */
function leadingCondition(clause: string): { words: Set<string>; escape: boolean } {
  const empty = { words: new Set<string>(), escape: false };
  const idx = clause.search(CONDITION_BOUNDARY_RE);
  if (idx <= 0) return empty;
  const lead = clause.slice(0, idx);
  if (LEADING_CONDITION_IDIOMS.test(lead)) return empty;
  // Only true subordinators count (Qodo 4da6e3e5): "on" and "where" are
  // plain prepositions — "Agents on this repo must never push to main"
  // has no condition before the marker, and treating the subject phrase
  // as one let "Always push to main" coexist with the pinned ban.
  const m = lead.match(/\b(when|if|unless|whenever|once|after|before|during|upon|while|in\s+case)\b/i);
  if (!m) return empty;
  return { words: contentWords(lead), escape: m[1]!.toLowerCase() === "unless" };
}

/** Masked action words: quoted payload content does not count (Qodo
 *  c92087ed). Used for the NEGATION side of a clash candidate and for
 *  agreement — an example quoted inside a prohibition ("Never inspect logs
 *  containing 'use npm'") is content of the rule about logs, not the
 *  prohibited action itself. The permission side stays RAW so a quoted
 *  tool name remains the permitted object ("use only `uv`"). */
function maskedActionWords(clause: string): Set<string> {
  return contentWords(quotedMask(clause).replace(ACTION_MARKER_WORDS_RE, " "));
}

function sharedCount(ax: Set<string>, ay: Set<string>): number {
  let shared = 0;
  for (const w of ay) {
    if (ax.has(w)) shared++;
  }
  return shared;
}

/** Restatement-grade clause alignment. Measured against the LONGER clause
 *  too (Qodo 8ec45667): a broad permission ("always publish") must not
 *  align with a narrower one ("always publish npm packages") — alignment is
 *  reserved for near-identical restatements so genuine conflicts cannot
 *  hide behind a short, generic clause. RAW action words on BOTH sides
 *  (Qodo 92151894): a quoted tool name is exactly what distinguishes a
 *  restatement from a swapped compound ("never use 'uv'" vs "never use
 *  'npm'"), so masking either side of the agreement check lets a tool swap
 *  pass as a restatement. Masking remains on the negation side of the CLASH
 *  CANDIDATE only (incidental quoted examples, Qodo c92087ed). */
function clausesAgree(x: string, y: string): boolean {
  const ax = actionWords(x);
  const ay = actionWords(y);
  const shared = sharedCount(ax, ay);
  if (shared < 2) return false;
  const longer = Math.max(ax.size, ay.size);
  return shared >= Math.ceil(longer * 0.8);
}

/** A prohibition from A and a permission from B clash when their CLAUSES
 *  share the action — global polarity with different objects is a
 *  complementary rule, not a contradiction (#936). A single shared action
 *  word counts only when it IS the whole action ("Never deploy" vs "Always
 *  deploy", Qodo 8f4191ef); longer clauses still need ≥ 2 shared action
 *  words. Clause alignment (Qodo f464da16): when B ALSO forbids what A
 *  forbids and A ALSO permits what B permits (restatement-grade, see
 *  clausesAgree), the two entries restate the same compound rule — the gate
 *  must not reject it; dedup reinforces it instead. */
function polarizedClausesClash(negA: string[], permA: string[], negB: string[], permB: string[]): boolean {
  for (const neg of negA) {
    for (const perm of permB) {
      // Candidate threshold MASKED on both sides (Qodo 29a4da4e, c92087ed):
      // quoted content is never the action — an example inside a
      // permission ("document the phrase \"deploy to production\"") must
      // not supply overlap, and an example inside a prohibition must not
      // either.
      const negMasked = maskedActionWords(neg);
      const permMasked = maskedActionWords(perm);
      const shared = sharedCount(negMasked, permMasked);
      const shorter = Math.min(negMasked.size, permMasked.size);
      if (!(shared >= 2 || (shared >= 1 && shared === shorter))) continue;
      // Distinct-target exclusion on RAW words (Qodo 4fe7b1c3, 6d0214c7):
      // quoted tool names ARE the targets — "never use 'npm'" vs "always
      // use 'uv'" differ by exactly one mid-clause word per side and are
      // complementary; identical raw actions (same quoted tool both sides)
      // have empty diffs and still clash. The exclusion needs BOTH diffs
      // non-empty, exactly one word each, and not morphological variants
      // (run/running). Position guard: each diff word sits BETWEEN shared
      // words in its clause — trailing qualifiers and leading temporals
      // ("From now on ...") never qualify. Stem over-merge bypass (Qodo
      // 2fb4dd7e): bases and bass both stem to "bas" yet are not
      // raw-affine variants — when the diff words have EQUAL STEMS but
      // different surface forms, the stemmer manufactured the sameness,
      // and the exclusion fires regardless of position.
      const negRaw = rawActionWords(neg);
      const permRaw = rawActionWords(perm);
      const negOnly = [...negRaw].filter((w) => !permRaw.has(w));
      const permOnly = [...permRaw].filter((w) => !negRaw.has(w));
      if (negOnly.length === 1 && permOnly.length === 1) {
        const diffA = negOnly[0]!;
        const diffB = permOnly[0]!;
        if (!isVariantWord(diffA, diffB)) {
          const stemmerOverMerge = stem(diffA) === stem(diffB);
          if (
            stemmerOverMerge ||
            (diffWordIsMidClause(neg, diffA, permRaw) &&
              diffWordIsMidClause(perm, diffB, negRaw))
          ) {
            log.debug(
              "memory-write: distinct-target exclusion",
              diffA,
              "vs",
              diffB,
              stemmerOverMerge ? "(stem over-merge)" : "",
            );
            continue;
          }
        }
      }
      // Condition-scoped exceptions (live battery, #936): a PROHIBITION
      // whose polarity marker is preceded by a conditional subordinator is
      // an EXCEPTION, not a general ban — "When whoami fails with E401,
      // never continue publishing" coexists with the "After /release,
      // ALWAYS publish" mandate because the mandate does not carry the
      // failure condition. The exception is asymmetric by design: a
      // condition-scoped PERMISSION against a general prohibition stays a
      // conflict ("After /release ALWAYS publish to PyPI" vs "never publish
      // to PyPI" must still reject — the mandate instructs what the ban
      // forbids). The scopes match when the permission covers a STRICT
      // MAJORITY of the condition words (Qodo 6b17d4ae): "When deploying
      // service to production, never use npm" still rejects "Always use
      // npm when deploying to production" (2 of 3 condition words) while
      // the E401 failure condition (2 of 6) stays an exception. UNLESS-led
      // clauses invert (Qodo 7c839ae6): "Unless the user says otherwise,
      // never push to main" is a GENERAL ban with an escape hatch — it
      // coexists only with a permission that carries the escape condition,
      // and rejects an unconditioned "Always push to main".
      const negCond = leadingCondition(neg);
      if (negCond.words.size > 0) {
        const permWords = contentWords(perm);
        const covered = [...negCond.words].filter((w) => permWords.has(w)).length;
        const majority = covered * 2 > negCond.words.size;
        if (negCond.escape ? majority : !majority) {
          log.debug(
            "memory-write: condition-scoped prohibition coexists — permission does not carry the condition",
            neg.slice(0, 80),
          );
          continue;
        }
      }
      const negAgrees = negB.some((n) => clausesAgree(neg, n));
      const permAgrees = permA.some((p) => clausesAgree(perm, p));
      if (negAgrees && permAgrees) continue;
      log.debug(
        "memory-write: clause clash — prohibition vs permission share the action",
        neg.slice(0, 80),
        "vs",
        perm.slice(0, 80),
      );
      return true;
    }
  }
  return false;
}

/** Morphological variant check (Qodo 5a346f0f, 2fb4dd7e): identical
 *  inflections must compare equal, but the light stemmer OVER-MERGES some
 *  pairs — bases and bass both stem to "bas" — and a stem-equality-only
 *  check made the distinct-target exclusion treat them as the same word,
 *  so a pinned "Never store bases" wrongly rejected "Always store bass".
 *  Stem equality only counts with RAW affinity: identical, prefix
 *  extension (run/running), or final-vowel mutation (carri/carry). */
function isVariantWord(a: string, b: string): boolean {
  if (a === b) return true;
  // Clipping pairs are the SAME target by declaration (Qodo 7ed1ea1e):
  // k8s→kubernetes stems converge via the table, but the RAW forms are
  // not prefix- or vowel-affine — without this check the distinct-target
  // exclusion treated them as different objects and let opposing rules
  // for the same cluster coexist.
  if (CLIPPING_EXPANSIONS[a] === b || CLIPPING_EXPANSIONS[b] === a) return true;
  if (stem(a) !== stem(b)) return false;
  const [x, y] = a.length <= b.length ? [a, b] : [b, a];
  if (x.length >= 3 && y.startsWith(x)) return true;
  if (a.length === b.length && a.length >= 4) {
    const prefix = a.slice(0, -1);
    return (
      b.startsWith(prefix) &&
      /[aeiouy]/.test(a.slice(-1)) &&
      /[aeiouy]/.test(b.slice(-1))
    );
  }
  return false;
}

/** Ordered content-word sequence of a clause (same tokenization and
 *  stemming as contentWords, order preserved) — used for positional
 *  checks in the distinct-target exclusion. */
function orderedContentWords(clause: string): string[] {
  const words = clause.toLowerCase().match(/[a-z][a-z0-9#-]*/g) ?? [];
  const out: string[] = [];
  for (const w of words) {
    if (STOP_WORDS.has(w)) continue;
    const norm = stem(w);
    if (norm.length >= 2 && !STOP_WORDS.has(norm) && !out.includes(norm)) out.push(norm);
  }
  return out;
}

/** The diff word sits BETWEEN shared words ("deploy PRODUCTION builds"):
 *  shared content exists both before and after it in the clause's word
 *  order. A trailing qualifier ("…, spaces only") or a leading temporal
 *  ("from now on …") is NOT a target — those are incidental modifiers, so
 *  the exclusion must not fire for them. */
function diffWordIsMidClause(clause: string, diff: string, otherWords: Set<string>): boolean {
  const seq = orderedContentWords(clause);
  // The diff word may be a RAW surface form while the ordered sequence is
  // stemmed (Qodo 2fb4dd7e moved the diff sets to raw words) — locate it
  // by stem equality, not exact index.
  const idx = seq.findIndex((w) => w === diff || stem(w) === stem(diff));
  if (idx <= 0 || idx >= seq.length - 1) return false;
  const before = seq.slice(0, idx).some((w) => otherWords.has(w) || [...otherWords].some((o) => stem(o) === stem(w)));
  const after = seq.slice(idx + 1).some((w) => otherWords.has(w) || [...otherWords].some((o) => stem(o) === stem(w)));
  return before && after;
}

function sharedContentWords(a: string, b: string): number {
  const wa = contentWords(a);
  let shared = 0;
  for (const w of contentWords(b)) {
    if (wa.has(w)) shared++;
  }
  return shared;
}

function isEnforcedEntry(entry: ScoredEntry | undefined): boolean {
  return !!entry && (!!((entry.trigger && entry.action) || entry.verifier));
}

export interface ConflictCandidate {
  text: string;
  category: MemoryCategory;
  pinned: boolean;
  enforced: boolean;
}

/**
 * Find every existing entry that the new text contradicts (Qodo #6,
 * PR #916). Returning ALL conflicts — not just the best one — matters for
 * correctness: if a non-pinned entry outranked a pinned one, the pinned
 * entry escaped the gate entirely and a confirmed override superseded only
 * the best match, leaving the other contradiction in place.
 *
 * Candidates: same-category entries, pinned entries, and enforced entries
 * (the protected classes), narrowed by vector similarity when the embedding
 * model is available and by content-word overlap otherwise. A candidate is a
 * conflict when permission polarity flips (one forbids, the other permits).
 * Results are sorted best-first.
 */
export async function findContradiction(
  cwd: string,
  text: string,
  category: string,
): Promise<ConflictCandidate[]> {
  const topicEntries = readAllTopicEntries(cwd);
  if (topicEntries.length === 0) return [];
  const scores = loadScores(cwd);

  // Protected pool: same category + pinned + enforced. These are the entries
  // a one-off grant is most likely to contradict (issue #915 incident).
  const pool: ConflictCandidate[] = [];
  const seen = new Set<string>();
  for (const te of topicEntries) {
    const key = `${te.category}:${te.text}`;
    if (seen.has(key)) continue;
    const scored = scores.entries[entryHash(`- [${te.category}] ${te.text}`)];
    const enforced = isEnforcedEntry(scored);
    if (te.category === category || te.pinned || enforced) {
      seen.add(key);
      pool.push({ text: te.text, category: te.category, pinned: te.pinned, enforced });
    }
  }
  if (pool.length === 0) return [];

  // Vector-narrowed candidates (paraphrase-tolerant). Model may be
  // unavailable — the overlap fallback below still applies. Entries with NO
  // embedding are never dropped by narrowing (Qodo #7, PR #916): a pinned
  // or recently added entry that has not been embedded yet must still reach
  // the overlap check, or it becomes invisible to the conflict gate.
  // topK covers the WHOLE pool (Qodo round 2, PR #916): with a small topK,
  // embedded-but-dissimilar entries are absent from the results and were
  // indistinguishable from unembedded ones.
  let candidates = pool;
  const similarKeys = new Set<string>();
  let similarityByText = new Map<string, number>();
  try {
    const vectorMatches = await vectorSearch(
      cwd,
      text,
      pool.map((p) => ({ text: p.text, category: p.category, pinned: p.pinned })),
      pool.length,
    );
    similarityByText = new Map(
      vectorMatches.map((vm) => [`${vm.category}:${vm.text}`, vm.similarity]),
    );
    const matchedKeys = new Set(vectorMatches.map((vm) => `${vm.category}:${vm.text}`));
    for (const vm of vectorMatches) {
      if (vm.similarity >= getConflictSimilarityThreshold(cwd)) {
        similarKeys.add(`${vm.category}:${vm.text}`);
      }
    }
    if (similarKeys.size > 0 || matchedKeys.size > 0) {
      // Keep vector-similar entries AND entries the vector search never saw
      // (no embedding) — the latter fall through to the overlap check.
      candidates = pool.filter(
        (p) => similarKeys.has(`${p.category}:${p.text}`) || !matchedKeys.has(`${p.category}:${p.text}`),
      );
    }
  } catch (err) {
    log.debug("memory-write: conflict vector search unavailable, using overlap fallback", err);
  }

  // Collect EVERY conflicting candidate, best score first — first match in
  // file order could be a weaker conflict than the real one.
  const conflicts: Array<{ candidate: ConflictCandidate; score: number }> = [];
  for (const candidate of candidates) {
    if (!polarityClash(text, candidate.text)) continue;
    // Vector-CONFIRMED candidates (similarity ≥ threshold) are already
    // topically related, so one shared content word corroborates; every
    // other candidate (unembedded, or vector search unavailable) needs the
    // strict ≥ 2 corroboration (Qodo round 2, PR #916: a global loose gate
    // let a single shared word like "main" reject unrelated rules).
    const shared = sharedContentWords(text, candidate.text);
    const vectorConfirmed = similarKeys.has(`${candidate.category}:${candidate.text}`);
    // Short rules (Qodo 2c16ab75): "Never deploy" vs "Always deploy" —
    // the single shared word IS the whole rule, so the strict ≥ 2 gate
    // would discard the candidate before the clause gate ever sees the
    // polarity flip. Admit one shared word when BOTH texts are that short
    // (≤ 2 content words); the clause-level clash thresholds still apply.
    const shortPair =
      contentWords(text).size <= 2 && contentWords(candidate.text).size <= 2;
    if (!(shared >= 2 || (vectorConfirmed && shared >= 1) || (shortPair && shared >= 1))) continue;
    const similarity = similarityByText.get(`${candidate.category}:${candidate.text}`) ?? 0;
    conflicts.push({ candidate, score: similarity * 10 + shared });
  }
  conflicts.sort((a, b) => b.score - a.score);
  return conflicts.map((c) => c.candidate);
}

// ── Supersession ─────────────────────────────────────────────────────

/**
 * Invalidate an entry that a confirmed rule change supersedes: remove the
 * topic line, score entry, and embedding. Called from the conflict-override
 * path so no contradiction remains in memory (issue #915).
 */
function supersedeEntry(cwd: string, category: string, text: string): void {
  try {
    const topicName = CATEGORY_TO_TOPIC[category as MemoryCategory];
    if (!topicName) return;
    const topicPath = join(getProjectMemoryDir(cwd), "topics", `${topicName}.md`);
    if (!existsSync(topicPath)) return;
    const content = readFileSync(topicPath, "utf-8");
    const match = findTopicLine(content, category, text);
    if (!match) return;
    const lines = content.split("\n");
    lines.splice(match.index, 1);
    writeFileSync(topicPath, lines.join("\n").replace(/\n{3,}/g, "\n\n"), "utf-8");
    invalidateTopicFileCache(topicPath);

    removeEmbedding(cwd, text, category);

    const canonicalLine = `- [${category}] ${text}`;
    const removedId = match.id;
    mutateScores(cwd, (scores) => {
      delete scores.entries[entryHash(canonicalLine)];
      if (removedId) {
        for (const [hash, entry] of Object.entries(scores.entries)) {
          if (entry.id === removedId) delete scores.entries[hash];
        }
      }
    });
    log.info("memory_supersede", category, text.slice(0, 60));
  } catch (err) {
    log.warn("memory-write: supersede failed:", err);
  }
}

// ── Dedup + enforcement merge ──────────────────────────────────────────

/** Topic-size cap rejection for a prospective new line, or null when it
 *  fits. Shared by the conflict-override path (precheck BEFORE superseding,
 *  Qodo #20 PR #916) and the final write. */
function topicCapRejection(cwd: string, category: string, entryLine: string): AddMemoryResult | null {
  const topicName = CATEGORY_TO_TOPIC[category as MemoryCategory];
  if (!topicName) return null;
  const topicPath = join(getProjectMemoryDir(cwd), "topics", `${topicName}.md`);
  let content = "";
  if (existsSync(topicPath)) {
    content = readFileSync(topicPath, "utf-8");
  } else {
    const title = topicName.replace(/-/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
    content = `# ${title}\n`;
  }
  const newContent = content.trimEnd() + "\n" + entryLine + "\n";
  if (newContent.length > MAX_TOPIC_CHARS) {
    return {
      status: "rejected",
      message:
        `Topic "${topicName}" would exceed size limit (${newContent.length}/${MAX_TOPIC_CHARS} chars). ` +
        `Consolidate or remove entries first using memory_remove.`,
    };
  }
  return null;
}

/** Scope reconciliation on dedup reinforcement (Qodo #10, PR #916): when an
 *  entry is restated WITHOUT a scope (or as project), a previous session/task
 *  scope and its TTL are cleared — the user confirmed the rule is durable.
 *  A narrower restatement never narrows an existing durable entry.
 *  Qodo round 2 (PR #916): when a session-scoped entry is restated in a
 *  DIFFERENT session, the entry rebinds to that session (sourceSession +
 *  fresh TTL) — otherwise the rule the user just restated stays inactive in
 *  the very session that asked for it. */
function reconcileScopeOnReinforce(cwd: string, existingLine: string, input: AddMemoryInput): void {
  mutateScores(cwd, (scores) => {
    const existing = scores.entries[entryHash(existingLine)];
    if (!existing) return;
    if (!input.scope || input.scope === "project") {
      if (!existing.scope || existing.scope === "project") return;
      delete existing.scope;
      delete existing.expiresAt;
      log.info("memory_scope_reconciled", existingLine.slice(0, 60));
      return;
    }
    if (
      input.scope === "session" &&
      existing.scope === "session" &&
      input.sourceSession
    ) {
      // Rebinding ADDS the restating session — it must never steal the entry
      // from a still-active earlier session (Qodo round 3, PR #916).
      const known = new Set(
        [existing.sourceSession, ...(existing.sourceSessions ?? [])].filter((s): s is string => !!s),
      );
      if (!known.has(input.sourceSession)) {
        known.add(input.sourceSession);
        existing.sourceSessions = [...known];
      }
      existing.expiresAt = new Date(Date.now() + SESSION_SCOPE_TTL_MS).toISOString();
      log.info("memory_scope_rebound", existingLine.slice(0, 60), input.sourceSession);
    }
  });
}

// ── Dedup + enforcement merge ──────────────────────────────────────────────

/** Warn from the EFFECTIVE action on the reinforced path (Qodo 453a818e):
 *  a duplicate that adds a trigger without an action keeps the existing
 *  entry's action alive via mergeEnforcementFields — the write is not a
 *  dead trigger, so the base no-action warning must be recomputed against
 *  the merged entry. */
function reinforcedTriggerWarning(
  cwd: string,
  existingLine: string,
  input: AddMemoryInput,
  base: string | null,
): string | null {
  try {
    const existing = loadScores(cwd).entries[entryHash(existingLine)];
    if (!existing) return base;
    // Warn from the EFFECTIVE merged entry in BOTH merge directions
    // (Qodo 453a818e, 0c10e5eb): a duplicate that adds an action to an
    // existing trigger activates it just as much as one that adds a
    // trigger to an existing action — the writer must hear that the
    // newly-live trigger is broad or ineffective either way.
    const effectiveTrigger = input.trigger ?? existing.trigger;
    const existingAction =
      existing.action === "run_after" && existing.actionCommand
        ? `run_after ${existing.actionCommand}`
        : existing.action;
    const effectiveAction = input.action ?? existingAction;
    return toolNameTriggerWarning(effectiveTrigger, effectiveAction) ?? base;
  } catch {
    return base;
  }
}

/** Merge enforcement fields from new input into an existing scored entry.
 *  Locked read-modify-write (issue #915). */
function mergeEnforcementFields(
  cwd: string,
  existingLine: string,
  input: AddMemoryInput,
): boolean {
  if (!input.trigger && !input.action && !input.verifier) return false;
  let merged = false;
  mutateScores(cwd, (scores) => {
    const existing = scores.entries[entryHash(existingLine)];
    if (!existing) return;
    if (input.trigger) existing.trigger = input.trigger as any;
    if (input.action) {
      if (input.action.startsWith("run_after ")) {
        existing.action = "run_after";
        existing.actionCommand = input.action.slice("run_after ".length);
      } else if (input.action === "block" || input.action === "warn") {
        existing.action = input.action;
      }
    }
    if (input.verifier) existing.verifier = input.verifier;
    merged = true;
  });
  return merged;
}

// ── Main entry point ───────────────────────────────────────────────────────

/**
 * Add a memory entry through the unified write path.
 * See module header for the safeguard order.
 */
export async function addMemoryEntry(cwd: string, input: AddMemoryInput): Promise<AddMemoryResult> {
  // Canonicalize tool_name triggers (Qodo dfbdbf1c, 53d6b3d0, 17b68cf5):
  // the enforcement matcher compares the configured name EXACTLY and
  // case-sensitively, so trailing or doubled whitespace ("tool_name bash ")
  // makes the trigger silently dead. pi tool names are MIXED-CASE
  // (TaskCreate, TaskUpdate) — never lowercase blindly; the only targeted
  // case repair is bash, whose real pi tool name is lowercase while
  // "Bash"/"BASH" are common misspellings that would never fire.
  if (input.trigger?.startsWith("tool_name ")) {
    const tool = input.trigger
      .slice("tool_name ".length)
      .replace(/\s+/g, " ")
      .trim();
    // A blank tool name (all-whitespace payload, Qodo ccce07dd) can
    // never match a real invocation — reject instead of storing a dead
    // trigger with an action.
    if (!tool) {
      return {
        status: "rejected",
        message:
          `Rejected: trigger "${input.trigger.trim()}" names no tool — ` +
          `provide the tool name (e.g. "tool_name bash") or use a bash_contains pattern.`,
      };
    }
    input = {
      ...input,
      trigger: `tool_name ${tool.toLowerCase() === "bash" ? "bash" : tool}`,
    };
  }
  const category = input.category;
  const text = input.text;
  const isPinned = input.pinned ?? false;

  // 1. Validation
  if (!VALID_CATEGORIES.includes(category as MemoryCategory)) {
    return {
      status: "rejected",
      message: `Invalid category "${category}". Valid: ${VALID_CATEGORIES.join(", ")}`,
    };
  }
  if (input.trigger) {
    const err = validateTrigger(input.trigger);
    if (err) return { status: "rejected", message: err };
  }
  if (input.action) {
    const err = validateAction(input.action);
    if (err) return { status: "rejected", message: err };
  }
  // Over-broad / ineffective tool_name trigger warning (#936, Qodo
  // 4a6dd686) — computed ONCE here so EVERY success path (added and both
  // reinforced returns) surfaces it; a dedup-reinforced write that merges
  // a dead trigger must warn exactly like a fresh add.
  const triggerWarning = toolNameTriggerWarning(input.trigger, input.action);
  if (triggerWarning) log.warn(`memory-write: ${triggerWarning}`);
  if (input.scope && !VALID_SCOPES.includes(input.scope as MemoryScope)) {
    return {
      status: "rejected",
      message: `Invalid scope "${input.scope}". Valid: ${VALID_SCOPES.join(", ")}`,
    };
  }
  // 1b. Marker-shape guard (Qodo #16, PR #916): topic-line markers are
  // reserved for storage. User text carrying `{#id}`, `*(pinned)*`, or
  // `*(enforced)*` breaks the parse/hash binding — parsers strip markers,
  // so the stored line would hash differently from the requested text.
  if (/\s*\{#[0-9a-f]+\}$/.test(text) || text.includes("*(pinned)*") || text.includes("*(enforced)*")) {
    return {
      status: "rejected",
      message:
        `Rejected: text contains topic-line markers (\`{#id}\`, \`*(pinned)*\`, \`*(enforced)*\`) — ` +
        `these are reserved for storage and break hash binding. Store the plain rule text; ` +
        `pinned/enforced state is set via the \`pinned\`/\`trigger\`+\`action\` parameters.`,
    };
  }

  // 2. Grant-phrase guardrail — one-off permissions are session instructions,
  // not durable memories (issue #915 incident).
  if (isGrantText(text) && input.scope !== "session") {
    return {
      status: "rejected",
      message:
        `Rejected: "${text}" reads like a one-off permission grant (e.g. "you can merge this PR"). ` +
        `One-off grants are session instructions, NOT memories — do not store them. ` +
        `If the user confirmed a standing rule, rephrase it as the durable rule itself ` +
        `(e.g. "Agent may merge release-flow bump PRs") without grant phrasing.`,
    };
  }

  // 3. Contradiction gate — before dedup, so a permission-flipping near-duplicate
  // is refused rather than silently reinforcing the wrong entry. A conflict is
  // a decision point, not a dead end (issue #915): the model asks the user, and
  // a confirmed rule change retries with overrideConflicts, which supersedes
  // ALL the old entries. Pinned entries are never auto-superseded — they are
  // user-explicit and require the user's own memory_remove / memory_edit.
  const conflicts = await findContradiction(cwd, text, category);
  if (conflicts.length > 0) {
    const pinned = conflicts.filter((c) => c.pinned);
    if (pinned.length > 0) {
      const c = pinned[0]!;
      const more =
        conflicts.length > 1
          ? ` (and ${conflicts.length - 1} other conflicting ${conflicts.length - 1 === 1 ? "entry" : "entries"})`
          : "";
      return {
        status: "rejected",
        message:
          `Rejected: contradicts pinned memory "[${c.category}] ${c.text}"${more}. ` +
          `Pinned entries are user-explicit — ask the user (ask_user). If they confirm the rule ` +
          `changed, they must remove or edit the pinned entry (memory_remove / memory_edit) ` +
          `per their instruction first; overrideConflicts does not apply to pinned entries.`,
      };
    }
    const conflict = conflicts[0]!;
    if (!input.overrideConflicts) {
      const more =
        conflicts.length > 1
          ? ` (and ${conflicts.length - 1} other conflicting ${conflicts.length - 1 === 1 ? "entry" : "entries"})`
          : "";
      return {
        status: "rejected",
        message:
          `Rejected: contradicts existing memory "[${conflict.category}] ${conflict.text}"` +
          `${conflict.enforced ? " (code-enforced)" : ""}${more}. ` +
          `Ask the user (ask_user) which is correct. If they confirm the rule changed, retry ` +
          `memory_add with overrideConflicts: true — the old ${conflicts.length > 1 ? "entries will be" : "entry will be"} superseded ` +
          `(invalidated, with provenance) automatically.`,
      };
    }
    // Confirmed override — but verify the new entry is actually writable
    // BEFORE invalidating anything (Qodo #20, PR #916): superseding first
    // and then failing the topic-size cap would lose both the old and the
    // new rule.
    const entryLine = formatTopicLine(
      {
        text,
        category: category as MemoryCategory,
        pinned: isPinned,
        id: newEntryId(),
      },
      !!((input.trigger && input.action) || input.verifier),
    );
    const capRejection = topicCapRejection(cwd, category, entryLine);
    if (capRejection) return capRejection;
    // Supersede every conflicting entry so no contradiction remains
    for (const c of conflicts) {
      supersedeEntry(cwd, c.category, c.text);
    }
    if (!input.derivedFrom) {
      input.derivedFrom =
        `supersedes: [${conflict.category}] ${conflict.text}` +
        (conflicts.length > 1 ? ` (+${conflicts.length - 1} more)` : "");
    }
    log.info("memory_conflict_override", conflict.text.slice(0, 60), `count=${conflicts.length}`);
  }

  const canonicalLine = `- [${category}] ${text}`;
  const topicEntries = readAllTopicEntries(cwd);

  // 4a. Near-duplicate check via vector similarity (catches same lesson,
  // different wording) — reinforce instead of duplicating.
  try {
    const seen = new Set<string>();
    const sameCategoryEntries = topicEntries.filter((te) => {
      if (te.category !== category || seen.has(te.text)) return false;
      seen.add(te.text);
      return true;
    });
    await (await import("./memory-embeddings.js")).embedMissing(cwd, sameCategoryEntries);
    // Do NOT embed the new entry before searching — if the entry already exists
    // in sameCategoryEntries, it would match itself with similarity 1.000.
    const vectorMatches = await vectorSearch(cwd, text, sameCategoryEntries, 20);
    for (const vm of vectorMatches) {
      if (vm.similarity < getNearDuplicateThreshold(cwd)) continue;
      const existingLine = `- [${vm.category}] ${vm.text}`;
      if (reinforce(cwd, existingLine)) {
        reconcileScopeOnReinforce(cwd, existingLine, input);
        const merged = mergeEnforcementFields(cwd, existingLine, input);
        const enforcementNote = merged ? " (enforcement fields merged)" : "";
        const reinforcedWarning = reinforcedTriggerWarning(cwd, existingLine, input, triggerWarning);
        return {
          status: "reinforced",
          message:
            `Near-duplicate found (similarity: ${vm.similarity.toFixed(3)}) — reinforced instead: ` +
            `[${vm.category}] ${vm.text}${enforcementNote}${reinforcedWarning ? ` — ${reinforcedWarning}` : ""}`,
        };
      }
      // reinforce() failed (score entry missing) — try next candidate
    }
  } catch (err) {
    log.debug("memory-write: vector dedup skipped:", err);
  }

  // 4b. Exact match check (fast O(n) string comparison)
  for (const te of topicEntries) {
    if (te.text !== text || te.category !== category) continue;
    reinforce(cwd, canonicalLine);
    reconcileScopeOnReinforce(cwd, canonicalLine, input);
    const merged = mergeEnforcementFields(cwd, canonicalLine, input);
    const enforcementNote = merged ? " (enforcement fields merged)" : "";
    const reinforcedWarning = reinforcedTriggerWarning(cwd, canonicalLine, input, triggerWarning);
    return {
      status: "reinforced",
      message: `Already exists — reinforced instead: [${category}] ${text}${enforcementNote}${reinforcedWarning ? ` — ${reinforcedWarning}` : ""}`,
    };
  }

  // 5. Topic cap + write (cap precheck already ran in the override path;
  // this re-check is a race safety net — another writer may have appended)
  const topicName = CATEGORY_TO_TOPIC[category as MemoryCategory];
  const topicsDir = join(getProjectMemoryDir(cwd), "topics");
  const topicPath = join(topicsDir, `${topicName}.md`);

  if (!existsSync(topicsDir)) {
    mkdirSync(topicsDir, { recursive: true });
  }

  const isEnforced = !!((input.trigger && input.action) || input.verifier);
  const entryId = newEntryId();
  const entryLine = formatTopicLine(
    { text, category: category as MemoryCategory, pinned: isPinned, id: entryId },
    isEnforced,
  );

  const capRejection = topicCapRejection(cwd, category, entryLine);
  if (capRejection) return capRejection;
  const content = existsSync(topicPath) ? readFileSync(topicPath, "utf-8") : "";
  const newContent = (content || `# ${topicName.replace(/-/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase())}\n`).trimEnd() + "\n" + entryLine + "\n";
  writeFileSync(topicPath, newContent, "utf-8");
  invalidateTopicFileCache(topicPath);

  // Score entry — always hash the canonical line (no markers). Locked RMW
  // so concurrent sessions cannot clobber each other (issue #915).
  mutateScores(cwd, (scores) => {
    const hash = entryHash(canonicalLine);
    const entry: ScoredEntry = {
      class: category as MemoryCategory,
      score: isPinned ? PINNED_SCORE : 1.0,
      evidenceCount: 1,
      cue: "explicit",
      firstSeen: new Date().toISOString(),
      lastReinforced: new Date().toISOString(),
      userState: isPinned ? "pinned" : "auto",
      lifecycle: "active",
      id: entryId,
    };

    if (input.trigger) {
      entry.trigger = input.trigger as any;
      if (input.action) {
        if (input.action.startsWith("run_after ")) {
          entry.action = "run_after";
          entry.actionCommand = input.action.slice("run_after ".length);
        } else if (input.action === "block" || input.action === "warn") {
          entry.action = input.action;
        }
      }
    }
    if (input.verifier) entry.verifier = input.verifier;
    if (input.scope) {
      entry.scope = input.scope as MemoryScope;
      if (input.scope === "session" || input.scope === "task") {
        // Safety net: even if dream never runs, scoped entries expire. Task
        // scope has no task-end signal, so it gets the same TTL (Qodo #9,
        // PR #916) — without it, task-scoped entries behaved as durable
        // project memories.
        entry.expiresAt = new Date(Date.now() + SESSION_SCOPE_TTL_MS).toISOString();
      }
    }
    if (input.sourceSession) entry.sourceSession = input.sourceSession;
    if (input.derivedFrom) entry.derivedFrom = input.derivedFrom;
    if (input.informs && input.informs.length > 0) entry.informs = input.informs;

    scores.entries[hash] = entry;
  });

  // Embed the new entry for future similarity searches
  await embedEntry(cwd, text, category);

  log.info("memory_add_entry", category, text.slice(0, 60), input.scope ?? "project");
  const pin = isPinned ? " (pinned)" : "";
  const scope = input.scope && input.scope !== "project" ? ` (scope: ${input.scope})` : "";
  return {
    status: "added",
    message: `Added: [${category}] ${text}${pin}${scope}${triggerWarning ? ` — ${triggerWarning}` : ""}`,
  };
}

// ── Expiry pruning ─────────────────────────────────────────────────────────

/**
 * Remove entries whose expiresAt has passed: delete the topic line and the
 * score entry. Called from the periodic rebuild so session/task-scoped
 * entries cannot outlive their scope (issue #915).
 */
export function pruneExpiredEntries(cwd: string): number {
  const topicsDir = join(getProjectMemoryDir(cwd), "topics");
  if (!existsSync(topicsDir)) return 0;
  const scores = loadScores(cwd);
  const now = Date.now();
  let pruned = 0;

  const expiredHashes = new Set<string>();
  for (const [hash, entry] of Object.entries(scores.entries)) {
    if (entry.expiresAt && new Date(entry.expiresAt).getTime() < now) {
      expiredHashes.add(hash);
    }
  }
  if (expiredHashes.size === 0) return 0;

  // Remove expired lines from topic files (any category — we do not know
  // which topic file holds which text without scanning).
  for (const file of readdirSync(topicsDir).filter((f) => f.endsWith(".md"))) {
    const topicPath = join(topicsDir, file);
    const lines = readFileSync(topicPath, "utf-8").split("\n");
    const kept = lines.filter((l) => {
      const m = l.match(/^- \[(preference|lesson|pattern|decision|done|mistake)\] (.+)$/);
      if (!m) return true;
      const rawText = m[2]!.replace(/\s*\*\(pinned\)\*/g, "").replace(/\s*\*\(enforced\)\*/g, "").replace(/\s*\{#[0-9a-f]+\}$/g, "").trim();
      const hash = entryHash(`- [${m[1]}] ${rawText}`);
      if (!expiredHashes.has(hash)) return true;
      pruned++;
      return false;
    });
    const cleaned = kept.join("\n").replace(/\n{3,}/g, "\n\n");
    writeFileSync(topicPath, cleaned, "utf-8");
    invalidateTopicFileCache(topicPath);
  }

  // Locked removal of the expired score entries
  mutateScores(cwd, (s) => {
    for (const hash of expiredHashes) {
      delete s.entries[hash];
    }
  });
  if (pruned > 0) log.info("memory_prune_expired", pruned);
  return pruned;
}
