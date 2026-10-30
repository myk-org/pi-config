/**
 * Pure helper functions for dangerous-command enforcement.
 * Extracted to allow testing without SDK dependencies.
 */

import { createLogger } from "../shared/logger.js";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync, mkdirSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { join } from "node:path";
import { getProjectDataDir } from "./utils.js";
import { getGlobalSettingsPath, getSettingsPath, loadGlobalSettings, loadProjectSettings } from "./project-settings.js";
import { readSettingsFile, writeSettingsFile } from "./settings-tui-helpers.js";
import { DANGEROUS, WRAPPER_VALUE_OPTIONS, executableText, getCurrentBranch, isConflictResolutionCommand, segmentRunsGit, tokenize } from "./git-helpers.js";

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
      // A quote spans a newline: `cd "conflicted\nrepo"` is one multi-line path.
      // An unterminated quote is not recovered from here either — bash reports
      // one and runs nothing, and the caller fails closed when no directory
      // can be resolved.
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
    } else if (ch === ";") {
      push(i, start, conditional);
      conditional = false;
      start = i + 1;
      chainStart = chainLen();
    } else if (ch === "|") {
      // Every pipeline component runs in a subshell of its own, so a directory
      // change on the left of the pipe does not reach the right. Marking it
      // backgrounded is exactly the same rule as a trailing ampersand.
      push(i, start, conditional, true);
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
      // Inside quotes a backslash is literal, so it is doubled here and the
      // caller unescapes it back: `cd 'foo\ bar'` is one directory whose name
      // contains a backslash, not a space.
      const literal = target.replace(/\\/g, "\\\\");
      enfLog.debug("cd_target_quoted", "target", literal);
      return literal;
    }
    let end = i;
    // An escaped character is part of the name: `weird\&name` is one directory.
    while (end < args.length && !/[\s;&|)]/.test(args[end])) {
      if (args[end] === "\\" && end + 1 < args.length) end++;
      end++;
    }
    // Unquoted, a backslash before a newline is a continuation the shell removes
    // entirely. Inside quotes it would be literal, which is why only this path
    // joins and the quoted one above does not.
    const target = args.slice(i, end).replace(/\\\n/g, "");
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
const WRAPPER_WORDS = new Set(["sudo", "command", "exec", "time", "nohup", "nice", "stdbuf", "setsid", "timeout", "rtk"]);

/** env options whose value is a separate word. */
const ENV_VALUE_OPTIONS = new Set([
  "-u", "--unset", "-C", "--chdir", "-S", "--split-string", "-a", "--argv0",
  "--block-signal", "--default-signal", "--ignore-signal", "--debug",
]);

const GIT_INDEX_VARS = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]);
const GIT_INDEX_OPTIONS = new Set(["--git-dir", "--work-tree", "--namespace"]);

/** Command words that hand a quoted string to a shell, which then really runs it. */
const SHELL_WORDS = new Set(["bash", "sh", "zsh", "dash", "ksh", "eval"]);

/** True when this segment RUNS a shell (behind any wrapper/assignment/env prefix).
 *  A quoted argument containing shell-looking text is not a shell run: only the
 *  command word counts. */
