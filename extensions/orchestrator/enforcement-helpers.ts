/**
 * Pure helper functions for dangerous-command enforcement.
 * Extracted to allow testing without SDK dependencies.
 */

import { createLogger } from "../shared/logger.js";
import { realpathSync } from "node:fs";
import * as path from "node:path";
import { join } from "node:path";
import { DANGEROUS, executableText, getCurrentBranch, hasGitSub, segmentRunsGit, tokenize } from "./git-helpers.js";

const enfLog = createLogger("enforcement");
enfLog.debug("enforcement-helpers module loaded");

export type EnforcementResult = { block: true; reason: string } | { autofix: true; modifiedCommand: string; reason: string } | undefined;

/** Whether uv is available on this system (checked at session_start) */
let uvAvailable = true;
export function setUvAvailable(val: boolean): void { uvAvailable = val; }
export function isUvAvailable(): boolean { return uvAvailable; }

/** Normalize command for repeat detection: strip cd prefixes, trim whitespace */
export function normalizeForRepeatCheck(command: string): string {
  return command
    .replace(/^\s*cd\s+\S+\s*&&\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Escape a string for safe inclusion in double-quoted shell strings */
export function escapeForDoubleQuote(s: string): string {
  return s.replace(/[\\"`$!]/g, "\\$&");
}

/** Escape a string for safe inclusion in single-quoted shell strings */
export function escapeForSingleQuote(s: string): string {
  return s.replace(/'/g, "'\\\''");
}

/**
 * Detect whether a commit command already contains a trailer with the given
 * NAME (e.g. `Assisted-by:`). A commit message must only ever have ONE such
 * trailer, so we match by name — not by the full identity string — to avoid
 * appending a duplicate when the committer (e.g. git-expert) already added one
 * with a DIFFERENT model/identity string (or an unexpanded `$PI_MODEL`).
 *
 * The command embeds the message inside a quoted string where line breaks may
 * appear as REAL newline characters OR as the two-character escaped `\n`
 * sequence (echo -e / printf style). We therefore accept, immediately before
 * the trailer name: start-of-string, a real newline, a literal `\n` two-char
 * sequence, or a quote/whitespace character.
 */
export function commandHasTrailerByName(command: string, trailerName: string): boolean {
  const escName = trailerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // (^|\n real newline|\\n literal backslash-n|quote/space) + name + ":" + space
  const trailerNameRe = new RegExp(String.raw`(^|\n|\\n|["'\s])` + escName + String.raw`:\s`);
  const result = trailerNameRe.test(command);
  enfLog.debug("commandHasTrailerByName", trailerName, "match", result);
  return result;
}

/**
 * Split a command into segments on shell separators that are *outside* quotes,
 * recording each segment's offset, its parenthesis depth, and whether the
 * separator before it was `||` (so the segment may never run). Quoted text is
 * data, not syntax: a `(` or `cd` inside a string is part of an argument, never
 * a boundary.
 *
 * Depth and conditionality are what let the caller tell a `cd` that moves this
 * shell from one inside a subshell or behind a short-circuit, which change
 * nothing for a later command.
 */
interface ShellSegment {
  text: string;
  start: number;
  depth: number;
  conditional: boolean;
  /** `cmd &` runs the command in a subshell, so its cd does not move this shell. */
  backgrounded?: boolean;
}

function unquotedSegments(command: string): ShellSegment[] {
  const segments: ShellSegment[] = [];
  let start = 0;
  let quote: string | null = null;
  let depth = 0;
  let conditional = false;
  const push = (end: number, startAt: number, cond: boolean, backgrounded = false) => {
    segments.push({
      text: command.slice(startAt, end),
      start: startAt,
      depth,
      conditional: cond,
      ...(backgrounded ? { backgrounded: true } : {}),
    });
  };
  // The index of the first segment in the current `&&`/`||` chain. A trailing
  // `&` backgrounds the whole chain, not just the command beside it.
  let chainStart = 0;
  const chainLen = () => segments.length;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      // An unterminated quote cannot survive a line break in practice. Resolving
      // it here — rather than in the newline branch below, which this branch
      // never reaches while a quote is open — is what stops one stray
      // apostrophe from blinding the parser for every line that follows.
      else if (ch === "\n") {
        enfLog.debug("quote_reset_at_newline", "char", quote);
        quote = null;
      }
      continue;
    }
    if (ch === "\\" && command[i + 1]) {
      // An escaped character is part of a word: `weird\&name` is one directory
      // name, not a name followed by a background operator.
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    // A separator is a single "&&", "||", ";", "|", or newline; "(" and ")"
    // bracket a subshell but are not separators on their own.
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      push(i, start, conditional);
      // What FOLLOWS a short-circuit may be skipped: `false && cd x` never runs
      // it, and `cd a || cd b` runs the second only if the first failed.
      conditional = true;
      i++;
      start = i + 1;
    } else if (ch === "\n") {
      // An unterminated quote cannot survive a line break in practice; drop the
      // state so one stray apostrophe cannot blind the directory parser for the
      // rest of the command.
      if (quote) {
        enfLog.debug("quote_reset_at_newline", "char", quote);
        quote = null;
      }
      push(i, start, conditional);
      conditional = false;
      start = i + 1;
      chainStart = chainLen();
    } else if (ch === ";" || ch === "|") {
      push(i, start, conditional);
      conditional = false;
      start = i + 1;
      chainStart = chainLen();
    } else if (ch === "&") {
      // `2>&1` and `>&2` redirect; a lone `&` backgrounds the whole chain it
      // ends, so every segment of that chain runs in a subshell.
      const redirect = command[i - 1] === ">";
      if (redirect) continue;
      const isDouble = command[i + 1] === "&";
      push(i, start, conditional, !isDouble);
      if (!isDouble) {
        for (let s = chainStart; s < segments.length; s++) segments[s].backgrounded = true;
      }
      conditional = false;
      start = i + 1;
      chainStart = chainLen();
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      if (depth > 0) {
        // The closing paren ends the segment it belongs to; only what follows
        // it is back at the outer depth.
        push(i, start, false);
        depth--;
        start = i + 1;
        conditional = false;
      }
    }
  }
  push(command.length, start, conditional);
  enfLog.debug("shell_segments", "count", segments.length);
  return segments;
}

/** The target of a `cd` at the start of a segment, honouring quoting and `~`. */
function cdTargetIn(segment: string): string | null {
  // A cd may follow a shell keyword or a builtin wrapper: `if cd /repo; then …`,
  // `command cd /repo`.
  const m = /^\s*(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)|if\s+|then\s+|else\s+|elif\s+|do\s+|\(\s*|\{\s*)*(?:(?:command|builtin)\s+)*(cd|pushd|popd)\b\s*([\s\S]*)$/.exec(
    segment,
  );
  if (!m) {
    enfLog.debug("cd_target_absent", "segment_head", segment.trim().slice(0, 24));
    return null;
  }
  // `popd` returns to whatever `pushd` displaced, and takes no argument.
  if (m[1] === "popd") return "~popd";
  const args = m[2];
  // Walk the arguments: skip options, then read one destination — a quoted
  // target whole, so a directory name may contain spaces or parentheses.
  let i = 0;
  const skipSpace = () => { while (i < args.length && /\s/.test(args[i])) i++; };
  for (;;) {
    skipSpace();
    if (i >= args.length) break;
    if (args.startsWith("--", i)) { i += 2; continue; }
    // A lone `-` is the previous directory, not an option.
    if (args[i] === "-" && (i + 1 >= args.length || /\s/.test(args[i + 1]))) {
      enfLog.debug("cd_target_previous");
      return "-";
    }
    if (args[i] === "-" && i + 1 < args.length) {
      while (i < args.length && !/\s/.test(args[i])) i++;
      continue;
    }
    if (args[i] === "\\" && i + 1 < args.length) {
      i += 2;
      continue;
    }
    const quote = args[i];
    if (quote === "'" || quote === '"') {
      const end = args.indexOf(quote, i + 1);
      let target = end === -1 ? args.slice(i + 1) : args.slice(i + 1, end);
      i = end === -1 ? args.length : end + 1;
      // The shell concatenates adjacent parts into one word: `cd "work tree"x`
      // is `work treex`, so keep whatever follows the closing quote.
      while (i < args.length && !/[\s;&|)]/.test(args[i])) {
        target += args[i];
        i++;
      }
      enfLog.debug("cd_target_quoted", "target", target);
      return target;
    }
    let end = i;
    // An escaped character is part of the name: `weird\&name` is one directory.
    while (end < args.length && !/[\s;&|)]/.test(args[end])) {
      if (args[end] === "\\" && end + 1 < args.length) end++;
      end++;
    }
    const target = args.slice(i, end);
    enfLog.debug("cd_target", "target", target);
    return target || null;
  }
  // Bare `cd` goes home; `cd -` goes to the previous directory, which the
  // caller resolves against what it tracked.
  enfLog.debug("cd_target_default");
  return "~";
}

/** Apply one directory change to a running directory. */
function applyCd(dir: string, target: string, home = process.env.HOME ?? "~", fromShell = true): string {
  // `cd -` with no previous directory tracked leaves the shell where it is. Only
  // a shell's own `cd -` means that: a directory literally named `-`, reached as
  // `git -C-`, is an ordinary relative directory.
  if (target === "-" && fromShell) {
    enfLog.debug("apply_cd_previous_untracked", "dir", dir);
    return dir;
  }
  let next: string;
  // The shell builds one word from backslash escapes: `weird\&name` is a single
  // directory named `weird&name`, whatever else the name looks like.
  const word = target.replace(/\\(.)/g, "$1");
  if (word.startsWith("~/")) next = join(home, word.slice(2));
  else if (word === "~") next = home;
  else if (word.startsWith("/")) next = word;
  else next = join(dir, word);
  enfLog.debug("apply_cd", "from", dir, "target", target, "to", next);
  return next;
}

/**
 * Every `-C` directory override in a git segment, in order.
 *
 * Only git's *global* options count. `-C` after the subcommand is a different
 * flag entirely — `git commit -C <sha>` reuses that commit's message — so
 * reading it as a directory would send every git safety guard looking for a
 * directory named after a commit, and skip the checks. The walk therefore stops
 * at the first bare word, which is the subcommand.
 */
function gitCsIn(segment: string): string[] {
  const tokens = tokenize(segment);
  const start = tokens.findIndex((w) => w === "git");
  if (start === -1) return [];
  const values: string[] = [];
  for (let i = start + 1; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok.startsWith("-") || tok === "-") break;
    if (tok === "-C" || tok.startsWith("-C") && tok.length > 2) {
      const value = tok === "-C" ? tokens[i + 1] : tok.slice(2);
      if (value) values.push(value);
      if (tok === "-C") i++;
      continue;
    }
    // Any other option may take a separate value; skip it if the next word is one.
    if (!tok.includes("=") && tokens[i + 1] && !tokens[i + 1].startsWith("-")) i++;
  }
  if (values.length) enfLog.debug("git_C_options", "count", values.length, "last", values[values.length - 1]);
  return values;
}

/** Words that run whatever follows them, so an assignment behind one still counts. */
const WRAPPER_WORDS = new Set(["sudo", "command", "exec", "time", "nohup", "nice", "stdbuf", "setsid", "timeout"]);

/** env options whose value is a separate word. */
const ENV_VALUE_OPTIONS = new Set([
  "-u", "--unset", "-C", "--chdir", "-S", "--split-string", "-a", "--argv0",
  "--block-signal", "--default-signal", "--ignore-signal", "--debug",
]);

const GIT_INDEX_VARS = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]);
const GIT_INDEX_OPTIONS = new Set(["--git-dir", "--work-tree", "--namespace"]);

/**
 * Anything that points git at a repository other than the working directory: the
 * GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE environment variables, or the equivalent
 * long options. Their target is an index path, not a directory the walker can
 * enumerate, so the caller refuses rather than checks the wrong places.
 *
 * Position matters. An environment variable only selects the index in *assignment
 * position* — `GIT_DIR=/x git add a.txt`, optionally through `env` — so
 * `git add GIT_INDEX_FILE=notes` stages a file with that name. The long options
 * only count in git's global option region, before the subcommand, so
 * `git add -- --work-tree=x` is a filename too.
 */
function gitIndexOverride(command: string): string | null {
  const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/;
  for (const seg of unquotedSegments(command)) {
    const tokens = tokenize(seg.text);
    const nameOf = (tok: string) => tok.split("=")[0];
    let i = 0;
    // `export GIT_INDEX_FILE=/x` sets it for later commands in the same shell,
    // so it points git at another index just as an inline assignment does. This
    // segment does not run git itself, so it is checked before that requirement.
    if (tokens[i] === "export") {
      i++;
      while (i < tokens.length) {
        const name = nameOf(tokens[i]);
        if (GIT_INDEX_VARS.has(name)) {
          enfLog.warn("git_index_override", "source", name, "via", "export");
          return name;
        }
        i++;
      }
      continue;
    }
    // `echo GIT_INDEX_FILE=/x` only prints the name. An override is something
    // git is actually run with, so the segment has to run git for it to count.
    if (!segmentRunsGit(seg.text)) continue;
    // Leading `VAR=value` assignments, then the same again after `env`. A
    // wrapper that runs the rest — `sudo`, `command`, `exec`, `time` — sits in
    // front of both, and can be chained.
    for (let round = 0; round < 4; round++) {
      while (i < tokens.length && WRAPPER_WORDS.has(tokens[i])) i++;
      while (i < tokens.length && assignment.test(tokens[i])) {
        const name = nameOf(tokens[i]);
        if (GIT_INDEX_VARS.has(name)) {
          enfLog.warn("git_index_override", "source", name);
          return name;
        }
        i++;
      }
      if (tokens[i] !== "env") break;
      i++;
      // env's own options: only these take a separate value, and that value must
      // not be read as an assignment or as the command. `-i` takes none, so
      // treating every option as value-taking would swallow the assignment after it.
      while (i < tokens.length && tokens[i].startsWith("-") && tokens[i] !== "-") {
        const opt = tokens[i].split("=")[0];
        if (!tokens[i].includes("=") && ENV_VALUE_OPTIONS.has(opt)) i++;
        i++;
      }
    }
    const g = tokens.indexOf("git");
    if (g === -1) continue;
    for (let k = g + 1; k < tokens.length; k++) {
      const tok = tokens[k];
      if (!tok.startsWith("-") || tok === "-") break;
      const name = nameOf(tok);
      if (GIT_INDEX_OPTIONS.has(name)) {
        enfLog.warn("git_index_override", "source", name);
        return name;
      }
      if (!tok.includes("=") && tokens[k + 1] && !tokens[k + 1].startsWith("-")) k++;
    }
  }
  return null;
}

/**
 * Every directory the command could plausibly run git in.
 *
 * Candidates come from where git actually runs: the directory in effect at each
 * git invocation, plus every `-C` resolved in order from that directory (git
 * applies them one after another), plus any directory a `cd` reached only
 * conditionally. Each subshell gets its own directory stack, because a `cd`
 * inside one cannot move the outer shell — which is also why a `cd` in a
 * subshell contributes a candidate without becoming the running directory.
 *
 * When an environment variable selects the index, the target is unknowable and
 * `envOverride` says so, so the caller can refuse instead of guess.
 */