function runsNestedShell(tokens: string[]): boolean {
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (WRAPPER_WORDS.has(tok) || tok === "env" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) continue;
    if (tok.startsWith("-")) {
      // env's own options sit between `env` and the command it runs.
      if (!tok.includes("=") && ENV_VALUE_OPTIONS.has(tok.split("=")[0])) i++;
      continue;
    }
    return SHELL_WORDS.has(tok.replace(/^[()]+/, "").replace(/.*\//, ""));
  }
  return false;
}

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
/** What a scan looks for: the environment variables, git global options, and
 *  `-c` config keys that select the repository or identity git runs with. */
interface GitOverrideTargets {
  /** Variables that count in assignment position. */
  env: Set<string>;
  /** Long options in git's global region, before the subcommand. */
  flags: Set<string>;
  /** Keys of `-c <key>=<value>` / `--config-env=<key>=<VAR>`. */
  configKeys: Set<string>;
}

const NO_KEYS: Set<string> = new Set();

/**
 * The one assignment/option walk behind both git override guards
 * (gitIndexOverride and gitIdentityOverride). Returns a label for what it found,
 * or null.
 *
 * Position matters. An environment variable only counts in *assignment
 * position* — `GIT_DIR=/x git add a.txt`, optionally through `env` — so
 * `git add GIT_INDEX_FILE=notes` stages a file with that name. Options only
 * count in git's global region before the subcommand, so
 * `git add -- --work-tree=x` is a filename too.
 */
function scanGitOverrides(command: string, targets: GitOverrideTargets): string | null {
  const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/;
  const nameOf = (tok: string) => tok.split("=")[0];
  for (const seg of unquotedSegments(command)) {
    const tokens = tokenize(seg.text);
    let i = 0;
    // `export GIT_INDEX_FILE=/x` sets it for later commands in the same shell,
    // so it points git at another index just as an inline assignment does. This
    // segment does not run git itself, so it is checked before that requirement.
    // The executable view of a nested shell wraps a segment in `(`, so `(export`
    // is the same word.
    if (tokens[i]?.replace(/^\(+/, "") === "export") {
      i++;
      while (i < tokens.length) {
        const name = nameOf(tokens[i]);
        if (targets.env.has(name)) {
          enfLog.warn("git_override", "source", name, "via", "export");
          return name;
        }
        i++;
      }
      continue;
    }
    // `echo GIT_INDEX_FILE=/x` only prints the name. An override is something
    // git is actually run with, so the segment has to run git for it to count —
    // directly, or through a nested shell that this segment RUNS
    // (`GIT_AUTHOR_EMAIL=x bash -c 'git commit'`), whose assignment lives here
    // but whose git runs inside. A quoted argument merely MENTIONING a command
    // (`gh pr create --body "…git -c user.email=x commit…"`) is prose: the
    // segment runs `gh`, not a shell, so it is not followed.
    if (!segmentRunsGit(seg.text) && !(runsNestedShell(tokens) && segmentRunsGit(executableText(seg.text)))) continue;
    // Leading `VAR=value` assignments, then the same again after `env`. A
    // wrapper that runs the rest — `sudo`, `command`, `exec`, `time` — sits in
    // front of both, and can be chained.
    for (let round = 0; round < 4; round++) {
      // A wrapper runs the rest, and its OWN options sit in between: in
      // `rtk -v GIT_AUTHOR_EMAIL=x git commit` the assignment follows rtk's
      // option, so stepping only over the wrapper word hid it (Qodo, PR #996).
      while (i < tokens.length && WRAPPER_WORDS.has(tokens[i])) {
        i++;
        while (i < tokens.length && tokens[i].startsWith("-") && tokens[i] !== "-") {
          i += WRAPPER_VALUE_OPTIONS.has(tokens[i]) ? 2 : 1;
        }
      }
      while (i < tokens.length && assignment.test(tokens[i])) {
        const name = nameOf(tokens[i]);
        if (targets.env.has(name)) {
          enfLog.warn("git_override", "source", name);
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
    // A segment can start mid-subshell, so `(git` is the git word too.
    const g = tokens.findIndex((t) => t.replace(/^[()]+|[()]+$/g, "") === "git");
    if (g === -1) continue;
    for (let k = g + 1; k < tokens.length; k++) {
      const tok = tokens[k];
      if (!tok.startsWith("-") || tok === "-") break;
      // `-c <key>=<value>`, `-c<key>=<value>`, `--config-env=<key>=<VAR>` apply to
      // this one command only — no config file is written, the effect is the same.
      let setting: string | undefined;
      if (tok === "-c") setting = tokens[++k];
      else if (tok.startsWith("-c")) setting = tok.slice(2);
      else if (tok.startsWith("--config-env=")) setting = tok.slice("--config-env=".length);
      if (setting !== undefined) {
        const key = (setting.split("=")[0] ?? "").toLowerCase();
        if (targets.configKeys.has(key)) {
          const label = tok.startsWith("--config-env") ? `--config-env ${key}` : `-c ${key}`;
          enfLog.warn("git_override", "source", label);
          return label;
        }
        continue;
      }
      const name = nameOf(tok);
      if (targets.flags.has(name)) {
        enfLog.warn("git_override", "source", name);
        return name;
      }
      if (!tok.includes("=") && tokens[k + 1] && !tokens[k + 1].startsWith("-")) k++;
    }
  }
  return null;
}

function gitIndexOverride(command: string): string | null {
  const found = scanGitOverrides(command, { env: GIT_INDEX_VARS, flags: GIT_INDEX_OPTIONS, configKeys: NO_KEYS });
  if (found) enfLog.warn("git_index_override", "source", found);
  return found;
}

/** Environment variables that set who a commit is recorded as. */
const GIT_IDENTITY_VARS = new Set([
  "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL",
]);

/** Git config keys that set who a commit is recorded as. */
const GIT_IDENTITY_KEYS = new Set([
  "user.name", "user.email", "author.name", "author.email", "committer.name", "committer.email",
]);

/** `git config` flags that only READ: `git config --get user.email` changes nothing. */
const CONFIG_READ_FLAGS = new Set(["--get", "--get-all", "--get-regexp", "--list", "-l"]);

/** `git config` flags that remove a key: no value follows, yet the identity moves. */
const CONFIG_UNSET_FLAGS = new Set(["--unset", "--unset-all"]);

/**
 * True when a bash command WRITES into a path matching `targetSrc` (a regex
 * source): a redirect (`>`, `>>`, `>|`) or `tee`/`sponge` taking it as an
 * argument. Deliberately NARROW (user decision on issue #949 R3): broad
 * write-verb co-occurrence taxed legitimate work and any text guard is
 * bypassable anyway — this catches the lazy one-liner.
 *
 * Redirect STRUCTURE is read from the prose-masked command; quoted targets are
 * invisible once masked, so those are matched on the raw command (Qodo #950 R5).
 */
export function bashWritesToPath(command: string, maskedCommand: string, targetSrc: string): boolean {
  // `tee -a <path>` / `tee --append <path>`: tee's own options sit between it and
  // the path it writes.
  const STRUCTURAL = String.raw`>+\|?\s*\S*${targetSrc}|(?:^|[\s;&|(])(?:tee|sponge)(?:\s+-[A-Za-z-]+)*\s+\S*${targetSrc}`;
  const QUOTED = String.raw`>+\s*["'][^"']*${targetSrc}|(?:^|[\s;&|(])(?:tee|sponge)(?:\s+-[A-Za-z-]+)*\s+["'][^"']*${targetSrc}`;
  let result = new RegExp(STRUCTURAL, "i").test(maskedCommand) || new RegExp(QUOTED, "i").test(command);
  if (!result) {
    // A nested shell's script is code, not prose, so a redirect inside it
    // (`bash -c 'echo x >> .git/config'`) still writes the file. Only segments
    // that RUN a shell are read this way — a quoted argument merely describing
    // a command stays prose (Qodo, PR #996).
    for (const seg of unquotedSegments(command)) {
      if (!runsNestedShell(tokenize(seg.text))) continue;
      if (new RegExp(STRUCTURAL, "i").test(executableText(seg.text))) {
        result = true;
        break;
      }
    }
  }
  enfLog.debug("bash_writes_to_path", targetSrc, result);
  return result;
}


const IDENTITY_TARGETS: GitOverrideTargets = {
  env: GIT_IDENTITY_VARS,
  flags: NO_KEYS,
  configKeys: GIT_IDENTITY_KEYS,
};

/**
 * Anything that sets the identity a commit is recorded under (issue #995): the
 * `GIT_AUTHOR_*` / `GIT_COMMITTER_*` environment variables in assignment
 * position, a
 * per-command `git -c user.name=...`, a `git config` WRITE of an identity key,
 * or `git commit --author`. The identity belongs to the human — an agent that
 * can change it forges commits in someone else's name.
 *
 * Returns a label of what was found, or null.
 *
 * shortcut: a `-c` key held in a shell variable (`-c "$VAR=x"`) does not match,
 * and a quoted value nested two shells deep is seen only if the outer view keeps
 * it parseable — upgrade if either shows up in the wild.
 */
export function gitIdentityOverride(command: string): string | null {
  // A nested shell string (`bash -c '...'`, `eval`) really runs, so both views
  // are checked: the raw text keeps quoted option VALUES parseable
  // (`-c "user.name=x"`), the executable view exposes what a nested shell runs.
  const executable = executableText(command);
  for (const text of executable && executable !== command ? [command, executable] : [command]) {
    const found = scanGitOverrides(text, IDENTITY_TARGETS) ?? identityWritesIn(text);
    if (found) {
      enfLog.warn("git_identity_override", "source", found);
      return found;
    }
  }
  enfLog.debug("git_identity_override", "none", command.length);
  return null;
}

/**
 * The two identity writes the prefix scan cannot see: `git config <identity key>
 * <value>` (written to disk for every later commit) and `git commit --author`
 * (this one commit recorded as somebody else).
 */
function identityWritesIn(command: string): string | null {
  // `git config user.email x` — the identity written to disk for every later commit.
  for (const region of gitSubArgRegions(command, "config")) {
    // Tokens come from the RAW region: tokenize() drops the quotes but keeps a
    // quoted value as one token, so `git config user.email "a@b"` and
    // `git config "user.email" a@b` are both seen, while a value that merely
    // MENTIONS the key stays a single token and is never a key (Qodo, PR #996).
    const tokens = tokenize(region);
    if (tokens.some((t) => CONFIG_READ_FLAGS.has(t))) continue;
    const at = tokens.findIndex((t) => GIT_IDENTITY_KEYS.has(t.toLowerCase()));
    if (at === -1) continue;
    // A key alone is a READ (`git config user.email` prints it): only a value
    // after it, or an unset, changes the identity.
    const writes = tokens.some((t) => CONFIG_UNSET_FLAGS.has(t))
      || tokens.slice(at + 1).some((t) => !t.startsWith("-"));
    if (writes) return `git config ${tokens[at].toLowerCase()}`;
  }
  // `git commit --author` — this one commit is recorded as somebody else.
  for (const region of gitSubArgRegions(command, "commit")) {
    // Raw region again: `--author 'A <a@b>'` and `"--author" x` are options the
    // shell passes to git, while a `-m` message mentioning --author is ONE token.
    const tokens = tokenize(region);
    const at = tokens.findIndex((t) => t === "--author" || t.startsWith("--author="));
    if (at === -1) continue;
    // A bare `--author` with no value after it sets nothing.
    if (tokens[at].includes("=") || (tokens[at + 1] !== undefined && !tokens[at + 1].startsWith("-"))) {
      return "--author";
    }
  }
  return null;
}

/**
 * A path that IS git's identity configuration: `~/.gitconfig`, the XDG
 * `~/.config/git/config`, or a repository's `.git/config`. Writing one of these
 * changes the identity every later commit is recorded under, so agents are kept
 * away from them entirely.
 * The two home files count only under THIS user's home — a `.gitconfig` in
 * /tmp or a docs fixture is not the identity git reads (Qodo, PR #996).
 */
/**
 * Regex source matching a git identity config path as WRITTEN in a shell
 * command — `$HOME`/`~`/absolute home forms and repo-local `.git/config`.
 * One source of truth for the tripwire and its tests (Qodo, PR #996).
 */
export function gitIdentityConfigSrc(): string {
  const homeSrc = homedir().replace(/\\/g, "/").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return String.raw`(?:(?:~|\$HOME|\$\{HOME\}|${homeSrc})/(?:\.gitconfig|\.config/git/config)|\.git/config)(?![A-Za-z0-9._-])`;
}

export function isGitIdentityConfigPath(p: string): boolean {
  const norm = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = norm.slice(norm.lastIndexOf("/") + 1);
  const dir = norm.slice(0, Math.max(norm.lastIndexOf("/"), 0));
  const home = homedir().replace(/\\/g, "/").replace(/\/+$/, "");
  const inHome = dir === home || dir === "~";
  const result =
    (inHome && base === ".gitconfig")
    || norm === `${home}/.config/git/config`
    || norm === "~/.config/git/config"
    || /(?:^|\/)\.git\/config$/.test(norm);
  enfLog.debug("is_git_identity_config_path", p, result);
  return result;
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
  // Per paren depth: is the directory this shell is in one we could not resolve?
  // A subshell's answer dies with the subshell, which is what makes a completed
  // subshell stop mattering.
  const dynamicAt: boolean[] = [false];
  // Set when a command that stages ran in a directory we could not resolve. That
  // is the case worth refusing: we do not know what it staged. A read-only
  // command in the same directory is not, so it does not pin the refusal.
  let unresolvedStaging = false;
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
    while (dynamicAt.length <= seg.depth) dynamicAt.push(dynamicAt[dynamicAt.length - 1]);
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
      // An expanded target leaves the directory unresolved. A relative move
      // inherits that from where it started; an absolute literal path settles it.
      dynamicAt[seg.depth] =
        dynamic(target) || (!target.startsWith("/") && dynamicAt[seg.depth]);
      if (!seg.conditional && !seg.backgrounded && target.startsWith("/") && !dynamic(target) && !unresolvedStaging) {
        // Once a staging command has already run in an unresolved directory, the
        // path stays reported: the refusal has to name the path we could not read.
        dynamicPath = null;
      }
      if (dynamic(target) && !dynamicPath) dynamicPath = target;
    }
    if (segmentRunsGit(seg.text)) {
      let base = running[seg.depth];
      // `env -C dir git add x` moves git into dir without a shell cd.
      const envChdir = /^\s*(?:VAR=\S*\s*)*env\s+(?:-\S+\s+)*?(?:-C|--chdir)(?:[=\s]+)(\S+)/.exec(seg.text);
      if (envChdir) base = applyCd(base, envChdir[1], home);
      dirs.add(base);
      // Git applies each -C in turn, each relative to the previous one.
      const overrides = gitCsIn(seg.text);
      let cursor = base;
      for (const c of overrides) {
        // An expanded override is the directory this invocation actually runs
        // in, so it is the one worth reporting over an earlier cd target.
        if (dynamic(c)) dynamicPath = c;
        // A directory literally named `-` is ordinary; only the shell's own
        // `cd -` means the previous directory.
        cursor = applyCd(cursor, c, home, false);
        dirs.add(cursor);
      }
      // Where this invocation actually runs decides whether it is unresolved. A
      // final absolute override names the worktree outright, so a directory the
      // shell merely expanded on its way there is irrelevant to it.
      const stages = isConflictResolutionCommand(seg.text);
      const lastOverride = overrides[overrides.length - 1];
      const named = lastOverride !== undefined && !dynamic(lastOverride) && lastOverride.startsWith("/");
      if (stages && !named) {
        if (dynamicAt[seg.depth] || overrides.some((c) => dynamic(c))) unresolvedStaging = true;
      }
  }
  }
  const all = [...dirs];
  // Only a command that staged while the directory was unresolved is worth
  // refusing. Otherwise the path was resolved, or only read from, by the end.
  const unresolved = unresolvedStaging ? dynamicPath : null;
  enfLog.debug("conflict_candidate_dirs", "count", all.length, "env_override", envOverride ?? "none", "dynamic_path", unresolved ?? "none", "unresolved_staging", unresolvedStaging);
  return { all, envOverride, dynamicPath: unresolved };
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
    // A segment deeper than the git command runs in a subshell that has already
    // closed by the time git runs, so it cannot have moved this shell. It is
    // skipped rather than ending the walk: a subshell before the command is
    // ordinary, and stopping there would drop every later directory change.
    if (seg.depth > targetDepth) continue;
    while (running.length <= seg.depth) running.push(running[running.length - 1]);
    const target = cdTargetIn(seg.text);
    if (!target || target === "~popd") continue;
    // A change at a shallower depth still counts: `cd /protected && (git commit)`
    // enters /protected first, and the subshell inherits it. Only deeper segments
    // were ruled out above, because those run in a subshell that has closed by
    // the time git runs. Note that a change behind a short-circuit still counts:
    // `cd a && cd b` really does leave the shell in b, and `if cd x; then` leaves
    // it in x too.
    running[seg.depth] = applyCd(running[seg.depth], target);
    applied.push(target);
    // With no git invocation to anchor to, the first cd is the conservative
    // answer for `cd a && cd b && pytest`.
    if (gitIndex === -1) break;
  }
  // The git segment itself was never walked, so a subshell depth it introduced
  // has no entry yet. It inherits the directory of the shell that spawned it.
  while (running.length <= targetDepth) running.push(running[running.length - 1]);
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
  "echo", "printf", "ls",
]);

/**
 * Replace single-quoted regions with '' so substitutions inside them are
 * invisible to the scanner, while a ' inside double quotes stays literal
 * (Qodo PR #948: the old /'[^']*'/g regex treated an apostrophe inside "..."
 * as an opening quote and swallowed everything up to the next apostrophe,
 * hiding executable substitutions like $(rm -rf ...) from extraction).
 * An UNTERMINATED single-quote region is re-emitted raw: a stray apostrophe
 * ("it's fine $(rm -rf /)") must not hide the substitution that follows.
 */
function stripSingleQuotedRegions(stmt: string): string {
  let out = "";
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let singleOpenIndex = -1;
  while (i < stmt.length) {
    const ch = stmt[i];
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
        out += "''";
      }
      i++;
      continue;
    }
    if (inDouble) {
      if (ch === "\\" && i + 1 < stmt.length) {
        out += stmt.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (ch === '"') inDouble = false;
      out += ch;
      i++;
      continue;
    }
    if (ch === "\\" && i + 1 < stmt.length) {
      // Unquoted \x is a literal pair (bash escapes) — a backslash must never
      // turn the NEXT character into a quote delimiter. Without this, a
      // nested strip of `echo \' $(rm -rf /) \'` would treat \' as opening a
      // single-quoted region and hide the live deletion (Qodo PR #950 R2).
      out += stmt.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      singleOpenIndex = i;
      i++;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      out += ch;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  if (inSingle && singleOpenIndex >= 0) out += stmt.slice(singleOpenIndex);
  return out;
}

/**
 * Replace the CONTENT of quoted regions ('...', "...") with a single space,
 * keeping the delimiters, so filename/redirect guards see shell STRUCTURE
 * without prose (Qodo PR #950 R5: `--body "settings => pi-config-settings.json"`
 * must not trip the redirect tripwire). Backslash-escape aware (\" never toggles
 * a quote); an UNTERMINATED quoted region is re-emitted raw — a stray quote
 * must not hide the rest of the command from the guards.
 */
export function maskQuotedRegions(cmd: string): string {
  let out = "";
  let i = 0;
  let quote: "'" | '"' | null = null;
  let openIndex = -1;
  while (i < cmd.length) {
    const ch = cmd[i];
    if (quote !== null) {
      if (quote === '"' && ch === "\\" && i + 1 < cmd.length) {
        i += 2;
        continue;
      }
      if (ch === quote) {
        // Keep the delimiters, replace only the content — structure survives.
        out += " ";
        out += quote;
        quote = null;
      }
      i++;
      continue;
    }
    if (ch === "\\" && i + 1 < cmd.length) {
      // Unquoted \x is a literal pair — a backslash must never turn the next
      // character into a quote delimiter (same rule as
      // stripSingleQuotedRegions, Qodo PR #950 R2).
      out += cmd.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      openIndex = i;
      out += ch;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  if (quote !== null && openIndex >= 0) out += cmd.slice(openIndex + 1);
  return out;
}

/**
 * Extract command substitutions ($(...), `...`) and process substitutions
 * (<(...), >(...)) from a statement, respecting single quotes (which
 * suppress expansion in bash). Returns the extracted command strings.
 */
export function extractSubshells(stmt: string): string[] {
  const results: string[] = [];

  // Strip single-quoted regions — POSIX sh has no escape inside single quotes.
  // Double-quote-aware so a literal apostrophe inside "..." cannot open a
  // quoted region (Qodo PR #948).
  const withoutSingleQuoted = stripSingleQuotedRegions(stmt);

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
        results.push(stripSingleQuotedRegions(withoutSingleQuoted.slice(start, j - 1)));
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
        results.push(stripSingleQuotedRegions(withoutSingleQuoted.slice(i + 1, j)));
        i = j + 1;
        continue;
      }
    }
    i++;
  }
  return results;
}

/**
 * Transparent wrapper prefixes that may precede the real command without
 * changing its read-only nature (issue #947). Mirrors the git-code wrapper
 * set (GIT_RTK_SRC et al., PR #916) — the user-level rtk extension rewrites
 * every bash command through `rtk rewrite` before enforcement evaluates it,
 * so `grep` arrives as `rtk grep`.
 *
 * Deliberately NOT sudo: a sudo-prefixed command must never receive a
 * silent read-only pass (the DANGEROUS sudo pattern still prompts).
 */
const READ_ONLY_WRAPPER_PREFIX_RE =
  // env/nice option handling is PRECISE about which flags take values
  // (PR #948 R2): generic value consumption would let `env -i grep foo`
  // eat `grep` as -i's "value", while no value consumption lets
  // `env -u grep rm -rf x` pass `grep` off as the command. env's value-taking
  // options are -u/-C/-S/-P (and long forms); -i is boolean. nice's only
  // value option is -n/--adjustment.
  // `-S`/`--split-string` is deliberately NOT consumable (PR #948 R3): its
  // "value" is a split command line (`env -S find ls -delete` runs find), so
  // an env -S statement never gets a read-only pass — it falls through to
  // the DANGEROUS pattern check instead.
  /^\s*(?:\S+=\S*\s+|rtk(?:\s+-\S+)*\s+|(?:command|builtin|exec)\s+|env(?:\s+(?:-(?:u|C|P)(?:\s+\S+)?|-i|--ignore-environment|--unset(?:\s+\S+)?|--chdir[= ]\S*|\S+=\S*))*\s+|timeout\s+(?:-\S+\s+)*\S+\s+|nice(?:\s+(?:-n\s+\S+|--adjustment[= ]\S*))*\s+|nohup\s+)+/;

/**
 * Split a command into individual statements for the dangerous-command
 * check: strip heredoc bodies, collapse line continuations, then split on
 * statement separators AND pipes. Single `&` (background operator) is a
 * separator too (Qodo PR #948): `echo ok & rm -rf x` must not let a
 * read-only verdict for `echo` skip the deletion that follows it.
 * `&&` and `||` are matched before `&`/`|` by alternation order.
 * NOTE: Pipe split does not respect shell quoting — biases toward false
 * positives (extra prompts), which is acceptable for security.
 */
export function splitBashStatements(command: string): string[] {
  // Split on statement separators AND pipes. Single `&` (background operator)
  // is a separator too (Qodo PR #948), EXCEPT inside a descriptor-duplication
  // redirect (`2>&1`, `>&2` — PR #948 R3): splitting those at `&` shatters the
  // redirect and hides a piped shell behind harmless fragments. `&&` and `||`
  // are matched before `&`/`|` by alternation order.
  // NOTE: Pipe split does not respect shell quoting — biases toward false
  // positives (extra prompts), which is acceptable for security.
  const normalized = stripHeredocBodies(command).replace(/\\\r?\n/g, " ");
  return normalized
    .split(/\n|;|&&|(?<!>)&|\|\||\|/)
    .map((s: string) => s.trim())
    .filter(Boolean);
}

/**
 * User-approved allowlist for recurring legitimate dangerous-looking commands
 * (issue #949, PR #950). Entries live in the `dangerous_command_allowlist`
 * setting (project `.pi/pi-config-settings.json(c)`, global `~/.pi/...`) so
 * the user can inspect, edit, and extend them — including wildcards:
 * `*` matches any run of characters, `?` exactly one, `\` escapes a literal
 * metachar. Patterns match the FULL command text (anchored, case-sensitive).
 *
 * Entries added via the interactive "always allow" prompt option are the
 * command text with glob metachars ESCAPED — an approval covers exactly the
 * text that was approved; widening to a wildcard family is a deliberate
 * human edit of the settings file. Agents cannot write the entries
 * themselves: the settings files are enforcement-protected (see
 * enforcement.ts) — approvals flow only through the prompt.
 */

/** Glob → anchored RegExp. `*` any run, `?` one char, `\` escapes a literal, rest literal. */
export function allowlistGlobToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\" && i + 1 < pattern.length) {
      re += (pattern[++i] as string).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (c === "*") {
      re += ".*";
    } else if (c === "?") {
      re += ".";
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  // `s` flag: multi-line commands — `*` must span newlines
  return new RegExp(`^${re}$`, "s");
}

/** Normalize a dangerous statement for allowlist matching and storage:
 * trailing I/O redirections (`> /dev/null`, `2>&1`, `2>/dev/null`, `&>f`)
 * are plumbing, not danger — strip them so `bash x 2>&1` matches an entry
 * (or an approval) of `bash x`. Iterated because tails stack
 * (`... > /dev/null 2>&1`). User request, PR #950. */
export function normalizeDangerousStatement(stmt: string): string {
  let s = stmt.trim();
  let prev = "";
  while (prev !== s) {
    prev = s;
    // Strip only BENIGN plumbing tails (Qodo PR #950 R6): descriptor
    // duplication (`2>&1`) and /dev/null targets. A redirect to any other
    // target (file, device, $(...)) STAYS part of the statement — it is
    // side effect, not plumbing, and must not silently inherit an approval
    // granted to the un-redirected statement.
    s = s
      .replace(/\s*\d+>&\d+\s*$/, "")
      .replace(/\s*\d*(?:>{1,2}|&>)\s*\/dev\/null\s*$/, "")
      .trim();
  }
  return s;
}

/**
 * True for shell statements that read their SCRIPT from stdin — a bare
 * `bash`/`sh`/`zsh` (optionally with flags, wrappers like sudo/nohup/env,
 * and variable assignments) and no script path or -c payload. Such a
 * statement carries none of the script it will execute: `x | bash`,
 * `bash <<EOF`, `base64 -d | bash` all reduce to it. Approving it
 * persistently would approve EVERY future script fed to that shell
 * (Qodo PR #950 R6), so these statements are never allowlist-matchable
 * and never offered a persistent approval — only run-once.
 */
export function isStdinFedShellStatement(stmt: string): boolean {
  return /^(?:[A-Za-z_]\w*=\S*\s+)*(?:(?:sudo|nohup|env|command|builtin|exec)\s+)*(?:(?:timeout|nice)\s+(?:-\S+\s+)?(?:\S+\s+)?)*(?:\S*\/)?(?:ba|da|z|k|c|tc|fi)?sh(?:\s+-\w+)*\s*$/.test(
    stmt.trim(),
  );
}

/** SHA-256 of a command (or entry) — hash prefixes for logs, never the text itself. */
export function dangerousCommandHash(command: string): string {
  return createHash("sha256").update(command).digest("hex");
}

export interface DangerousAllowlistMatch {
  /** The matched settings entry (may contain wildcards). */
  entry: string;
  /** Which settings file provided it. */
  source: "project" | "global";
}

/** Matched allowlist entry for the full command text, or null.
 * Project settings take precedence over global; no env layer (deliberate:
 * ambient env must not silently approve dangerous commands).
 *
 * Security (Qodo PR #950 R3): a project settings file that is TRACKED by git
 * is not trusted for the allowlist — a cloned repo must not be able to ship
 * `{"dangerous_command_allowlist": ["*"]}` and disable the gate for everyone
 * who opens it. Only the user's own untracked project file (or the global
 * file on their machine) can approve commands. */
const trackedSettingsCache = new Map<string, ProjectSettingsTrust>();
/** Expiry for cached "tracked" verdicts (Qodo PR #950 R9): the tracked
 * verdict used to be cached forever, so a user who untracks the file
 * (`git rm --cached`) kept losing project approvals until process restart.
 * A TTL keeps the anti-clone property (a fresh process always runs the git
 * check; a clone's shipped tracked settings are rejected on first sight)
 * while honoring untracking within seconds. The unsafe direction —
 * untracked — is still NEVER cached. */
const trackedVerdictExpires = new Map<string, number>();
let trackedVerdictTtlMs = 30_000;
/** Test hook: shrink the tracked-verdict TTL so expiry is testable. */
export function setTrackedVerdictTtlForTests(ms: number): void {
  trackedVerdictTtlMs = ms;
}
/** Test hook: clear the tracked-settings cache (git state changed under us). */
export function clearTrackedSettingsCache(): void {
  trackedSettingsCache.clear();
  trackedSettingsWarned.clear();
  trackedVerdictExpires.clear();
}
const trackedSettingsWarned = new Set<string>();
/** Current trust verdict for the project settings file (public for the
 * approval writer: it must know WHERE a new entry can be stored — a
 * tracked/untrusted project file would swallow approvals that lookup
 * can never match, Qodo PR #950 R7). */
export function projectSettingsTrust(cwd: string): ProjectSettingsTrust {
  const file = getSettingsPath(cwd);
  const cached = trackedSettingsCache.get(file);
  if (cached !== undefined) {
    const expires = trackedVerdictExpires.get(file);
    if (expires === undefined || expires > Date.now()) return cached;
    // Cached tracked verdict expired — re-check (the user may have
    // untracked the file; Qodo PR #950 R9).
    trackedSettingsCache.delete(file);
    trackedVerdictExpires.delete(file);
  }
  const verdict = projectSettingsTrustUncached(cwd, file);
  // Cache the confirmed-untrusted (tracked) verdict WITH a TTL — it can
  // only become more true, but the user may legitimately untrack the file,
  // and that must recover without a process restart (R9). A trusted
  // (untracked) verdict is re-checked on EVERY use so a later `git pull` /
  // checkout that starts tracking the file is caught on the very next
  // check, not for the life of the process (Qodo PR #950 R5). An "unknown"
  // verdict (git failed transiently) is never cached — the next check
  // retries git (R7). Per-command batching (one git exec per gate
  // evaluation, not per statement) lives in loadDangerousAllowlists — the
  // per-CALL re-check semantics stay intact.
  if (verdict === "tracked") {
    trackedSettingsCache.set(file, verdict);
    trackedVerdictExpires.set(file, Date.now() + trackedVerdictTtlMs);
  }
  return verdict;
}
function projectSettingsUntracked(cwd: string): boolean {
  // Fail closed on "unknown": an unverifiable file is treated as untrusted
  // for THIS check (global entries still work); the verdict is not cached,
  // so the next check retries git.
  return projectSettingsTrust(cwd) === "untracked";
}
/** Trust verdict for a project settings file:
 * - "untracked" — CONFIRMED trustable (git exit 1, or no repo here): the
 *   file is not tracked, so it cannot have shipped with a clone.
 * - "tracked" — CONFIRMED untrusted (git listed it, or the path traverses
 *   a symlink): a cloned repo may have shipped it.
 * - "unknown" — git failed for an unrelated reason (missing binary,
 *   timeout, dubious ownership, locked index, cwd gone). Treated as
 *   untrusted for the CURRENT check but NEVER cached — the next check
 *   retries (Qodo PR #950 R7: a transient failure must not freeze the
 *   verdict for the life of the process). */
type ProjectSettingsTrust = "untracked" | "tracked" | "unknown";

function projectSettingsTrustUncached(cwd: string, file: string): ProjectSettingsTrust {
  // A settings path reached through a SYMLINK is not trustable (Qodo PR
  // #950 R6): a repo can track `.pi` as a symlink to its root and ship a
  // `*`-allowlist at the target — `git ls-files` misses the lexical path
  // while the settings loader follows the link. lstat (no follow) catches
  // both a symlinked settings file and a symlinked `.pi` dir without
  // false-positiving on symlinked session cwds (/tmp vs /private/tmp).
  // Each lstat is guarded SEPARATELY (Qodo PR #950 R9): a single try around
  // both made a MISSING settings file discard the already-read `.pi` dir
  // verdict — the first approval through a symlinked `.pi` then wrote an
  // entry the next lookup (file now existing) would reject as untrusted.
  const dirLstat = (() => { try { return lstatSync(path.dirname(file)); } catch { return null; } })();
  const fileLstat = (() => { try { return lstatSync(file); } catch { return null; } })();
  if ((dirLstat && dirLstat.isSymbolicLink()) || (fileLstat && fileLstat.isSymbolicLink())) {
    enfLog.warn("dangerous_allowlist_settings_symlink", {
      file,
      reason: "settings path traverses a symlink — not trusted for dangerous-command approvals",
    });
    return "tracked"; // structural, not transient — cacheable untrusted
  }
  // Run git from a directory that exists: `path.dirname(file)` may not
  // exist yet on a first-ever approval (Qodo PR #950 R7 — running from a
  // missing cwd threw ENOENT, which fail-closed AND cached, freezing the
  // verdict even after the approval created the file).
  let gitCwd = path.dirname(file);
  try {
    lstatSync(gitCwd);
  } catch {
    gitCwd = cwd;
  }
  try {
    const out = execFileSync(
      "git",
      ["ls-files", "--error-unmatch", file],
      { cwd: gitCwd, encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    if (out) {
      if (!trackedSettingsWarned.has(file)) {
        trackedSettingsWarned.add(file);
        enfLog.warn("dangerous_allowlist_project_file_tracked", {
          file,
          reason: "tracked settings files are not trusted for dangerous-command approvals",
        });
      }
      return "tracked";
    }
    return "untracked";
  } catch (e: unknown) {
    const err = e as { status?: number; stderr?: string };
    // Exit 1 = the file is genuinely not tracked — the normal, trustable case.
    if (err.status === 1) return "untracked";
    // Exit 128 + "not a git repository" = no repo here, so nothing could have
    // been cloned in — trustable. Other 128s (e.g. dubious-ownership refusal)
    // are NOT trustable: an attacker-owned checkout fails exactly like that.
    if (err.status === 128 && /not a git repository/i.test(String(err.stderr ?? ""))) return "untracked";
    // git binary missing, timeout, dubious ownership, locked index, cwd
    // gone — UNKNOWN: untrusted for this check, retried on the next one.
    enfLog.warn("dangerous_allowlist_git_check_failed", {
      file,
      status: err.status,
      fallback: "untrusted (not cached — next check retries)",
    });
    return "unknown";
  }
}

/** Allowlists loaded once per gate evaluation (Qodo PR #950 R8 perf:
 * loading per STATEMENT ran one synchronous git exec + two file reads per
 * statement — now one per command). `project` is null when the project
 * settings file is not trustable (tracked/symlinked/unverifiable). */
export interface DangerousAllowlists {
  project: string[] | null;
  global: string[];
}

/** Load both allowlist scopes for a cwd — ONE trust check + ONE read per
 * scope. Call this once per command and match statements against the
 * result via matchDangerousAllowlist. */
export function loadDangerousAllowlists(cwd: string): DangerousAllowlists {
  const project = projectSettingsUntracked(cwd)
    ? (loadProjectSettings(cwd).dangerous_command_allowlist ?? [])
    : null;
  const global = loadGlobalSettings().dangerous_command_allowlist ?? [];
  return { project, global };
}

/** Match one normalized statement against pre-loaded allowlists (no git,
 * no file I/O — safe to call per statement). */
export function matchDangerousAllowlist(lists: DangerousAllowlists, command: string): DangerousAllowlistMatch | null {
  // Defense in depth (Qodo PR #950 R6): a stdin-fed shell statement (`bash`,
  // `sh -s`, ...) executes whatever script is fed to it — even a hand-added
  // settings entry can never approve it. The gate already refuses to offer
  // persistent approval for such statements.
  if (isStdinFedShellStatement(command)) return null;
  if (lists.project) {
    const p = lists.project.find((e) => allowlistGlobToRegExp(e).test(command));
    if (p) return { entry: p, source: "project" };
  }
  const g = lists.global.find((e) => allowlistGlobToRegExp(e).test(command));
  return g ? { entry: g, source: "global" } : null;
}

export function findDangerousAllowlistEntry(cwd: string, command: string): DangerousAllowlistMatch | null {
  // Per-CALL semantics (unchanged since R5): every call re-checks trust, so
  // a `git pull` that starts tracking the project file is caught on the
  // very next call. The gate uses the batched loadDangerousAllowlists path
  // for per-command efficiency; direct callers keep the strict behavior.
  return matchDangerousAllowlist(loadDangerousAllowlists(cwd), command);
}

/** Result of persisting a dangerous-command approval. `scope` is where the
 * entry ACTUALLY landed — the caller logs/notifies it, and "global" means
 * the project file was CONFIRMED untrustworthy (git-tracked or symlinked)
 * so the approval was stored in the user's global settings instead, where
 * lookup will honor it (Qodo PR #950 R7/R8). A `trust_unknown` failure is
 * deliberately NOT persisted anywhere: a transient git failure in one
 * project must not mint a machine-wide approval (R8) — the approval is
 * one-time and the user can retry once git answers. */
export type DangerousAllowlistWriteResult =
  | { ok: true; scope: "project" | "global"; file: string }
  | { ok: false; reason: "corrupt" | "write_failed" | "trust_unknown" | "project_untrusted"; file: string };

/** Append the exact command text (glob metachars escaped, so the entry stays
 * literal) to the settings file. Fail-soft (returns a result, never throws).
 * A mkdir-based lock serializes writers so concurrent approvals cannot drop
 * each other (read-merge-write race).
 *
 * Scope is EXPLICIT (user request, PR #950 R8): the prompt offers "this
 * project" and "everywhere" as distinct choices. `scope: "project"` writes
 * the project file and FAILS when it is not trustable (git-tracked or
 * symlinked — the caller must not have offered the option, but fail safe
 * anyway). `scope: "global"` writes the user's machine-wide file — the
 * caller only offers it as an explicit choice, never a silent fallback.
 * When trust is UNKNOWN (git failed transiently) a project write is
 * refused: run-once only (R8) — a transient failure must not mint a
 * machine-wide approval either. */
export function addDangerousAllowlistEntry(
  cwd: string,
  command: string,
  scope: "project" | "global" = "project",
): DangerousAllowlistWriteResult {
  const trust = projectSettingsTrust(cwd);
  if (scope === "project") {
    if (trust === "tracked") {
      // The option should not have been offered — refuse the write rather
      // than silently redirecting scope (fail safe, no silent fallback).
      enfLog.warn("dangerous_allowlist_project_untrusted_refused", {
        trust,
        reason: "project settings file is not trustable — project-scope approval refused",
      });
      return { ok: false, reason: "project_untrusted", file: getSettingsPath(cwd) };
    }
    if (trust === "unknown") {
      // Never persist on an unverifiable state (Qodo PR #950 R8): fail the
      // write; the gate tells the user this approval is one-time until git
      // can verify the project file.
      enfLog.warn("dangerous_allowlist_trust_unknown", {
        reason: "project settings trust could not be verified (git check failed) — approval is one-time",
      });
      return { ok: false, reason: "trust_unknown", file: getSettingsPath(cwd) };
    }
  }
  const file = scope === "project" ? getSettingsPath(cwd) : getGlobalSettingsPath();
  const lockDir = `${file}.lock`;
  const entry = command.replace(/[\\*?]/g, (c) => `\\${c}`);
  let locked = false;
  try {
    // The lock dir's parent may not exist yet on a first-ever write
    mkdirSync(path.dirname(file), { recursive: true });
    for (let attempt = 0; attempt < 10 && !locked; attempt++) {
      try {
        mkdirSync(lockDir);
        locked = true;
      } catch {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); // 50ms backoff
      }
    }
    const data = readSettingsFile(file);
    if (data === null) {
      // Corrupt/unparseable settings file — NEVER overwrite it with just the
      // new entry: earlier approvals and every other setting would be lost
      // (Qodo PR #950 R2). Bail fail-soft and let the user repair the file.
      enfLog.warn("dangerous_allowlist_settings_unreadable", {
        file,
        hashPrefix: dangerousCommandHash(command).slice(0, 12),
      });
      return { ok: false, reason: "corrupt", file };
    }
    const list = Array.isArray(data.dangerous_command_allowlist)
      ? data.dangerous_command_allowlist.filter((e: unknown): e is string => typeof e === "string" && e.length > 0)
      : [];
    if (!list.includes(entry)) list.push(entry);
    data.dangerous_command_allowlist = list;
    writeSettingsFile(file, data);
    return { ok: true, scope, file };
  } catch (error: any) {
    // Hash prefix + path identify the affected approval without copying
    // command text into global logs (Qodo PR #950).
    enfLog.warn("dangerous_allowlist_write_failed", {
      reason: String(error?.message ?? error).slice(0, 200),
      hashPrefix: dangerousCommandHash(command).slice(0, 12),
      file,
    });
    return { ok: false, reason: "write_failed", file };
  } finally {
    if (locked) {
      try {
        rmdirSync(lockDir);
      } catch {
        // stale lock — the next writer's retry loop handles it
      }
    }
  }
}

/**
 * Check if a statement is a read-only command with no dangerous subshells.
 * Returns true if the DANGEROUS check should be skipped for this statement.
 */
export function isReadOnlyStatement(stmt: string): boolean {
  // Strip transparent wrapper prefixes (rtk/env/timeout/nice/nohup/command/
  // builtin/exec) and VAR=value assignments so `rtk grep` gets the same
  // read-only pass as `grep` (issue #947).
  const stripped = stmt.replace(READ_ONLY_WRAPPER_PREFIX_RE, "");
  const baseCmd = stripped.split(/\s/)[0]?.replace(/^.*\//, ""); // strip path prefix
  if (!baseCmd || !READ_ONLY_COMMANDS.has(baseCmd)) return false;

  // Check subshells for dangerous content
  const subshells = extractSubshells(stmt);
  // Evaluate extracted content against DANGEROUS as raw strings — catches nested subshells too
  return !subshells.some((sub) => DANGEROUS.some((p) => p.test(sub)));
}

/** Pattern matching direct recursive rm commands (subset of DANGEROUS patterns). */
const RM_PATTERN = /\brm\s+(?:-[a-zA-Z]+\s+)*(-[a-zA-Z]*r[a-zA-Z]*|--recursive)/i;

/** Tokenize the target paths of an rm command found in `stmt` (flags, the
 *  `--` separator, and shell redirections skipped; surrounding quotes
 *  stripped). Returns null when no rm token is present. Shared by
 *  isRmInProjectTmp and relativeRecursiveRmTarget (issue #963). */
interface RmPathToken {
  value: string;
  /** Quote character that surrounded the token, if any. SINGLE quotes make
   *  the content fully literal; DOUBLE quotes still expand $VAR and
   *  backticks while suppressing tilde expansion and globbing (Qodo PR
   *  #964 round 3 — a boolean quoted flag conflated the two). */
  quote: "'" | '"' | null;
}

/** Whitespace tokenizer that keeps quoted spans together: `rm -rf "/abs/My
 *  Dir"` is ONE path token, not the fragments `"/abs/My` and `Dir"` (Qodo
 *  PR #964 round 3). A quote character always starts a new token —
 *  mid-token quotes (`--flag="x"`) split, which is conservative for rm
 *  argument parsing. */
function splitRmTokens(stmt: string): RmPathToken[] {
  const out: RmPathToken[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  const push = (q: "'" | '"' | null) => {
    if (cur) out.push({ value: cur, quote: q });
    cur = "";
  };
  for (const ch of stmt.trim()) {
    if (quote) {
      if (ch === quote) {
        push(quote);
        quote = null;
      } else cur += ch;
    } else if (ch === '"' || ch === "'") {
      push(null);
      quote = ch;
    } else if (/\s/.test(ch)) {
      push(null);
    } else cur += ch;
  }
  push(quote); // unterminated quote — keep the residue as its own token
  return out;
}

function parseRmPathTokens(stmt: string): RmPathToken[] | null {
  const paths: RmPathToken[] = [];
  let pastSeparator = false;
  let pastRm = false;
  let skipNext = false;

  for (const token of splitRmTokens(stmt)) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (!pastRm) {
      if (token.value === "rm" || token.value.endsWith("/rm")) pastRm = true;
      continue;
    }
    if (token.value === "--" && token.quote === null) {
      pastSeparator = true;
      continue;
    }
    if (!pastSeparator && token.value.startsWith("-") && token.quote === null) continue;
    // Skip shell redirections — handle both joined (2>/dev/null) and spaced (2> /dev/null)
    if (/^[0-9]*>{1,2}|^&>|^[0-9]*</.test(token.value)) {
      // If the token is ONLY the operator (no target attached), skip the next token too
      if (/^(?:[0-9]*>{1,2}|&>|[0-9]*<)$/.test(token.value)) {
        skipNext = true;
      }
      continue;
    }
    paths.push(token);
  }

  return pastRm ? paths : null;
}

/** Leading wrapper prefixes that may precede a direct `rm` invocation
 *  (issue #963). Same family as the bare-shell wrapper alternation in the
 *  DANGEROUS patterns, but INCLUDES sudo: the absolute-path requirement
 *  applies to `sudo rm -rf rel` just as much as to bare `rm -rf rel`. */
// The `--` end-of-options marker is its own alternative that consumes NO
// value: the old `-.S+` matched `--` and then its optional value slot ate
// the command itself (`env -- rm -rf x` left `-rf x` with no command token,
// evading the gate — Qodo PR #964).
const RM_LEADING_WRAPPERS_RE =
  /^\s*(?:\S+=\S*\s+|sudo(?:\s+(?:--\S+|--|-(?!-)\S+(?:\s+\S+)?))*\s+|rtk(?:\s+(?:--\S+|-(?!-)\S+))*\s+|(?:command|builtin|exec)\s+|env(?:\s+(?:--\S+|--|-(?!-)\S+(?:\s+\S+)?|\S+=\S*))*\s+|timeout\s+(?:(?:--\S+|--|-(?!-)\S+(?:\s+\S+)?)\s+)*\S+\s+|nice(?:\s+(?:--\S+|--|-(?!-)\S+(?:\s+\S+)?))*\s+|nohup\s+)+/;

/**
 * First non-absolute target of a direct (optionally wrapped) recursive rm
 * statement, or null (issue #963). "Absolute" = starts with `/` or `~`.
 *
 * find -exec / xargs rm variants return null — their targets come from find
 * output / stdin, not statement text. Recursive rm with a relative target
 * must be blocked: a persistent "always allow" approval stores the
 * statement text, so a relative target would approve the identical text in
 * ANY directory; an absolute path binds the approval to exactly one folder.
 */
export function relativeRecursiveRmTarget(stmt: string): string | null {
  if (!RM_PATTERN.test(stmt)) return null;
  // rm must be the COMMAND, not a word inside another command (Qodo PR
  // #964): `git rm -r --cached build` and `git commit -m "chore: rm -rf
  // build dir"` previously matched because the tokenizer scanned for `rm`
  // anywhere — hard-blocking git subcommands and commit messages that the
  // dangerous-prompt path already handles.
  const stripped = stmt.replace(/^\(\s*/, "").replace(RM_LEADING_WRAPPERS_RE, "");
  const firstWord = stripped.trim().split(/\s+/)[0];
  if (firstWord !== "rm" && !firstWord?.endsWith("/rm")) return null;
  // find -exec rm / xargs rm carry their targets from find output / stdin.
  // COMMAND-POSITION only: `rm -rf find` (a directory named find) must stay
  // blocked (Qodo PR #964) — the old word-boundary test exempted it.
  if (firstWord === "find" || /(?:^|\|\s*)xargs\s+rm\b/.test(stmt) || /\bfind\b[^|;]*-exec\b/.test(stmt)) {
    return null;
  }
  const paths = parseRmPathTokens(stripped);
  if (!paths || paths.length === 0) return null;
  for (const p of paths) {
    const t = p.value;
    // Project temp dir by variable: deterministic per-cwd, expanded and
    // validated by isRmInProjectTmp downstream (Qodo PR #964 — the gate
    // must not block the documented ${PROJECT_TMP_DIR} cleanup pattern).
    // ANCHORED (Qodo PR #964 round 3): the variable must END here or be
    // followed by / — a prefix match let $PROJECT_TMP_DIR_BACKUP skip the
    // gate. The variable expands unquoted AND inside double quotes.
    const projTmpVar = /^\$\{PROJECT_TMP_DIR\}(?:$|\/)|^\$PROJECT_TMP_DIR(?![\w$])(?:$|\/)/.test(t);
    // Traversal and non-literal suffixes drop the exemption (Qodo PR #964
    // rounds 4-5): a legit temp path never needs ".." (the variable already
    // points at the tmp root), and its suffix must be LITERAL —
    // "${PROJECT_TMP_DIR}/$TARGET" with TARGET=../../important expanded
    // past both the gate and the tmp check while still looking exempt.
    const suffix = t
      .replace(/^\$\{PROJECT_TMP_DIR\}/, "")
      .replace(/^\$PROJECT_TMP_DIR(?![\w$])/, "");
    const suffixLiteral = !/[$`*?[\]]/.test(suffix) && !t.includes("..");
    if (projTmpVar && p.quote !== "'" && suffixLiteral) continue;
    if (p.quote === "'") {
      // Single quotes: fully literal. A quoted tilde does NOT expand (it
      // is a relative path), and $/glob chars are inert — only a quoted
      // absolute path binds to one folder.
      if (t.startsWith("/")) continue;
      return t;
    }
    if (p.quote === '"') {
      // Double quotes: tilde does NOT expand (relative → block), but $VAR
      // and backticks DO — an approval for "/home/$USER/build" must not
      // bind. Globs are inert inside quotes, so only / $ ` matter.
      if (t.startsWith("~")) return t;
      if (/[$`]/.test(t)) return t;
      if (t.startsWith("/")) continue;
      return t;
    }
    // Unquoted: tilde expands to $HOME (absolute); any expansion or glob
    // char makes the target non-literal — an approval for
    // /home/$USER/build or /home/*/build must not bind to varying
    // directories (Qodo PR #964).
    if (t.startsWith("~")) continue;
    if (/[$`*?[\]]/.test(t)) return t;
    if (t.startsWith("/")) continue;
    return t;
  }
  return null;
}

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

  // Parse arguments: flags, -- separator, redirections (shared tokenizer)
  const tokens = parseRmPathTokens(stmt);

  // Guard against vacuous truth — if no paths extracted, don't silently allow
  if (!tokens || tokens.length === 0) return false;
  const paths = tokens.map((t) => t.value);

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
 * ── Real git-invocation detection (single source of truth) ─────────────────
 *
 * Shared by isRealGitCommitOrPush (git-expert-only guard), injectSignoff (DCO),
 * and checkGitProtection's sub-detection in enforcement.ts. The constructions
 * must never drift: a divergence is either a guard bypass or a corrupted
 * injection.
 *
 * Wrapper prefixes: sudo/env (incl. argument-taking flags), VAR=value
 * assignments, command/builtin/exec — AND rtk. The user-level rtk extension
 * rewrites every bash command through `rtk rewrite` BEFORE enforcement
 * evaluates it (`git commit -m x` arrives as `rtk git commit -m x`), so
 * without the rtk alternative every wrapped invocation is invisible to the
 * guards (live incident: the git-expert-only commit guard never fired on a
 * direct orchestrator commit). Boundary includes backtick because unescaped
 * backticks are command substitution and DO execute git.
 *
 * Qodo #8 (PR #916): boundaries also cover shell condition keywords
 * (if/while/until/!), negation, and exec-wrappers that take arguments
 * (timeout/nice/nohup/xargs/time), and an opening quote after `bash -c` /
 * `sh -c` / `eval` opens a nested command position — `timeout 60 git push`,
 * `if git commit ...`, `time git commit`, and `bash -c "git commit"` are all
 * real invocations the old boundary set missed.
 *
 * Qodo round 2 (PR #916): the shell alternative accepts ANY c-containing
 * short-flag cluster (`bash -lc`, `sh -ec`, `bash -xc`) plus long flags
 * (`bash --login -c`); and quoted PROSE is masked before matching
 * (maskQuotedProse) so `!`/`if`/`while` inside a `-m` message or an echoed
 * string can never look like a command boundary.
 */
const GIT_BOUNDARY_SRC =
  /(?:^|[;&|\n(){`]|!|&&|\|\||\bthen\b|\bdo\b|\belse\b|\belif\b|\bif\b|\bwhile\b|\buntil\b|(?:\b(?:bash|sh|zsh|dash|ksh)\s+(?:-{1,2}[a-zA-Z][a-zA-Z-]*\s+)*-[a-zA-Z]*c[a-zA-Z]*\s*|\beval\s*)(?:["'`]\s*)?)\s*/.source;
const GIT_WRAPPER_SRC = /(?:sudo|env|timeout|nice|nohup|xargs|time)(?:\s+(?!git\b)\S+)*\s+/.source;
const GIT_ASSIGN_SRC = /[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+/.source;
const GIT_WRAP_SRC = /(?:command|builtin|exec)\s+/.source;
const GIT_RTK_SRC = /rtk(?:\s+-\S+)*\s+/.source;
const GIT_PREFIX_SRC = `(?:${GIT_WRAPPER_SRC}|${GIT_ASSIGN_SRC}|${GIT_WRAP_SRC}|${GIT_RTK_SRC})*`;
const GIT_EXE_SRC = /(?:\S*\/)?git\b/.source;
const GIT_FLAGS_SRC = /(?:\s+(?:-[a-zA-Z]\s+\S*|-\S+))*/.source;

/** Prefix that opens a nested command string: `bash -lc "..."`, `sh -c '...'`, `eval "..."`. */
const SHELL_C_PREFIX_RE =
  /(?:\b(?:bash|sh|zsh|dash|ksh)\s+(?:-{1,2}[a-zA-Z][a-zA-Z-]*\s+)*-[a-zA-Z]*c[a-zA-Z]*|\beval)\s*$/;

/**
 * Mask quoted PROSE so it can never look like a command boundary (Qodo
 * rounds 2–4, PR #916). A scanner implementing SHELL quote semantics, not a
 * plain regex and not heuristics:
 * - a BACKSLASH outside quotes escapes the next character, so `\"` is a
 *   literal and `echo \"; git push; echo \"x\"` still executes git push;
 * - an apostrophe ALWAYS opens a single-quote string outside double quotes
 *   (shell grammar has no contractions — `foo' ; git push main'`
 *   concatenates `foo` with the QUOTED text ` ; git push main`, so the
 *   quoted part is prose, never code). An apostrophe inside a `#` comment
 *   is irrelevant because comment tails are blanked first;
 * - a `#` at a word start begins a comment — blanked to end of line so its
 *   quotes cannot pair with code;
 * - inside a quoted span only COMMAND SUBSTITUTION (`$(...)`, backticks)
 *   executes, so a span is blanked EXCEPT its substitution regions —
 *   `echo "if git commit fails $(date)"` keeps only `$(date)` visible;
 * - a span that directly follows `bash -c`/`sh -c`/`eval` is a nested
 *   command string and stays fully visible;
 * - an UNTERMINATED span is a shell syntax error — nothing executes — so it
 *   is blanked entirely.
 * The result is LENGTH-PRESERVING so match indices on the masked text are
 * valid on the original string.
 */
function maskQuotedProse(command: string): string {
  const out = command.split("");
  let maskedSpans = 0;
  /** Sentinel written in place of a substitution's CLOSING delimiter (`)` or
   *  backtick) in the masked output. It lets consumers distinguish the
   *  delimiter from a quoted `)` inside the substitution's content — both are
   * restored verbatim, but only the delimiter becomes SENTINEL (Qodo round
   *  8, PR #916). NUL cannot occur in a real command string. */
  const SUBST_CLOSE_SENTINEL = "\x00";
  const blankRange = (from: number, to: number): void => {
    for (let k = from; k < to; k++) out[k] = " ";
  };
  /** Blank [from, to) except its $(...) and backtick substitution regions,
   *  which are restored verbatim from the original command. The close-paren
   *  scan is QUOTE-AWARE (Qodo round 5, PR #916): a `)` inside a quoted
   *  argument of the substitution (`$(printf ')'; git push main)`) does not
   *  close it — only an unquoted, unescaped paren changes depth. The closing
   *  delimiter itself is restored as SUBST_CLOSE_SENTINEL so downstream
   *  parsers can tell it apart from content parens (Qodo round 8). */
  const blankExceptSubstitutions = (from: number, to: number): void => {
    blankRange(from, to);
    let k = from;
    while (k < to) {
      const c = command[k]!;
      if (c === "$" && command[k + 1] === "(") {
        let depth = 1;
        let m = k + 2;
        let q: string | null = null;
        const closers: number[] = [];
        while (m < to && depth > 0) {
          const d = command[m]!;
          if (q) {
            // Inside quotes: only the matching quote closes (double quotes
            // process backslash escapes; single quotes do not).
            if (q === '"' && d === "\\") {
              m += 2;
              continue;
            }
            if (d === q) q = null;
            m++;
            continue;
          }
          if (d === "'" || d === '"') {
            q = d;
            m++;
            continue;
          }
          if (d === "\\") {
            m += 2;
            continue;
          }
          if (d === "(") depth++;
          else if (d === ")") {
            // EVERY unquoted `)` that decrements depth closes a (possibly
            // nested) substitution — outer closer and inner closers alike —
            // so all of them become sentinels (Qodo round 8: a quoted `)`
            // stays live content).
            closers.push(m);
            depth--;
          }
          m++;
        }
        const stop = depth === 0 ? m : to;
        for (let x = k; x < stop; x++) out[x] = command[x]!;
        for (const p of closers) {
          if (p < stop) out[p] = SUBST_CLOSE_SENTINEL;
        }
        k = stop;
        continue;
      }
      if (c === "`") {
        let m = k + 1;
        while (m < to && command[m] !== "`") m++;
        const stop = m < to ? m + 1 : to;
        for (let x = k; x < stop; x++) out[x] = command[x]!;
        if (m < to) out[stop - 1] = SUBST_CLOSE_SENTINEL;
        k = stop;
        continue;
      }
      k++;
    }
  };
  let i = 0;
  while (i < command.length) {
    const ch = command[i]!;
    // Comment tail: `#` at a word start (${...} and =# forms excluded) is a
    // comment — blank to end of line, quotes inside cannot pair with code.
    if (ch === "#" && (i === 0 || /[\s(;&|`]/.test(command[i - 1]!))) {
      let j = i;
      while (j < command.length && command[j] !== "\n") j++;
      blankRange(i, j);
      maskedSpans++;
      i = j;
      continue;
    }
    // A backslash outside quotes escapes the next char — it can never open
    // a span (handles \\" and \\').
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      let closed = false;
      while (j < command.length) {
        const c = command[j]!;
        // Inside double quotes a backslash escapes the next char (\" and \\).
        // Inside single quotes a backslash is literal; only ' terminates.
        if (quote === '"' && c === "\\") {
          j += 2;
          continue;
        }
        if (c === quote) {
          closed = true;
          break;
        }
        j++;
      }
      const end = closed ? j + 1 : command.length;
      if (closed && SHELL_C_PREFIX_RE.test(command.slice(0, i))) {
        // Nested command string — keep fully visible for the boundary regex.
      } else {
        // Prose span (or unterminated = syntax error, nothing executes):
        // blank it except command substitutions, which still execute.
        blankExceptSubstitutions(i, end);
        maskedSpans++;
      }
      i = end;
      continue;
    }
    i++;
  }
  if (maskedSpans > 0) enfLog.debug("maskQuotedProse", "masked", maskedSpans, "chars", command.length);
  return out.join("");
}

/** Regex matching a REAL `git <sub>` invocation at a shell command position. */
export function realGitSubRegex(sub: string, capture = false): RegExp {
  const body = `${GIT_BOUNDARY_SRC}${GIT_PREFIX_SRC}${GIT_EXE_SRC}${GIT_FLAGS_SRC}\\s+${sub}\\b`;
  const re = new RegExp(capture ? `(${body})` : body);
  enfLog.debug("realGitSubRegex built", sub, `capture=${capture}`);
  return re;
}

/**
 * True when the command really invokes `git <sub>` — command position only,
 * any wrapper prefix (sudo/env/assignments/command/builtin/exec/rtk),
 * heredoc bodies stripped. Replaces the old loose matcher, which matched
 * `git ... <sub>` ANYWHERE, false-positiving on sub-command names inside -m
 * messages ("git commit -m 'add sites'" tripped the git-add checks) and in
 * other statements of a compound command ("git log | grep checkout" tripped
 * the use_worktrees checkout block).
 */
export function realGitSub(command: string, sub: string): boolean {
  const result = realGitSubRegex(sub).test(maskQuotedProse(stripHeredocBodies(command)));
  enfLog.debug("realGitSub", sub, result);
  return result;
}

/**
 * Argument regions of every real `git <sub>` invocation: the statement-scoped
 * text after the subcommand, up to the next ; & | or newline — so arguments
 * of OTHER statements in a compound command are never included
 * ("git add f.ts && bash .dev/x.sh" must not treat .dev/x.sh as staged).
 * Regions are raw (quotes intact); consumers inspecting FLAGS must strip
 * quoted spans first (a -m message is not an argument list).
 */
export function gitSubArgRegions(command: string, sub: string): string[] {
  // Boundaries are matched on PROSE-MASKED text (a quoted "Done! git push"
  // must not look like a command position), but the region CONTENT comes
  // from the original string — masking is length-preserving, so match
  // indices on the masked text are valid on the original, and quoted VALUES
  // (pathspecs, "main" refspecs) stay intact for consumers (Qodo round 2,
  // PR #916).
  return subArgSpans(command, sub).map((s) => s.text);
}

/** Argument-region spans of every real `git <sub>` invocation, with start/end
 *  offsets into the heredoc-stripped command and the aligned masked text —
 *  consumers that must distinguish substitution syntax from refspec content
 *  use the masked slice (Qodo round 6, PR #916). */
function subArgSpans(command: string, sub: string): Array<{ start: number; end: number; text: string; maskedText: string; stripped: string; masked: string }> {
  const stripped = stripHeredocBodies(command);
  const masked = maskQuotedProse(stripped);
  const re = new RegExp(
    `${GIT_BOUNDARY_SRC}${GIT_PREFIX_SRC}${GIT_EXE_SRC}${GIT_FLAGS_SRC}\\s+${sub}\\b`,
    "g",
  );
  const spans: Array<{ start: number; end: number; text: string; maskedText: string; stripped: string; masked: string }> = [];
  for (const m of masked.matchAll(re)) {
    const start = (m.index ?? 0) + m[0].length;
    // Boundaries are searched on the MASKED text, so a separator inside a quoted
    // argument is prose, not the end of the invocation: in
    // `git commit -m "message; more message" --author='A <a@b>'` the author
    // option belongs to this commit and must stay inside its region (Qodo, PR
    // #996). Masking is length-preserving, so the offset is valid on the
    // original string and the region content still comes from it.
    const end = masked.slice(start).search(/[;&|\n]/);
    const stop = end === -1 ? stripped.length : start + end;
    spans.push({
      start,
      end: stop,
      text: stripped.slice(start, stop),
      maskedText: masked.slice(start, stop),
      stripped,
      masked,
    });
  }
  enfLog.debug("gitSubArgRegions", sub, `regions=${spans.length}`);
  return spans;
}

/** Remove quoted spans so message CONTENT never looks like arguments. */
export function stripQuotedSpans(s: string): string {
  return s.replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/'[^']*'/g, "''");
}

/** Tokenize a git-add argument region: quote-aware tokens, redirects dropped. */
function gitAddTokens(region: string): string[] {
  // Empty tokens (an unterminated residual quote yields one) carry no
  // pathspec and must not reach consumers (Qodo live battery, PR #916).
  return tokenize(region).filter((t) => t && !/[<>]/.test(t));
}

/** Argument regions of every real `git <sub>` invocation with
 *  command-substitution CLOSING delimiters neutralized (Qodo rounds 6+8,
 *  PR #916): parses the ORIGINAL text (quoted values survive) but blanks
 *  every character the masked text replaced with the substitution-close
 *  sentinel — the `)`/backtick that ENDS a `$(...)`. A `)` inside the
 *  substitution's quoted content (a legal branch-name character, e.g.
 *  `$(git push origin 'foo)')`) is restored verbatim in the masked text
 *  and therefore STAYS, so the ref `foo)` is compared exactly; a `)` in a
 *  top-level quoted span (prose-blanked in the masked text) also stays.
 *  Consumers that TOKENIZE arguments use this instead of
 *  gitSubArgRegions, so a bulk `git add .` inside `$(...)` is not read as
 *  the pathspec `.)` while a quoted `foo)` ref is not truncated. */
export function gitSubParseRegions(command: string, sub: string): string[] {
  return subArgSpans(command, sub).map((s) =>
    s.text
      .split("")
      .map((ch, idx) => (s.maskedText[idx] === "\x00" ? " " : ch))
      .join(""),
  );
}

/** Destination refs of every real `git push` invocation (Qodo #5, PR #916).
 *  Quote-aware tokenization (a quoted "main" is still a refspec), flags and
 *  remote URLs skipped, and each refspec reduced to its DESTINATION side —
 *  `HEAD:main`, `feature:main`, `+main`, `refs/heads/main`, and plain `main`
 *  all yield `main`. Returns the first ref that names a protected branch
 *  (full or suffix match), or null when no push target is protected. */
export function pushTargetsProtectedBranch(command: string, protectedBranches: Iterable<string>): string | null {
  const pbSet = new Set(protectedBranches);
  for (const parseRegion of gitSubParseRegions(command, "push")) {
    // Quoted refspec values ("main", 'release)') survive because the region
    // comes from the ORIGINAL text; live substitution `)`s are already
    // neutralized by gitSubParseRegions (Qodo rounds 5-6, PR #916).
    let pastSep = false;
    for (const token of tokenize(parseRegion)) {
      if (token === "--") {
        pastSep = true;
        continue;
      }
      if (!pastSep && token.startsWith("-")) continue; // flag
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(token)) continue; // remote URL (https://, ssh://)
      // Forced-push leading + is part of the refspec syntax, not the ref.
      const spec = token.startsWith("+") ? token.slice(1) : token;
      const colon = spec.lastIndexOf(":");
      const raw = (colon >= 0 ? spec.slice(colon + 1) : spec).trim();
      if (!raw) continue;
      const dest = raw.replace(/^refs\/heads\//, "");
      if (pbSet.has(dest)) {
        enfLog.debug("pushTargetsProtectedBranch", `protected=${dest}`);
        return dest;
      }
    }
  }
  return null;
}

/**
 * Pathspec tokens of every real `git add` invocation — quote-aware (a quoted
 * path with spaces is one token), flags and redirects excluded, everything
 * after `--` included. Empty when the command stages nothing; null when it
 * invokes no real `git add` at all. Consumers: the gitignore staging guard.
 */
export function gitAddPathspecs(command: string): string[] | null {
  const regions = gitSubParseRegions(command, "add");
  if (regions.length === 0) return null;
  const paths: string[] = [];
  for (const region of regions) {
    let pastSeparator = false;
    for (const token of gitAddTokens(region)) {
      if (token === "--") {
        pastSeparator = true;
        continue;
      }
      if (!pastSeparator && token.startsWith("-")) continue; // flag
      paths.push(token);
    }
  }
  enfLog.debug("gitAddPathspecs", `paths=${paths.length}`);
  return paths;
}

/**
 * Detect a REAL `git <sub>` invocation (sub = "commit" or "push") at a shell
 * command position — NOT a substring inside a heredoc body, string argument,
 * or file path.
 *
 * BUG #3 FIX: the old loose matcher matched the literal text `git ... commit`
 * ANYWHERE, so writing a file whose CONTENT mentions "git commit" (heredoc body), an
 * echo/string arg like `echo 'run git commit later'`, or a path like
 * `node "/tmp/git commit x.mjs"` wrongly triggered the commit/push guard.
 * This helper narrows detection to genuine invocations by (1) stripping
 * heredoc bodies and (2) requiring `git` at a command boundary (start, or
 * after ; && || | & newline ( { backtick or control-flow keywords).
 *
 * Security note: we DO NOT attempt full shell quote parsing. We block
 * conservatively — any `git <flags> <sub>` at a command boundary in the
 * (heredoc-stripped) command still blocks. This narrows false-positives
 * without opening a bypass: a real `git commit`/`git push` cannot avoid
 * appearing at a command boundary.
 */
export function isRealGitCommitOrPush(command: string): boolean {
  // Strip heredoc bodies so file CONTENT that mentions "git commit" does not count,
  // and mask quoted prose so "if git commit" inside a -m message does not either.
  const stripped = maskQuotedProse(stripHeredocBodies(command));
  for (const sub of ["commit", "push"]) {
    if (realGitSubRegex(sub).test(stripped)) {
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
  // Shared command-position matcher (rtk/wrapper aware) — must stay in lockstep
  // with isRealGitCommitOrPush so a guarded invocation is always an injectable one.
  const commitRe = realGitSubRegex("commit", true);

  // Pattern A: echo/printf "..." | git commit -F -  (real invocation after last pipe).
  // Matching runs on PROSE-MASKED text so a `git commit` mention inside the
  // echoed string cannot absorb the signoff (Qodo round 3, PR #916); the
  // splice uses the masked match's index, valid on the raw string because
  // masking is length-preserving.
  const pipeIdx = command.lastIndexOf("|");
  if (pipeIdx !== -1) {
    const echoPart = command.slice(0, pipeIdx);
    const gitPart = command.slice(pipeIdx);
    const maskedGit = maskQuotedProse(gitPart);
    if (/git\s+commit\s+.*-F\s*-/.test(maskedGit)) {
      if (SIGNOFF_RE.test(gitPart) || SHORT_S_RE.test(gitPart)) return command;
      const mA = commitRe.exec(maskedGit);
      if (!mA) return command;
      enfLog.debug("injectSignoff", "pattern A (piped git commit -F -)");
      const cutA = pipeIdx + mA.index + mA[1]!.length;
      return command.slice(0, cutA) + " --signoff" + command.slice(cutA);
    }
  }

  // Pattern B: bare / inline git commit (no message pipe) — matched on the
  // masked text so prose mentions (echo "if git commit" && git commit -m x)
  // cannot take the injection; spliced at the masked index (length-preserving).
  const masked = maskQuotedProse(command);
  const m = commitRe.exec(masked);
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
  // Splice at the masked match position — a raw replace could pick a prose
  // mention instead of the real invocation (Qodo round 3, PR #916).
  const cut = m.index + m[1]!.length;
  return command.slice(0, cut) + " --signoff" + command.slice(cut);
}

/** Detect git add --force / -f (including combined short options like -fn).
 *  Respects -- end-of-options marker and shell separators (&&, ;, |, ||). */
export function hasGitAddForce(command: string): boolean {
  // Statement-scoped and invocation-scoped: a `-f` in another statement
  // (rm -f) or inside a -m message ("git commit -m 'add -f flag'") is not a
  // `git add --force`.
  for (const region of gitSubParseRegions(command, "add")) {
    for (const token of gitAddTokens(region)) {
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
  // Statement-scoped: only the arguments of a REAL `git add` invocation count.
  // The old loose match captured across statements and into -m message text
  // ("git commit -m 'add .'" wrongly counted as a bulk add).
  for (const region of gitSubParseRegions(command, "add")) {
    for (const token of gitAddTokens(region)) {
      if (token === "--") break; // Everything after -- is a pathspec
      if (token === "." || token === "-A" || token === "--all") return true;
    }
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

// Trailer-shaped line: `Token:` at line start (real newline, literal \n
// escape, or command start), then the PI trailer identity. Anchoring to the
// line start keeps mid-sentence prose and unrelated compound-command parts
// untouched (Qodo 988d3a68) — only an actual trailer line is rewritten.
const unexpandedTrailerLine = /(^|\n|\\n|-m\s+['"])([ \t]*[A-Za-z][A-Za-z0-9-]*:[ \t]*)PI \(\$PI_MODEL\)/g;

/** #932: an agent may write the commit trailer with the literal `$PI_MODEL`
 *  (typically inside a quoted heredoc, where the shell cannot expand it).
 *  Rewrite the trailer identity to the resolved model id before the commit
 *  runs. Returns the fixed command, or null when nothing needed fixing.
 *  Scoped to `git commit` commands and to trailer-shaped lines only, so
 *  commit-message prose that legitimately mentions `$PI_MODEL` — bare or
 *  mid-sentence — and unrelated parts of compound commands are untouched. */
export function fixUnexpandedCommitTrailer(command: string, modelId: string): string | null {
	if (!command.includes("$PI_MODEL")) return null;
	if (!/\bgit\s+commit\b/.test(command)) return null;
	const fixed = command.replace(unexpandedTrailerLine, `$1$2PI (${modelId})`);
	return fixed === command ? null : fixed;
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

/** Diagnostic for a FAILED edit/write skipping file_modified triggers
 *  (#940, Qodo 2addbfc4): nothing was modified, so file-pattern rules must
 *  not fire. Logs at debug level itself (Qodo ea636782 — logging
 *  requirements apply to helpers too) and returns the message for tests. */
export function failedFileEditSkipMessage(toolName: string, path: string): string {
  const msg = `enforcement: failed ${toolName} (path=${path}) — skipping file_modified triggers, nothing was modified`;
  enfLog.debug(msg);
  return msg;
}