export function conflictCandidateDirs(
  command: string,
  sessionCwd: string,
): { all: string[]; envOverride: string | null; dynamicPath: string | null } {
  const envOverride = gitIndexOverride(command);
  // A path the shell expands at run time — `$DIR`, `$(pwd)`, a glob — cannot be
  // checked here, so it is reported rather than resolved to a literal. A glob
  // character the command escaped is part of the name, not a pattern.
  const dynamic = (p: string) => /[$*?{]/.test(p.replace(/\\./g, ""));
  let dynamicPath: string | null = null;
  const dirs = new Set<string>();
  // running[d] is the directory of the shell at paren depth d.
  const running: string[] = [sessionCwd];
  // OLDPWD: where the shell was before the last change, which is what `cd -`
  // returns to. Each depth has its own, and each starts where the shell did —
  // the shell's own PWD, not just the directory we were invoked from.
  const startPwd = process.env.PWD && process.env.PWD.startsWith("/") ? process.env.PWD : sessionCwd;
  const previous: string[] = [startPwd];
  // What `pushd` displaced, per depth, for `popd` to return to.
  const pushed: string[][] = [[]];
  // `HOME=/x git add a.txt` sends a bare `cd` and a `~` somewhere else, so the
  // command's own assignment wins over this process's environment.
  let home = process.env.HOME ?? "~";
  // Walk the *executable* text: a `cd` inside a `bash -c` script, or inside a
  // command substitution, moves the directory the staging really runs in.
  const scan = executableText(command) || command;

  for (const seg of unquotedSegments(scan)) {
    // Leaving a subshell discards its directory, and entering a new one starts
    // from the outer shell again — otherwise `(cd clean); (git add x)` would
    // inherit `clean` for the second subshell.
    if (running.length > seg.depth + 1) running.length = seg.depth + 1;
    while (running.length <= seg.depth) running.push(running[running.length - 1]);
    while (previous.length <= seg.depth) previous.push(previous[previous.length - 1]);
    while (pushed.length <= seg.depth) pushed.push([]);
    const assigned = /(?:^|[\s;&|(])HOME=(\S*)/.exec(seg.text);
    if (assigned) home = assigned[1];
    const target = cdTargetIn(seg.text);
    if (target) {
      if (seg.conditional || seg.backgrounded) {
        // Behind a short-circuit the cd may never run, and a backgrounded cd
        // runs in its own subshell — so in both cases the directory the shell is
        // in *before* it is where a later command actually stages.
        dirs.add(running[seg.depth]);
      }
      const from = running[seg.depth];
      // `cd -` goes to OLDPWD as it stands *before* this change, and only then
      // does the previous directory become where we are now.
      let to: string;
      if (target === "-") to = previous[seg.depth];
      else if (target === "~popd") {
        const stack = pushed[seg.depth];
        to = stack.length ? stack.pop()! : from;
      } else {
        to = applyCd(from, target, home);
        // A bare `pushd` pushes where we are and goes home, the same as a bare
        // `cd`; a `cd` leaves the push stack alone.
        if (/\bpushd\b/.test(seg.text) && !/^\s*(?:if\s+|then\s+|else\s+|elif\s+|do\s+|\(\s*|\{\s*)*pushd\s+\S/.test(seg.text)) {
          pushed[seg.depth].push(from);
        }
      }
      if (seg.backgrounded) {
        // The subshell moves; this shell does not.
        dirs.add(to);
      } else {
        previous[seg.depth] = from;
        running[seg.depth] = to;
      }
      // A directory change that certainly runs, to a literal path, settles where
      // the shell is: an earlier unverifiable one no longer matters.
      if (!dynamic(target) && !seg.conditional && !seg.backgrounded) dynamicPath = null;
      else if (dynamic(target) && !dynamicPath) dynamicPath = target;
    }
    if (segmentRunsGit(seg.text)) {
      let base = running[seg.depth];
      // `env -C dir git add x` moves git into dir without a shell cd.
      const envChdir = /^\s*(?:VAR=\S*\s*)*env\s+(?:-\S+\s+)*?(?:-C|--chdir)(?:[=\s]+)(\S+)/.exec(seg.text);
      if (envChdir) base = applyCd(base, envChdir[1], home);
      dirs.add(base);
      // Git applies each -C in turn, each relative to the previous one.
      let cursor = base;
      for (const c of gitCsIn(seg.text)) {
        if (dynamic(c) && !dynamicPath) dynamicPath = c;
        // A directory literally named `-` is ordinary; only the shell's own
        // `cd -` means the previous directory.
        cursor = applyCd(cursor, c, home, false);
        dirs.add(cursor);
      }
    }
  }
  const all = [...dirs];
  enfLog.debug("conflict_candidate_dirs", "count", all.length, "env_override", envOverride ?? "none", "dynamic_path", dynamicPath ?? "none");
  return { all, envOverride, dynamicPath };
}

/** Parse bash command for cd target to resolve the effective working directory (worktree support) */
export function resolveEffectiveCwd(command: string, sessionCwd: string): string {
  // Quoting decides what is syntax, so segments are split outside quotes first.
  // Then the LAST cd before the git invocation, applied in shell order so a
  // chain of relative cds composes. Two cases make the obvious implementations
  // wrong:
  //   (cd clean && cd conflicted && git add x)  → the later cd wins
  //   cd /repo && git commit && cd /tmp          → a trailing cd must not
  // With no git invocation to anchor to, the first cd is used, which is the
  // conservative answer for `cd a && cd b && pytest`.
  //
  // A command that can run git in more than one directory (a conditional branch,
  // a completed subshell, several invocations) has no single answer here. That
  // is why conflict enforcement asks conflictCandidateDirs instead of trusting
  // this function's guess.
  const segments = unquotedSegments(command);
  // A segment only counts when it *runs* git: `cd ~/git/proj` merely contains
  // the word, and anchoring on it would drop a real directory change.
  const gitIndex = segments.findIndex((s) => segmentRunsGit(s.text));
  // Only a cd that moves *this* shell counts. A cd inside a subshell, or one
  // behind a short-circuit, runs somewhere else or may not run at all, so
  // applying it sent the guards looking at a directory the shell never entered —
  // `(cd /tmp) && git commit` read /tmp settings, where enforcement is off.
  const targetDepth = gitIndex === -1 ? 0 : segments[gitIndex].depth;
  const running: string[] = [sessionCwd];
  const applied: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    // A trailing cd after the git command did not happen yet.
    if (i === gitIndex) break;
    const seg = segments[i];
    if (seg.depth > targetDepth) break;
    while (running.length <= seg.depth) running.push(running[running.length - 1]);
    const target = cdTargetIn(seg.text);
    if (!target || target === "~popd") continue;
    // A subshell at a different depth cannot move this shell. Note that a cd
    // behind a short-circuit still counts: `cd a && cd b` really does leave the
    // shell in b, and `if cd x; then` leaves it in x too.
    if (seg.depth !== targetDepth) continue;
    running[targetDepth] = applyCd(running[targetDepth], target);
    applied.push(target);
    // With no git invocation to anchor to, the first cd is the conservative
    // answer for `cd a && cd b && pytest`.
    if (gitIndex === -1) break;
  }
  let dir = running[targetDepth];
  // Git applies each -C in turn, each relative to the previous one, so
  // `git -C worktree -C nested` lands in worktree/nested.
  const cTargets = gitIndex === -1 ? [] : gitCsIn(segments[gitIndex].text);
  for (const cTarget of cTargets) dir = applyCd(dir, cTarget, process.env.HOME ?? "~", false);
  enfLog.debug("effective_cwd", "dir", dir, "source", cTargets.length ? "git_C" : applied.length ? "cd" : "session", "cds", applied.length);
  return dir;
}

/** Auto-fix direct python commands (prepend uv run), block pip commands */
export function checkPythonPipBlock(command: string, cmdLower: string): EnforcementResult {
  // If uv is not available, skip all python/pip enforcement
  if (!uvAvailable) return undefined;

  if (!cmdLower.startsWith("uv ") && !cmdLower.startsWith("uvx ")) {
    // Use matchAll to find separator positions, then extract segments with their offsets
    const separatorRe = /\n|;|&&|\|\||\||&/g;
    const segments: { start: number; end: number; text: string; textLower: string }[] = [];
    let lastEnd = 0;

    for (const m of command.matchAll(separatorRe)) {
      const segText = command.slice(lastEnd, m.index);
      segments.push({
        start: lastEnd,
        end: m.index!,
        text: segText.trim(),
        textLower: segText.trim().toLowerCase(),
      });
      lastEnd = m.index! + m[0].length;
    }
    const lastSegText = command.slice(lastEnd);
    segments.push({
      start: lastEnd,
      end: command.length,
      text: lastSegText.trim(),
      textLower: lastSegText.trim().toLowerCase(),
    });

    const envVarPrefixRe = /^\s*(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+)*/;

    // Pass 1: if ANY segment is pip/pip3, block the entire command
    for (const seg of segments) {
      if (!seg.textLower) continue;
      const strippedLower = seg.textLower.replace(envVarPrefixRe, "");
      // Extract first token — handle quoted paths: "path/to/python3" or 'path/to/python3'
      const firstTokenMatch = strippedLower.match(/^(["'])(.+?)\1|^(\S+)/);
      const firstToken = firstTokenMatch?.[2] || firstTokenMatch?.[3] || "";
      const baseCmd = firstToken.replace(/^.*[\/\\]/, "");
      if (baseCmd && /^pip3?$/.test(baseCmd)) {
        return {
          block: true,
          reason: "Direct pip/pip3 forbidden. Use: uv add <pkg> / uvx <tool> / uv run --with <pkg> script.py",
        };
      }
    }

    // Pass 2: rewrite ALL python/python3 segments
    let modifiedCommand = command;
    let anyRewrite = false;
    // Process segments in reverse order so offsets remain valid after each splice
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i];
      if (!seg.textLower) continue;
      const strippedLower = seg.textLower.replace(envVarPrefixRe, "");
      // Extract first token — handle quoted paths: "path/to/python3" or 'path/to/python3'
      const firstTokenMatch = strippedLower.match(/^(["'])(.+?)\1|^(\S+)/);
      const firstToken = firstTokenMatch?.[2] || firstTokenMatch?.[3] || "";
      const baseCmd = firstToken.replace(/^.*[\/\\]/, "");

      if (baseCmd && /^python3?$/.test(baseCmd)) {
        const origText = seg.text;
        const envVarMatch = origText.match(envVarPrefixRe);
        const envPrefix = envVarMatch?.[0] || "";
        const afterEnv = origText.slice(envPrefix.length);
        // Match quoted or unquoted python executable path
        let origExe: string;
        let fixedAfterEnv: string;
        if (afterEnv.match(/^["']/)) {
          // Quoted path: strip quotes and path, keep original exe name
          const qm = afterEnv.match(/^(["'])(.*?)(python3?)\1(.*)/i);
          origExe = qm?.[3] || baseCmd;
          fixedAfterEnv = `uv run ${origExe}` + (qm?.[4] || "");
        } else {
          origExe = afterEnv.match(/^(\S*[\/\\])?(python3?)\b/i)?.[2] || baseCmd;
          fixedAfterEnv = afterEnv.replace(/^(\S*[\/\\])?python3?\b/i, `uv run ${origExe}`);
        }
        const fixedStmt = envPrefix + fixedAfterEnv;

        // Replace by offset
        const rawSegment = modifiedCommand.slice(seg.start, seg.end);
        const trimStart = rawSegment.indexOf(seg.text);
        const absStart = seg.start + (trimStart >= 0 ? trimStart : 0);
        const absEnd = absStart + seg.text.length;
        modifiedCommand = modifiedCommand.slice(0, absStart) + fixedStmt + modifiedCommand.slice(absEnd);
        anyRewrite = true;
      }
    }

    if (anyRewrite) {
      return {
        autofix: true,
        modifiedCommand,
        reason: "Auto-fixed: prepended `uv run` to python command",
      };
    }
  }
  return undefined;
}

/** Block remote script execution (pipe to shell, process substitution, command substitution/eval) */
export function checkRemoteExecBlock(cmdLower: string): EnforcementResult {
  const cmdForExecCheck = cmdLower.replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*/m, "");
  const remoteExecReason = "\u26d4 Remote script execution is forbidden. Download the script first, audit it with security-auditor, then run if safe.";
  if (/\b(curl|wget)\b.*\|(?!\|)\s*(?:sudo\s+(?:-\S+\s+)*|env\s+(?:-\S+\s+)*|uv\s+run\s+)*(?:\/\S+\/)*(ba|c|da|[akz]|fi|tc)?sh\b/.test(cmdForExecCheck) ||
      /\b(curl|wget)\b.*\|(?!\|)\s*(?:sudo\s+(?:-\S+\s+)*|env\s+(?:-\S+\s+)*|uv\s+run\s+)*(?:\/\S+\/)*(python[23]?|perl|ruby|node|deno|bun)\b/.test(cmdForExecCheck)) {
    enfLog.debug("remote_exec_block", "pipe");
    return { block: true, reason: remoteExecReason };
  }
  // Match curl/wget anywhere inside process substitution <(...), not just as first token
  // Allow quoted strings to handle quoted ) characters inside <(...)
  if (/\b(?:(?:ba|c|da|[akz]|fi|tc)?sh|python[23]?|perl|ruby|node|deno|bun)\b.*<\((?:"[^"]*"|'[^']*'|[^)"'])*\b(curl|wget)\b/.test(cmdForExecCheck) ||
      /\bsource\s+<\((?:"[^"]*"|'[^']*'|[^)"'])*\b(curl|wget)\b/.test(cmdForExecCheck) ||
      /(?:^|[\s;&|])\.\s+<\((?:"[^"]*"|'[^']*'|[^)"'])*\b(curl|wget)\b/.test(cmdForExecCheck)) {
    enfLog.debug("remote_exec_block", "proc-sub");
    return { block: true, reason: remoteExecReason };
  }
  // Block when curl/wget is inside a command substitution AND an execution primitive
  // (eval, bash -c, sh -c, etc.) CONSUMES that curl output — either inline
  // ($(curl ...)/`curl ...` passed directly to the primitive) or via a variable
  // that was assigned from curl.
  //
  // FALSE-POSITIVE FIX: A SAFE capture `VAR=$(curl ...)` at a statement boundary,
  // followed by an UNRELATED exec primitive that does NOT reference that variable,
  // is not a remote exec. Example (now ALLOWED):
  //   code=$(curl -s -w "%{http_code}" https://x/json); python3 -c "import json"
  // Here $code never flows into python3, so there is no remote code execution.
  //
  // To avoid opening a bypass we:
  //   1. Record the set of variable names assigned from curl/wget captures.
  //   2. Strip SAFE curl assignments before the inline-substitution exec check, so a
  //      captured-but-unused curl output no longer counts as "curl feeding an exec".
  //   3. Separately block when an exec primitive REFERENCES a curl-assigned variable
  //      (e.g. x=$(curl ...); eval "$x") — stripping alone would miss this.
  //
  // Allow quoted strings inside $() to handle quoted ) characters. Matching curl/wget
  // as a word anywhere inside the substitution is intentional — it trades rare false
  // positives for stronger security against obfuscated curl invocations.
  //
  // Safe-assignment shape: VAR=$(...) / VAR=`...` at a statement boundary, terminated
  // by a statement separator / comment / end. CRITICAL: the captured value must NOT
  // itself contain a NESTED command substitution ($( or backtick) — even inside quotes.
  // Otherwise `var=$(bash -c "$(curl ...)")` (a REAL remote exec) would be treated as a
  // simple safe capture and stripped, opening a bypass. Quoted branches therefore
  // forbid `$(` and backtick, and the unquoted branch forbids them too.
  const qDouble = /"(?:(?!\$\()[^"`])*"/.source;
  const qSingle = /'(?:(?!\$\()[^'`])*'/.source;
  const dollarSub = String.raw`\$\((?:` + qDouble + `|` + qSingle + String.raw`|(?!\$\()(?!` + "`" + String.raw`)[^)])*\)`;
  const backtickSub = "`(?:(?!\\$\\()[^`])*`";
  const captureValue = `(?:${dollarSub}|${backtickSub})`;
  const safeAssignmentSrc =
    String.raw`(?:^|(?<=[;&|\n({])\s*)(?:export\s+|declare\s+|local\s+|readonly\s+|typeset\s+)?([a-z_]\w*)=(` +
    captureValue + String.raw`)(?=\s*(?:$|[;&|#\n)}]))`;
  // Collect variable names whose SAFE assignment substitution contains curl/wget.
  const curlVars = new Set<string>();
  for (const m of cmdForExecCheck.matchAll(new RegExp(safeAssignmentSrc, "gi"))) {
    if (/\b(curl|wget)\b/.test(m[2])) curlVars.add(m[1]);
  }
  // Strip ALL safe assignments (curl or not) for the inline-substitution exec check,
  // so a curl output safely captured into a variable no longer counts as an inline
  // substitution feeding an exec primitive.
  const strippedForSub = cmdForExecCheck.replace(new RegExp(safeAssignmentSrc, "gi"), " ");
  // Curl still inside a substitution AFTER stripping safe captures = inline/consumed curl.
  const hasCurlSub = /\$\((?:"[^"]*"|'[^']*'|[^)"'])*\b(curl|wget)\b/.test(strippedForSub) || /`[^`]*\b(curl|wget)\b/.test(strippedForSub);
  // Anchor exec primitives to command position (start-of-string or after statement separator)
  // to avoid matching inside URLs/arguments (e.g., https://host/eval)
  if (hasCurlSub || curlVars.size > 0) {
    // Allow assignment prefixes (VAR=val, VAR="a b"), sudo, and env before exec primitives.
    // Shell allows VAR="a b" bash -c "cmd" — the assignment sets env for the command.
    const assignPrefix = /(?:[a-z_]\w*=(?:"[^"]*"|'[^']*'|\S+)\s+)*/.source;
    // Include (, {, $( as command-start boundaries for subshells/grouping/command substitution.
    // Use quoted-value-capable env prefix to handle env FOO="a b" bash -c ...
    // Include shell control-flow keywords (then, do, else, elif) as command boundaries
    const cmdPos = /(?:^|[;&|\n({]|&&|\|\||\$\(|\bthen\b|\bdo\b|\belse\b|\belif\b)\s*/.source + assignPrefix + /(?:sudo\s+(?:-\S+\s+)*|env\s+(?:-\S+\s+)*)*/.source + assignPrefix;
    // Allow optional path prefix (/bin/, /usr/bin/, etc.) before shell/interpreter names
    // Allow leading redirections (>file, 2>/dev/null, etc.), shell wrappers (command, builtin, exec)
    const redirections = /(?:(?:[0-9]*>[>&]?|<)\s*\S+\s+)*/.source;
    const pathPrefix = /(?:\/\S+\/)*/.source;
    // Wrappers/prefixes that may precede the interpreter name at a command position:
    // command/builtin/exec shell builtins, and `uv run` (the test harness rewrites
    // `python3` -> `uv run python3`, so `uv run python3 -c "$x"` must also be detected).
    const wrappers = /(?:(?:command|builtin|exec)\s+|uv\s+run\s+)*/.source;
    const execPrefix = cmdPos + redirections + wrappers;
    // Exec-primitive cores (shell/interpreter with a code-carrying flag or stdin/procsub).
    const shellExec = /(?:ba|c|da|[akz]|fi|tc)?sh(?:\s+-c\b|\s+<<<|\s+<[^<])/.source;
    const interpExec = /(?:python[23]?|perl|ruby|node|deno|bun)(?:\s+-[ce]\b|\s+<\()/.source;
    // (a)/(b) INLINE: curl substitution survives safe-assignment stripping AND an exec
    // primitive appears at command position — the curl output feeds the primitive.
    // Match shells with -c flag, stdin (<<<, <), or process substitution <(...)
    // Match interpreters with -c/-e flag or process substitution <(...)
    if (hasCurlSub && (
        new RegExp(execPrefix + /eval(?:\s|$)/.source).test(cmdForExecCheck) ||
        new RegExp(execPrefix + pathPrefix + shellExec).test(cmdForExecCheck) ||
        new RegExp(execPrefix + pathPrefix + interpExec).test(cmdForExecCheck))) {
      enfLog.debug("remote_exec_block", "inline-sub");
      return { block: true, reason: remoteExecReason };
    }
    // (c) CONSERVATIVE VARIABLE-FLOW (SECURITY HARDENING): the previous logic only
    // tracked the DIRECT curl-assigned variable name and was bypassable via aliasing
    // (`x=$(curl); y=$x; bash -c "$y"`), quoted aliasing (`y="$x"; eval "$y"`), and
    // indirect expansion (`bash -c "${!x}"`). We cannot statically track how curl output
    // flows through arbitrary variable aliases/indirection, so we take the conservative
    // direction: once curl output has been CAPTURED into the shell (curlVars.size > 0),
    // ANY exec primitive whose command/argument region references ANY shell variable
    // (contains a `$` — `$x`, `${x}`, `${!x}`, `"$x"`, ...) is assumed to potentially
    // carry the curl output and is BLOCKED. Only an exec whose argument region contains
    // NO `$` at all (e.g. `python3 -c "import json"`) is allowed to pass this rule.
    if (curlVars.size > 0) {
      // Argument/target region after the primitive, within the same statement (stops at
      // ; & | newline), that contains at least one `$` variable reference.
      const dollarArg = /[^\n;&|]*\$/.source;
      if (new RegExp(execPrefix + /eval\b/.source + dollarArg).test(cmdForExecCheck) ||
          new RegExp(execPrefix + pathPrefix + shellExec + dollarArg).test(cmdForExecCheck) ||
          new RegExp(execPrefix + pathPrefix + interpExec + dollarArg).test(cmdForExecCheck)) {
        enfLog.debug("remote_exec_block", "var-flow");
        return { block: true, reason: remoteExecReason };
      }
      // (d) UNTRACKABLE INPUT: when a curl capture exists, a shell/interpreter that reads
      // its program from stdin / a file / process-substitution / here-string is blocked
      // regardless of variable reference — the curl output could have been redirected to a
      // file that is then executed, which cannot be tracked statically. This is the
      // conservative direction: only the inline `-c`/`-e` form (which needs an explicit
      // `$` reference to consume curl output, handled by (c)) is allowed to pass through.
      const shellStdin = /(?:ba|c|da|[akz]|fi|tc)?sh(?:\s+<<<|\s+<[^<]|\s+<\()/.source;
      const interpStdin = /(?:python[23]?|perl|ruby|node|deno|bun)\s+<\(/.source;
      if (new RegExp(execPrefix + pathPrefix + shellStdin).test(cmdForExecCheck) ||
          new RegExp(execPrefix + pathPrefix + interpStdin).test(cmdForExecCheck)) {
        enfLog.debug("remote_exec_block", "untrackable");
        return { block: true, reason: remoteExecReason };
      }
    }
  }
  // Block $(curl ...) and `curl ...` UNLESS every occurrence is a safe shell variable assignment.
  // Safe: VAR=$(curl ...), export VAR=$(curl ...) — only when followed by ; && || or end-of-string
  // Unsafe: bare $(curl), --flag=$(curl), VAR=$(curl ...) cmd (prefix assignment runs cmd)
  if (/\$\(\s*\b(curl|wget)\b/.test(cmdForExecCheck) || /`\s*\b(curl|wget)\b/.test(cmdForExecCheck)) {
    // Block env VAR=$(curl ...) cmd — env runs a command with the var, so curl output could influence execution
    // Note: [a-z_] without /i is fine — cmdLower (the parameter) is already lowercased
    if (/\benv\s+.*[a-z_]\w*=(?:\$\(|`).*\b(curl|wget)\b/.test(cmdForExecCheck)) {
      enfLog.debug("remote_exec_block", "env-var-sub");
      return { block: true, reason: remoteExecReason };
    }
    // Strip safe assignment patterns at statement boundaries only.
    // Left boundary: start-of-string or after a statement separator (;, &&, ||, |, &, newline).
    // Right boundary: followed by statement separator, newline, # comment, or end-of-string.
    // This prevents stripping argument-position assignments like echo x=$(curl ...)
    // and prefix assignments like VAR=$(curl ...) cmd.
    // Use negative lookahead to reject nested command substitution (both $( and backticks) inside $() content.
    // Also reject backticks inside $() to prevent var=$(bash -c "`curl ...`") bypass.
    // Allow quoted strings ("..." and '...') inside $() to handle quoted ) characters.
    // Left boundary includes (, { for subshell/brace-group starts. Right boundary includes ), } as terminators.
    const safeAssignment = /(?:^|(?<=[;&|\n({])\s*)(?:export\s+|declare\s+|local\s+|readonly\s+|typeset\s+)?[a-z_]\w*=(?:\$\((?:"[^"]*"|'[^']*'|(?!\$\()(?!`)[^)])*\)|`(?:(?!\$\()[^`])*`)(?=\s*(?:$|[;&|#\n)}]))/gi;
    const stripped = cmdForExecCheck.replace(safeAssignment, " ");
    if (/\$\(\s*\b(curl|wget)\b/.test(stripped) || /`\s*\b(curl|wget)\b/.test(stripped)) {
      enfLog.debug("remote_exec_block", "bare-sub");
      return { block: true, reason: remoteExecReason };
    }
  }
  return undefined;
}

/** Enforce temp files go to .pi/tmp/ — not bare /tmp/ */
export function checkTempFileEnforcement(command: string, cwd: string): EnforcementResult {
  if (/(?:^|[;&|$( \t])mktemp\b/.test(command)) {
    const expectedTmpDir = path.join(cwd, ".pi", "tmp");
    const usesEnvVar = /\$\{?PROJECT_TMP_DIR\}?/.test(command);
    const usesExpectedPath = command.includes(expectedTmpDir);
    const usesRelativePath = /(?:^|[\s"'=])\.pi\/tmp(?:\/|[\s"']|$)/.test(command);
    if (!usesEnvVar && !usesExpectedPath && !usesRelativePath) {
      return {
        block: true,
        reason: `\u26d4 mktemp must use project temp dir. Use: mktemp \${PROJECT_TMP_DIR}/XXXXXX (resolves to ${expectedTmpDir}/)`,
      };
    }
  }
  return undefined;
}

/**
 * Read-only commands that cannot modify the filesystem.
 * Intentionally conservative — commands like `sort`, `diff`, `ls` are excluded
 * to keep the allow-list tight and reduce attack surface.
 */
export const READ_ONLY_COMMANDS = new Set([
  "grep", "egrep", "fgrep", "rg", "ag", "ack",
  "cat", "head", "tail", "less", "more", "wc",
  "echo", "printf",
]);

/**
 * Extract command substitutions ($(...), `...`) and process substitutions
 * (<(...), >(...)) from a statement, respecting single quotes (which
 * suppress expansion in bash). Returns the extracted command strings.
 */
export function extractSubshells(stmt: string): string[] {
  const results: string[] = [];

  // Strip single-quoted regions — POSIX sh has no escape inside single quotes, so [^']* is correct
  const withoutSingleQuoted = stmt.replace(/'[^']*'/g, "''");

  // Extract $(...) — handle nested parens by counting depth
  let i = 0;
  while (i < withoutSingleQuoted.length) {
    // $( or <( or >(
    if (i < withoutSingleQuoted.length - 1 &&
        ((withoutSingleQuoted[i] === "$" && withoutSingleQuoted[i + 1] === "(") ||
         (withoutSingleQuoted[i] === "<" && withoutSingleQuoted[i + 1] === "(") ||
         (withoutSingleQuoted[i] === ">" && withoutSingleQuoted[i + 1] === "("))) {
      const start = i + 2;
      let depth = 1;
      let j = start;
      while (j < withoutSingleQuoted.length && depth > 0) {
        if (withoutSingleQuoted[j] === "(") depth++;
        else if (withoutSingleQuoted[j] === ")") depth--;
        j++;
      }
      if (depth === 0) {
        results.push(withoutSingleQuoted.slice(start, j - 1));
      }
      i = j;
      continue;
    }
    // Backtick substitution — skip escaped backticks (\`)
    if (withoutSingleQuoted[i] === "`") {
      let j = i + 1;
      while (j < withoutSingleQuoted.length) {
        if (withoutSingleQuoted[j] === "\\" && j + 1 < withoutSingleQuoted.length) {
          j += 2; // skip escaped character
          continue;
        }
        if (withoutSingleQuoted[j] === "`") break;
        j++;
      }
      if (j < withoutSingleQuoted.length) {
        results.push(withoutSingleQuoted.slice(i + 1, j));
        i = j + 1;
        continue;
      }
    }
    i++;
  }
  return results;
}

/**
 * Check if a statement is a read-only command with no dangerous subshells.
 * Returns true if the DANGEROUS check should be skipped for this statement.
 */
export function isReadOnlyStatement(stmt: string): boolean {
  // Extract the base command (first word, strip any leading env vars like VAR=val)
  const stripped = stmt.replace(/^\s*(?:\S+=\S*\s+)*/, "");
  const baseCmd = stripped.split(/\s/)[0]?.replace(/^.*\//, ""); // strip path prefix
  if (!baseCmd || !READ_ONLY_COMMANDS.has(baseCmd)) return false;

  // Check subshells for dangerous content
  const subshells = extractSubshells(stmt);
  // Evaluate extracted content against DANGEROUS as raw strings — catches nested subshells too
  return !subshells.some((sub) => DANGEROUS.some((p) => p.test(sub)));
}

/** Pattern matching direct recursive rm commands (subset of DANGEROUS patterns). */
const RM_PATTERN = /\brm\s+(?:-[a-zA-Z]+\s+)*(-[a-zA-Z]*r[a-zA-Z]*|--recursive)/i;

/**
 * Check if a dangerous rm command only targets paths within .pi/tmp/ or /tmp/<something>.
 * Returns true if the command should be silently allowed.
 * Note: bare /tmp (without subpath) is NOT allowed — only /tmp/<file-or-folder>.
 */
export function isRmInProjectTmp(stmt: string, cwd: string): boolean {
  // Only applies to direct rm commands, not find/xargs variants
  if (!RM_PATTERN.test(stmt)) return false;

  // Ensure rm is the actual command, not an argument to another command (e.g., xargs rm)
  const firstWord = stmt.trim().split(/\s+/)[0];
  if (firstWord !== "rm" && !firstWord?.endsWith("/rm")) return false;

  // Don't silently allow if the statement also matches other DANGEROUS patterns
  // (e.g., sudo rm -rf .pi/tmp/foo — sudo should still trigger confirmation)
  if (/\bsudo\b/i.test(stmt)) return false;

  // Reject statements containing subshells or process substitutions — these could
  // embed arbitrary commands that bypass the allowlist check
  if (extractSubshells(stmt).length > 0) return false;

  // Parse arguments: split on whitespace, skip flags, handle -- separator
  const tokens = stmt.trim().split(/\s+/);
  const paths: string[] = [];
  let pastSeparator = false;
  let pastRm = false;
  let skipNext = false;

  for (const token of tokens) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (!pastRm) {
      if (token === "rm" || token.endsWith("/rm")) pastRm = true;
      continue;
    }
    if (token === "--") {
      pastSeparator = true;
      continue;
    }
    if (!pastSeparator && token.startsWith("-")) continue;
    // Skip shell redirections — handle both joined (2>/dev/null) and spaced (2> /dev/null)
    if (/^[0-9]*>{1,2}|^&>|^[0-9]*</.test(token)) {
      // If the token is ONLY the operator (no target attached), skip the next token too
      if (/^(?:[0-9]*>{1,2}|&>|[0-9]*<)$/.test(token)) {
        skipNext = true;
      }
      continue;
    }
    // Strip surrounding quotes — prevents false positives on rm -rf ".pi/tmp/foo"
    paths.push(token.replace(/^["']|["']$/g, ""));
  }

  // Guard against vacuous truth — if no paths extracted, don't silently allow
  if (paths.length === 0) return false;

  // Resolve and substitute PROJECT_TMP_DIR env var
  const projectTmpDir = path.join(cwd, ".pi", "tmp");
  let resolvedCwd: string | null;
  try {
    resolvedCwd = realpathSync(cwd);
  } catch {
    resolvedCwd = null; // cwd doesn't exist — project tmp checks will all fail
  }

  for (const p of paths) {
    // Substitute ${PROJECT_TMP_DIR} or $PROJECT_TMP_DIR
    const expanded = p.replace(/\$\{?PROJECT_TMP_DIR\}?/g, projectTmpDir);
    let resolved: string;
    try {
      // Use realpathSync to resolve symlinks — prevents symlink traversal attacks
      resolved = realpathSync(path.resolve(cwd, expanded));
    } catch {
      // Path doesn't exist. For /tmp paths, validate the existing parent via realpathSync
      // to catch symlinked parents (e.g., /tmp/evil-link -> / where evil-link exists).
      const lexical = path.resolve(cwd, expanded);
      if (lexical.startsWith("/tmp/") && lexical !== "/tmp" && lexical.length > 5) {
        // Block paths containing traversal sequences — even if they resolve under /tmp/,
        // they may have escaped and re-entered via ..
        if (expanded.includes("..")) {
          return false;
        }
        // Validate that the existing parent resolves under /tmp
        const parentDir = path.dirname(lexical);
        try {
          const resolvedParent = realpathSync(parentDir);
          // Resolve /tmp itself to handle systems where /tmp is a symlink (e.g., /private/tmp on macOS)
          let resolvedTmp: string;
          try { resolvedTmp = realpathSync("/tmp"); } catch { resolvedTmp = "/tmp"; }
          if (!resolvedParent.startsWith(resolvedTmp + "/") && resolvedParent !== resolvedTmp) {
            return false; // Parent symlinks outside /tmp
          }
        } catch {
          // Parent also doesn't exist — safe (entire path is non-existent)
        }
        resolved = lexical;
      } else if (resolvedCwd !== null &&
        (lexical.startsWith(resolvedCwd + path.sep) || lexical === resolvedCwd) &&
        (lexical.includes(`${path.sep}.pi${path.sep}tmp${path.sep}`) ||
         lexical.endsWith(`${path.sep}.pi${path.sep}tmp`))) {
        // Non-existent path within project .pi/tmp/ — validate parent exists under project
        if (expanded.includes("..")) {
          return false;
        }
        const parentDir = path.dirname(lexical);
        try {
          const resolvedParent = realpathSync(parentDir);
          if (!resolvedParent.startsWith(resolvedCwd + path.sep) && resolvedParent !== resolvedCwd) {
            return false; // Parent symlinks outside project
          }
        } catch {
          // Parent also doesn't exist — safe (entire path is non-existent)
        }
        resolved = lexical;
      } else {
        return false;
      }
    }

    // Check if path is in an allowed temp location:
    // A) Project .pi/tmp/ — path within project AND goes through .pi/tmp/
    // B) System /tmp/<something> — path under /tmp/ but NOT /tmp itself
    const inProjectTmp = resolvedCwd !== null &&
      (resolved.startsWith(resolvedCwd + path.sep) || resolved === resolvedCwd) &&
      (resolved.includes(`${path.sep}.pi${path.sep}tmp${path.sep}`) ||
       resolved.endsWith(`${path.sep}.pi${path.sep}tmp`));
    const inSystemTmp = resolved.startsWith("/tmp/") && resolved !== "/tmp" && resolved.length > 5;

    if (!inProjectTmp && !inSystemTmp) return false;
  }

  return true;
}

/**
 * Detect a REAL `git <sub>` invocation (sub = "commit" or "push") at a shell command
 * position — NOT a substring inside a heredoc body, string argument, or file path.
 *
 * BUG #3 FIX: `hasGitSub` matches the literal text `git ... commit` ANYWHERE, so
 * writing a file whose CONTENT mentions "git commit" (heredoc body), an echo/string
 * arg like `echo 'run git commit later'`, or a path like `node "/tmp/git commit x.mjs"`
 * wrongly triggered the commit/push guard. This helper narrows detection to genuine
 * invocations by (1) stripping heredoc bodies and (2) requiring `git` at a command
 * boundary (start, or after ; && || | & newline ( { or control-flow keywords).
 *
 * Security note: we DO NOT attempt full shell quote parsing. We block conservatively
 * — any `git <flags> <sub>` at a command boundary in the (heredoc-stripped) command
 * still blocks. This narrows false-positives without opening a bypass: a real
 * `git commit`/`git push` cannot avoid appearing at a command boundary.
 */
export function isRealGitCommitOrPush(command: string): boolean {
  // Strip heredoc bodies so file CONTENT that mentions "git commit" does not count.
  const stripped = stripHeredocBodies(command);
  // Require git at a command position: start-of-string, or after a statement separator
  // / pipe / background / newline / subshell-open / brace-group / control-flow keyword.
  const boundary = /(?:^|[;&|\n(){]|&&|\|\||\bthen\b|\bdo\b|\belse\b|\belif\b)\s*/.source;
  // PREFIX BYPASS FIX: real git invocations can be preceded by allowed prefixes that the
  // old boundary-only check missed — `sudo git commit`, `env GIT_DIR=x git commit`,
  // `GIT_DIR=x git commit` (bare VAR=value assignment prefix), `command git commit`,
  // `builtin`/`exec` wrappers. Allow an optional sequence of these before git:
  //   - sudo (with flags), env (with flags)
  //   - one-or-more VAR=value assignments
  //   - command / builtin / exec wrappers
  //
  // SUDO/ENV ARG BYPASS FIX (finding #3): real sudo/env flags TAKE A FOLLOWING
  // ARGUMENT (`sudo -u root git commit`, `sudo -g grp git commit`, `env -u HOME git
  // commit`), and env accepts VAR=value operands (`env FOO=bar git commit`). The old
  // `(?:\s+-\S+)*` only consumed bare flags, so the arg token stopped the prefix early
  // and these BYPASSED the guard. We now consume, after `sudo`/`env`, a sequence of:
  //   - `--long ARG` long option taking an argument (`--user root`)
  //   - `-x ARG`     short option taking an argument (`-u root`, `-g grp`)
  //   - `-\S+`       bare flag (`-n`, `--preserve-env`, combined `-xyz`)
  //   - `VAR=value`  env operand (`FOO=bar`)
  // A `(?!git\b)` guard on the arg-consuming forms prevents swallowing the `git` token
  // itself; alternatives are ordered specific-first and backtracking resolves the rest.
  const sudoEnvArg = /(?:sudo|env)(?:\s+(?:--\S+\s+(?!git\b)\S+|-[a-zA-Z]\s+(?!git\b)\S+|-\S+|[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)))*\s+/.source;
  const assignArg = /[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+/.source;
  const wrapArg = /(?:command|builtin|exec)\s+/.source;
  const prefix = `(?:${sudoEnvArg}|${assignArg}|${wrapArg})*`;
  // Allow an optional path prefix on git itself: `/usr/bin/git`, `/bin/git`, etc. The
  // executable must END in `/git` so that a path ARGUMENT to another program (e.g.
  // `node "/tmp/git commit test.mjs"`) is NOT matched — there git is not the invoked
  // command (first token is `node`, "git commit" lives inside a quoted arg).
  const gitExe = /(?:\S*\/)?git\b/.source;
  // Then allow git's own flags (git -c k=v, git -C dir, --no-pager, etc.) before the sub.
  const gitFlags = /(?:\s+(?:-[a-zA-Z]\s+\S+|-\S+))*/.source;
  for (const sub of ["commit", "push"]) {
    if (new RegExp(boundary + prefix + gitExe + gitFlags + `\\s+${sub}\\b`).test(stripped)) {
      enfLog.debug("git_invocation_detected", sub);
      return true;
    }
  }
  return false;
}

/**
 * Inject `--signoff` into the REAL git-commit invocation only (DCO enforcement).
 *
 * BUG THIS FIXES: a naive `command.replace(/\bgit\b...commit\b/, ...)` injects
 * `--signoff` into the FIRST `git ... commit` substring anywhere in the command —
 * including a `git commit` mention INSIDE an echo/printf message body before a pipe
 * (e.g. `echo -e "...sudo -u root git commit..." | git commit -F -`), corrupting the
 * commit MESSAGE instead of the real invocation. This mirrors the trailer-injection
 * scoping in handleCommitTrailer.
 *
 * Behavior:
 *   - Pattern A (echo/printf "..." | git commit -F -): the real invocation is AFTER
 *     the last pipe. Inject into the gitPart only; never touch the echo/message body.
 *   - Pattern B (bare `git commit ...`, `git commit -m/-F ...` with no commit pipe):
 *     inject `--signoff` right after the `commit` token of the real invocation, using
 *     the same command-position/prefix boundary logic as isRealGitCommitOrPush so a
 *     `git commit` substring inside a quoted arg is never matched.
 *   - If the real invocation already has `--signoff` or `-s` -> return unchanged.
 *   - If there is no real git-commit invocation -> return unchanged.
 */
export function injectSignoff(command: string): string {
  const SIGNOFF_RE = /(?:^|\s)--signoff(?:\s|$)/;
  const SHORT_S_RE = /(?:^|\s)-s(?:\s|$)/;
  // Reuse the exact command-position/prefix construction from isRealGitCommitOrPush,
  // capturing everything up to and including the `commit` token so we can insert
  // ` --signoff` immediately after it via a NON-global replace (first real match only).
  const boundary = /(?:^|[;&|\n(){]|&&|\|\||\bthen\b|\bdo\b|\belse\b|\belif\b)\s*/.source;
  const sudoEnvArg = /(?:sudo|env)(?:\s+(?:--\S+\s+(?!git\b)\S+|-[a-zA-Z]\s+(?!git\b)\S+|-\S+|[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)))*\s+/.source;
  const assignArg = /[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+/.source;
  const wrapArg = /(?:command|builtin|exec)\s+/.source;
  const prefix = `(?:${sudoEnvArg}|${assignArg}|${wrapArg})*`;
  const gitExe = /(?:\S*\/)?git\b/.source;
  const gitFlags = /(?:\s+(?:-[a-zA-Z]\s+\S+|-\S+))*/.source;
  const commitRe = new RegExp(`(${boundary}${prefix}${gitExe}${gitFlags}\\s+commit\\b)`);

  // Pattern A: echo/printf "..." | git commit -F -  (real invocation after last pipe)
  const pipeIdx = command.lastIndexOf("|");
  if (pipeIdx !== -1 && /git\s+commit\s+.*-F\s*-/.test(command.slice(pipeIdx))) {
    const echoPart = command.slice(0, pipeIdx);
    const gitPart = command.slice(pipeIdx);
    if (SIGNOFF_RE.test(gitPart) || SHORT_S_RE.test(gitPart)) return command;
    if (!commitRe.test(gitPart)) return command;
    enfLog.debug("injectSignoff", "pattern A (piped git commit -F -)");
    return echoPart + gitPart.replace(commitRe, "$1 --signoff");
  }

  // Pattern B: bare / inline git commit (no message pipe)
  const m = commitRe.exec(command);
  if (!m) return command;
  // Scope the "already signed" check to the MATCHED real invocation ONLY, not the
  // whole command. The invocation region runs from the start of the match to the
  // next UNQUOTED statement boundary (; && || | & newline) or end-of-string.
  const regionStart = m.index;
  let regionEnd = command.length;
  {
    // Escape-aware quote-state scan. In POSIX sh, backslash escapes the next char
    // ONLY inside double quotes (and unquoted); inside single quotes a backslash is
    // literal and only a `'` ends the string. A `\"` inside a double-quoted string is
    // an escaped quote (stays inside), and `\\` is an escaped backslash (does not
    // escape the following quote). Getting this right prevents a `\"` from wrongly
    // toggling quote state — which would let an inner `;`/`&`/`|` be seen as a real
    // statement boundary (or hide a real one) and miscompute the invocation region.
    let inSingle = false;
    let inDouble = false;
    for (let i = regionStart; i < command.length; i++) {
      const c = command[i];
      if (inSingle) {
        // Single quotes: no backslash processing; only `'` terminates.
        if (c === "'") inSingle = false;
        continue;
      }
      if (inDouble) {
        // Double quotes: `\` escapes the next char (e.g. \" or \\) — skip it.
        if (c === "\\") { i++; continue; }
        if (c === '"') inDouble = false;
        continue;
      }
      // Unquoted: `\` escapes the next char so an escaped quote does not open a string.
      if (c === "\\") { i++; continue; }
      if (c === "'") { inSingle = true; continue; }
      if (c === '"') { inDouble = true; continue; }
      if (c === "\n" || c === ";" || c === "&" || c === "|") { regionEnd = i; break; }
    }
  }
  // Strip quoted substrings from the region so a `-s`/`--signoff` INSIDE the
  // -m/-F message value (e.g. `-m "fix -s bug"`) is NOT treated as already-signed.
  // Escape-aware: a `\"` inside a double-quoted span does NOT terminate it, so an
  // inner `-s`/`--signoff` fenced by escaped quotes (`-m "a \" -s \" b"`) is still
  // stripped away — otherwise it would leak out as an unquoted flag and suppress
  // injection on an unsigned real commit (DCO bypass). Double-quoted spans are
  // stripped FIRST so the single-quote regex cannot misfire on an apostrophe that
  // lives literally inside a double-quoted string. Single quotes do NOT process
  // backslashes in POSIX sh, so their regex stays escape-agnostic.
  const region = command
    .slice(regionStart, regionEnd)
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'[^']*'/g, "''");
  if (SIGNOFF_RE.test(region) || SHORT_S_RE.test(region)) return command;
  enfLog.debug("injectSignoff", "pattern B (inline git commit)");
  return command.replace(commitRe, "$1 --signoff");
}

/** Detect git add --force / -f (including combined short options like -fn).
 *  Respects -- end-of-options marker and shell separators (&&, ;, |, ||). */
export function hasGitAddForce(command: string): boolean {
  if (!hasGitSub(command, "add")) return false;
  // Split on shell separators to isolate individual statements
  const statements = command.split(/\s*(?:&&|\|\||[;|])\s*/);
  for (const stmt of statements) {
    const addMatch = stmt.match(/\bgit\b.*\badd\b\s+(.*)/);
    if (!addMatch) continue;
    const tokens = addMatch[1].split(/\s+/);
    for (const token of tokens) {
      if (token === "--") break; // Everything after -- is a pathspec
      if (token === "--force") return true;
      // Short option: -f or combined like -fn, -vf (starts with - but not --)
      if (token.startsWith("-") && !token.startsWith("--") && token.includes("f")) return true;
    }
  }
  return false;
}

/** Check if a git add command uses bulk-stage tokens (., -A, --all) before the -- separator. */
export function hasGitAddBulk(command: string): boolean {
  if (!hasGitSub(command, "add")) return false;
  const addMatch = command.match(/\bgit\b.*\badd\b\s+(.*)/);
  if (!addMatch) return false;
  const args = addMatch[1];
  // Split tokens, only check before -- (end-of-options marker)
  const tokens = args.split(/\s+/);
  for (const token of tokens) {
    if (token === "--") break; // Everything after -- is a pathspec
    if (token === "." || token === "-A" || token === "--all") return true;
  }
  return false;
}

/** Strip heredoc bodies from command string, preserving commands after the closing delimiter */
export function stripHeredocBodies(cmd: string): string {
  // Match heredoc: <<DELIM ... DELIM and <<-DELIM ... (tab-indented) DELIM
  // For <<- (dash form), the closing delimiter can be preceded by tabs only.
  // Closing delimiter must be on its own line with no trailing content (except newline).
  return cmd.replace(/<<-(\s*)['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n[ \t]*\2\s*(?=\n|$)/gm, "")
    .replace(/<<(\s*)['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\2\s*(?=\n|$)/gm, "");
}

/**
 * True when `gh pr|issue create|comment|edit` is a real invocation (command
 * boundary), not a mention inside a string/heredoc body.
 */
export function isRealGhBodyCommand(command: string): boolean {
  const stripped = stripHeredocBodies(command);
  const boundary = /(?:^|[;&|\n(){]|&&|\|\||\bthen\b|\bdo\b|\belse\b|\belif\b)\s*/.source;
  const ghExe = /(?:\S*\/)?gh\b/.source;
  const re = new RegExp(
    boundary + ghExe + String.raw`\s+(?:pr|issue)\s+(?:create|comment|edit)\b`,
  );
  const result = re.test(stripped);
  enfLog.debug("isRealGhBodyCommand", result);
  return result;
}

function commentSignatureFooter(signature: string): string {
  return `\n\n---\n*${signature}*`;
}

const ghSignatureModel = /^[\w:./+@-]+(?: [\w:./+@-]+)*$/;
const ghSignatureLine = /(^|\n|\\n)(?:(?:\n|\\n)---(?:\n|\\n))?\*Assisted-by: PI \(([^\r\n]*?)\)\*(?=\r?\n|\\n|$)/g;

function bodyAlreadySigned(text: string): boolean {
  const lines = text.matchAll(ghSignatureLine);
  for (const line of lines) {
    if (ghSignatureModel.test(line[2])) return true;
  }
  return false;
}

/** Keep the first standalone valid footer, but use the current operation's model. */
function normalizeGhBodyFooters(payload: string, signature: string): string {
  let signed = false;
  return payload.replace(ghSignatureLine, (block, _prefix: string, model: string) => {
    if (model.includes("PI_MODEL")) {
      enfLog.debug("injectGhBodySignature removed unresolved PI_MODEL footer");
      return "";
    }
    if (ghSignatureModel.test(model)) {
      if (signed) {
        enfLog.debug("injectGhBodySignature removed duplicate valid footer", model);
        return "";
      }
      signed = true;
      if (`Assisted-by: PI (${model})` !== signature) {
        enfLog.debug("injectGhBodySignature replaced stale footer", model);
        return block.replace(`*Assisted-by: PI (${model})*`, `*${signature}*`);
      }
    }
    return block;
  });
}

/** Index of the matching closer for a quote at `openIdx`, honoring POSIX escapes. */
function matchingQuoteIndex(s: string, openIdx: number): number | null {
  const q = s[openIdx];
  if (q !== '"' && q !== "'") return null;
  if (q === "'") {
    const close = s.indexOf("'", openIdx + 1);
    enfLog.debug("matchingQuoteIndex single", close != null && close >= 0);
    return close < 0 ? null : close;
  }
  for (let i = openIdx + 1; i < s.length; i++) {
    if (s.startsWith("<<", i)) {
      const opener = /^<<(-?)[ \t]*(['"]?)([\w-]+)\2[^\n]*\n/.exec(s.slice(i));
      if (opener) {
        const closer = new RegExp(String.raw`\n${opener[1] ? "\\t*" : ""}${opener[3]}\r?(?=\n|$)`).exec(s.slice(i + opener[0].length - 1));
        if (closer) {
          enfLog.debug("matchingQuoteIndex skip heredoc", opener[3]);
          i += opener[0].length - 1 + closer.index + closer[0].length - 1;
          continue;
        }
      }
    }
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === '"') {
      enfLog.debug("matchingQuoteIndex double", i);
      return i;
    }
  }
  enfLog.debug("matchingQuoteIndex unclosed double");
  return null;
}

/**
 * Last quoted `--body` / `--body=` span in `command`. Conservative: unquoted
 * or unclosed values are skipped (caller no-ops).
 */
function findLastQuotedBodySpan(command: string): { open: number; close: number } | null {
  const flagRe = /--body(?:=|\s+)/g;
  let last: { open: number; close: number } | null = null;
  let fm: RegExpExecArray | null;
  while ((fm = flagRe.exec(command)) !== null) {
    const after = fm.index + fm[0].length;
    const q = command[after];
    if (q !== '"' && q !== "'") {
      enfLog.debug("findLastQuotedBodySpan skip unquoted --body");
      continue;
    }
    const close = matchingQuoteIndex(command, after);
    if (close == null) {
      enfLog.warn("findLastQuotedBodySpan unclosed --body quote");
      continue;
    }
    last = { open: after, close };
  }
  enfLog.debug("findLastQuotedBodySpan", last ? "found" : "none");
  return last;
}

function lastHeredocInSpan(
  command: string,
  spanStart: number,
  spanEnd: number,
): RegExpExecArray | null {
  const heredocRe = /<<-?[ \t]*(['"]?)([\w-]+)\1[^\n]*\n([\s\S]*?)\n([ \t]*)\2\r?(?=\n|$)/g;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = heredocRe.exec(command)) !== null) {
    if (m.index > spanStart && m.index < spanEnd) last = m;
  }
  enfLog.debug("lastHeredocInSpan", last ? last[2] : "none");
  return last;
}

/**
 * Append the comment_signature footer to `gh pr|issue create|comment|edit`
 * `--body` / heredoc payloads. Idempotent. Empty signature is a no-op.
 * Only mutates a heredoc that sits inside the `--body` quoted span.
 */
export function injectGhBodySignature(command: string, signature: string): string {
  if (!signature) {
    enfLog.debug("injectGhBodySignature skip empty signature");
    return command;
  }
  if (!isRealGhBodyCommand(command)) {
    enfLog.debug("injectGhBodySignature skip not a gh body command");
    return command;
  }
  const footer = commentSignatureFooter(signature);
  const span = findLastQuotedBodySpan(command);
  if (!span) {
    enfLog.debug("injectGhBodySignature no quoted --body found");
    return command;
  }

  const payload = command.slice(span.open + 1, span.close);
  const normalizedPayload = normalizeGhBodyFooters(payload, signature);
  if (normalizedPayload !== payload) {
    // Re-parse positions after cleanup so command-substitution heredocs still
    // receive their footer before the closing delimiter.
    const normalizedCommand = command.slice(0, span.open + 1) + normalizedPayload + command.slice(span.close);
    return injectGhBodySignature(normalizedCommand, signature);
  }
  if (bodyAlreadySigned(payload)) {
    enfLog.debug("injectGhBodySignature skip already present in body");
    return command;
  }

  const last = lastHeredocInSpan(command, span.open, span.close);
  if (last) {
    const delim = last[2];
    const indent = last[4] ?? "";
    const closeToken = `\n${indent}${delim}`;
    const closeIdx = last.index + last[0].lastIndexOf(closeToken);
    if (closeIdx >= last.index) {
      enfLog.debug("injectGhBodySignature heredoc in --body", delim);
      const crlf = command[closeIdx - 1] === "\r";
      const insertAt = crlf ? closeIdx - 1 : closeIdx;
      return command.slice(0, insertAt) + (crlf ? footer.replaceAll("\n", "\r\n") : footer) + command.slice(insertAt);
    }
  }

  if (payload.startsWith("$(")) {
    enfLog.warn("injectGhBodySignature --body command subst without heredoc match");
    return command;
  }
  enfLog.debug("injectGhBodySignature --body quoted");
  return command.slice(0, span.close) + footer + command.slice(span.close);
}

/**
 * Detect common test runner commands — require command-start position
 * (after &&, |, ;, a newline, or line start) to avoid false positives from install/grep/cat commands.
 * `pre-commit` counts only when its `run` subcommand is executed; setup and information
 * commands must not mark tests as passed.
 * NOTE: For compound commands (e.g., pytest && other_cmd), if the non-test part fails,
 * isError=true marks tests as failed even though pytest passed. This is the conservative/safe
 * direction — re-run the test command standalone to mark tests_passed.
 * NOTE: `tox` without `-e` args matches (runs default envs = tests). `tox -e lint` does NOT
 * match — we exclude tox with explicit -e to avoid marking lint/docs runs as test passes.
 */
export function isTestRunnerCommand(command: string): boolean {
  const result = /(?:^|[;&|]\s*)(?:uv\s+run\s+(?:--\S+(?:\s+\S+)?\s+)*)?(?:pytest|vitest|jest|mocha)\b/.test(command)
    || /(?:^|[;&|]\s*)(?:uv\s+run\s+(?:--\S+(?:\s+\S+)?\s+)*)?tox\b(?!\s*-e)(?!\s+--(?:help|version|list))/.test(command)
    || /(?:^|[;&|]\s*)go\s+test\b/.test(command)
    || /(?:^|[;&|]\s*)npm\s+test\b/.test(command)
    || /(?:^|[;&|]\s*)npx\s+tsx\s+--test\b/.test(command)
    || /(?:^|[;&|\n]\s*)pre-commit\s+run\b/.test(command);
  enfLog.debug("isTestRunnerCommand", result);
  return result;
}

/** True for release bump branches: chore/bump-version-<digit>... */
export function isBumpVersionBranch(branch: string | null): boolean {
  return !!branch && /^chore\/bump-version-\d/.test(branch);
}

/** Branch cache per cwd — avoids repeated git calls on hot edit/write path. */
const branchCache = new Map<string, { branch: string | null; at: number }>();
const BRANCH_CACHE_TTL_MS = 5_000;

export function getCachedBranch(cwd: string): string | null {
  const now = Date.now();
  const cached = branchCache.get(cwd);
  if (cached && now - cached.at < BRANCH_CACHE_TTL_MS) return cached.branch;
  const branch = getCurrentBranch(cwd);
  // Only cache non-bump-version branches — bump branches must always be fresh
  // to avoid stale results after switching away from a release branch.
  if (!isBumpVersionBranch(branch)) {
    branchCache.set(cwd, { branch, at: now });
  } else {
    branchCache.delete(cwd);
  }
  return branch;
}

/** Clear branch cache (tests). */
export function clearBranchCache(): void {
  branchCache.clear();
}

/** Seed branch cache for testing — inject a value with custom timestamp. */
export function seedBranchCacheForTests(cwd: string, branch: string | null, at?: number): void {
  branchCache.set(cwd, { branch, at: at ?? Date.now() });
}
