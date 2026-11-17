/**
 * Skill maintenance (issue #1074).
 *
 * Skills are effectively write-once: `skill-creator` makes one and dreaming may
 * promote another, but nothing patches a skill that has drifted. Skill maintenance
 * closes that gap without spending a model call:
 *
 * - a skill we maintain carries `skill-maintenance: auto` in its frontmatter;
 * - a write/edit guard lets an agent patch a skill only when it is MARKED and its
 *   real path sits under `<project>/.pi/skills/` — shipped package skills,
 *   user-global skills, third-party skills and unmarked project skills are refused;
 * - when a skill we used this turn fails, the agent is steered mid-turn to fix it;
 * - after the turn, one line reports what changed, and every write is recorded in
 *   `.pi/data/skill-review.jsonl` as it happens.
 *
 * Ownership is decided by real path, never by prefix string: a symlink inside
 * `.pi/skills/` resolves elsewhere, and that file is not ours.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../shared/logger.js";
import { fileLog } from "../shared/file-logger.js";
import { getProjectDataDir, resolveMainCheckoutRoot } from "./utils.js";
import { skipToCommandWord } from "./git-helpers.js";

const log = createLogger("skill-maintenance");

/** Frontmatter flag that opts a project skill into maintenance. */
export const MARKER_KEY = "skill-maintenance";
export const MARKER_VALUE = "auto";
export const MARKER_LINE = `${MARKER_KEY}: ${MARKER_VALUE}`;

/** Instruction stamped right after the marker, so the agent knows what the marker asks of it. */
export const MAINTAINER_INSTRUCTION =
  "**IMPORTANT — keep this skill true:** if it was wrong, incomplete or misleading while you used it, " +
  "fix it now (and its description, if routing was wrong), then say one line: `Skill updated: <name> — <why>`.";

/** Provenance trail, one JSON line per written file. */
export const PROVENANCE_FILE = "skill-review.jsonl";

/** Rotate the trail (keep the tail) once it grows past this, so it cannot grow unbounded. */
const PROVENANCE_MAX_BYTES = 1_000_000;
const PROVENANCE_KEEP_LINES = 2000;

/** Deep enough for any real skill tree; a change below the cap must still be noticed. */
const MAX_SKILL_DEPTH = 32;

const WRITE_TOOLS = new Set(["write", "edit", "multi_edit"]);

export type SkillChangeAction = "patched" | "written";

export interface SkillChange {
  skill: string;
  action: SkillChangeAction;
  /** Path relative to the skill directory. */
  file: string;
}

export interface SkillProvenance extends SkillChange {
  sessionId: string;
  turnId: string;
  at: string;
}

// ── ownership ───────────────────────────────────────────────────────────────

/**
 * Real absolute path of `target`, resolving as much of it as exists — so a file
 * that does not exist yet (a new skill) still compares correctly against the
 * real directory it is being created in.
 */
export function realpathNearestExisting(target: string): string | null {
  let current = path.resolve(target);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      if (tail.length > 0) log.debug("realpath_missing_tail", { resolved: current, missing: tail.length });
      return tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
    } catch (err) {
      const parent = path.dirname(current);
      if (parent === current) {
        log.warn("realpath_unsupported", {
          target,
          reason: String((err as Error)?.message ?? err).slice(0, 200),
        });
        return null;
      }
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * The project's own skills directory, with symlinks resolved. Returns null when the
 * resolved directory is NOT inside the project: `.pi/skills` may itself be a symlink
 * to somewhere else, and then nothing under it is ours to edit.
 */
export function ownedSkillsRoot(projectCwd: string): string | null {
  // The project's skills live in the MAIN checkout, like `.pi/memory`: a linked
  // worktree must resolve to the same directory, or skills there read as ordinary
  // files and an unmarked write slips past the guard (Qodo #1079).
  const realCwd = realpathNearestExisting(resolveMainCheckoutRoot(projectCwd)) ?? path.resolve(projectCwd);
  const resolved = realpathNearestExisting(path.join(realCwd, ".pi", "skills"));
  if (!resolved) return null;
  const rel = path.relative(realCwd, resolved);
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    log.warn("owned_skills_root_outside_project", { projectCwd, resolved });
    return null; // a linked skills dir pointing out of the tree is not owned
  }
  return resolved;
}

/**
 * Any symlink between the root and the target disqualifies it.
 *
 * `realpathNearestExisting` reconstructs a missing tail under the nearest resolved
 * parent, so a DANGLING link inside the owned tree used to look owned — and a write
 * through that link would land on the link's target, outside the tree. A component
 * that does not exist yet is fine (it would be created inside the root); an existing
 * symlink never is.
 */
function hasSymlinkComponent(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return false;
  let current = root;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return true;
    } catch {
      return false; // not created yet: nothing to follow
    }
  }
  return false;
}

/**
 * Pure ownership predicate: true only for a real path inside the project's own
 * `.pi/skills/`. Prefix-string matching is not enough — a symlink inside the
 * directory resolves elsewhere, and that file is not ours.
 */
export function isOwnedSkillPath(projectCwd: string, candidate: string): boolean {
  if (typeof candidate !== "string" || candidate.trim() === "") {
    log.debug("owned_check_empty_candidate");
    return false;
  }
  const root = ownedSkillsRoot(projectCwd);
  if (!root) {
    log.debug("owned_check_no_root", { candidate });
    return false;
  }
  const target = realpathNearestExisting(path.resolve(projectCwd, candidate));
  if (!target) {
    log.debug("owned_check_unresolvable", { candidate });
    return false;
  }
  if (hasSymlinkComponent(root, target)) {
    log.warn("owned_skill_symlink_refused", { candidate });
    return false;
  }
  const rel = path.relative(root, target);
  const owned = rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  log.debug("owned_check", { candidate, owned });
  return owned;
}

/** Skill name owning a path, or null when it is not an owned skill file. */
export function ownedSkillName(projectCwd: string, candidate: string): string | null {
  if (!isOwnedSkillPath(projectCwd, candidate)) return null;
  const root = ownedSkillsRoot(projectCwd);
  if (!root) return null;
  const rel = path.relative(root, realpathNearestExisting(path.resolve(projectCwd, candidate))!);
  const name = rel.split(path.sep)[0];
  return name && name !== "" ? name : null;
}

// ── marker ──────────────────────────────────────────────────────────────────

/** Frontmatter body of a SKILL.md, or null when the file has none. */
function frontmatterOf(content: string): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  return match ? match[1] : null;
}

/** True when the skill content opts into maintenance. */
export function isMarkedSkill(content: string): boolean {
  const frontmatter = frontmatterOf(content);
  if (frontmatter === null) return false;
  return frontmatter
    .split(/\r?\n/)
    .some((line) => new RegExp(`^\\s*${MARKER_KEY}\\s*:\\s*${MARKER_VALUE}\\s*$`).test(line));
}

/** Content of a skill file under the owned root, or null when unreadable. */
export function readSkillFile(projectCwd: string, name: string): string | null {
  const root = ownedSkillsRoot(projectCwd);
  if (!root) return null;
  try {
    return fs.readFileSync(path.join(root, name, "SKILL.md"), "utf-8");
  } catch {
    return null;
  }
}

/** True when `skillMdPath` exists on disk and carries `skill-maintenance: auto`. */
function hasAutoMaintenanceMarker(skillMdPath: string): boolean {
  try {
    const marked = isMarkedSkill(fs.readFileSync(skillMdPath, "utf-8"));
    log.debug("skill_marker_file_check", { skillMdPath, marked });
    return marked;
  } catch {
    log.debug("skill_marker_file_absent", { skillMdPath });
    return false;
  }
}

/** True when the named skill exists under the owned root and carries the marker. */
export function isMarkedSkillNamed(projectCwd: string, name: string): boolean {
  const content = readSkillFile(projectCwd, name);
  return content !== null && isMarkedSkill(content);
}

/**
 * Insert the marker (creating frontmatter when absent) and the maintenance
 * instruction right after it. Idempotent: already-stamped content is returned
 * unchanged with `changed: false`.
 */
export function stampSkill(content: string): { content: string; changed: boolean } {
  if (isMarkedSkill(content) && content.includes("IMPORTANT — keep this skill true")) {
    return { content, changed: false };
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  let stamped: string;
  if (match === null) {
    const body = content.replace(/^\s*\n/, "");
    stamped = `---\n${MARKER_LINE}\n---\n\n${MAINTAINER_INSTRUCTION}\n\n${body}`;
  } else {
    const frontmatter = match[1].split(/\r?\n/).some((line) => line.trim() === MARKER_LINE)
      ? match[1]
      : `${match[1]}\n${MARKER_LINE}`;
    const body = content.slice(match[0].length).replace(/^\r?\n+/, "");
    const instruction = body.includes("IMPORTANT — keep this skill true")
      ? body
      : `${MAINTAINER_INSTRUCTION}\n\n${body}`;
    stamped = `---\n${frontmatter}\n---\n\n${instruction}`;
  }
  return { content: stamped, changed: stamped !== content };
}

/** Skill names under the owned root, sorted. Symlinked dirs are not ours and are skipped. */
export function listOwnedSkills(projectCwd: string): string[] {
  const root = ownedSkillsRoot(projectCwd);
  if (!root) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(root, name, "SKILL.md")))
    .sort();
}

/** Owned skills that do not carry the marker yet — what `/adopt-skill` offers. */
export function listUnmarkedSkills(projectCwd: string): string[] {
  return listOwnedSkills(projectCwd).filter((name) => !isMarkedSkillNamed(projectCwd, name));
}

// ── write classification (the guard) ────────────────────────────────────────

export type SkillArea = "owned" | "project-agents" | "package" | "user-global";

/** True when `abs` is at or below `root` (both already resolved or lexical). */
function isUnder(root: string, abs: string): boolean {
  const rel = path.relative(root, abs);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * Which skills area a path belongs to, or null when it is an ordinary file.
 *
 * Only KNOWN skills roots count (issue #1074, Qodo HIGH): a project that happens to
 * live under `~/src/skills/foo/` must keep its normal files writable, so a path that
 * merely contains a `skills` segment is not a skill.
 */
export function skillAreaOf(projectCwd: string, candidate: string): SkillArea | null {
  const abs = path.resolve(projectCwd, candidate);
  if (isOwnedSkillPath(projectCwd, abs)) return "owned";

  // Compare real paths on BOTH sides: `~/.pi/agent/skills` or `.agents/skills` may
  // itself be a symlink, which would otherwise never match the raw candidate.
  const realAbs = realpathNearestExisting(abs) ?? abs;
  const home = os.homedir();
  for (const globalRoot of [path.join(home, ".pi", "agent", "skills"), path.join(home, ".agents", "skills")]) {
    if (isUnder(realpathNearestExisting(globalRoot) ?? globalRoot, realAbs)) return "user-global";
  }

  const realCwd = realpathNearestExisting(projectCwd) ?? path.resolve(projectCwd);
  const projectAgents = path.join(realCwd, ".agents", "skills");
  if (isUnder(realpathNearestExisting(projectAgents) ?? projectAgents, realAbs)) return "project-agents";

  // Packaged skills: an installed package's `skills/` directory (pi-orchestrator-config
  // ships its skills this way; marketplace installs land under node_modules too).
  const segments = abs.split(path.sep);
  const ggNodeModules = segments.indexOf("node_modules");
  if (ggNodeModules >= 0 && segments.indexOf("skills", ggNodeModules) > ggNodeModules) return "package";

  log.debug("skill_area_none", { candidate });
  return null;
}

/** New text a write call would land in the file. */
export function incomingText(input: unknown): string {
  const args = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["content", "newText", "new_string", "text"]) {
    const value = args[key];
    if (typeof value === "string") parts.push(value);
  }
  const edits = args.edits;
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const value = (edit as Record<string, unknown> | undefined)?.newText;
      if (typeof value === "string") parts.push(value);
    }
  }
  return parts.join("\n");
}

/**
 * The file content an `edit` call would produce, applying its replacements to the
 * current content. Null when the edit cannot be resolved (oldText missing), so the
 * caller keeps the current state instead of trusting the fragment.
 */
export function applyEditToContent(current: string, input: unknown): string | null {
  const args = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const pairs: Array<{ oldText: string; newText: string }> = [];
  if (typeof args.oldText === "string" && typeof args.newText === "string") {
    pairs.push({ oldText: args.oldText, newText: args.newText });
  }
  if (Array.isArray(args.edits)) {
    for (const edit of args.edits) {
      const entry = edit as Record<string, unknown> | undefined;
      if (typeof entry?.oldText === "string" && typeof entry?.newText === "string") {
        pairs.push({ oldText: entry.oldText, newText: entry.newText });
      }
    }
  }
  if (pairs.length === 0) return null;
  let result = current;
  for (const pair of pairs) {
    if (!result.includes(pair.oldText)) {
      log.debug("edit_fragment_not_found", { fragment: pair.oldText.slice(0, 40) });
      return null;
    }
    result = result.split(pair.oldText).join(pair.newText);
  }
  return result;
}

/**
 * The content a write/edit would leave in the file: the new text for a write, and
 * the current content with the edit applied for an edit. Null when unknowable.
 */
export function resultingContent(current: string | null, input: unknown): string | null {
  const args = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  if (typeof args.content === "string") return args.content;
  if (current === null) return incomingText(input) || null;
  return applyEditToContent(current, input) ?? (incomingText(input) || null);
}

export interface SkillWriteVerdict {
  allow: boolean;
  /** Set when the write lands in an owned skill (marked or not). */
  skill?: string;
  /** File path relative to the skill directory. */
  file?: string;
  /** Absolute path that was evaluated. */
  path: string;
  reason?: string;
}

/**
 * The one rule that decides whether a write/edit may touch a skill file.
 *
 * A skill file is writable only when it is MARKED and its real path is inside the
 * project's own `.pi/skills/`. A write that *introduces* the marker is allowed even
 * when the file is unmarked — refusing it would deadlock skill creation.
 */
export function classifySkillWrite(
  projectCwd: string,
  candidate: string,
  input: unknown,
): SkillWriteVerdict {
  const abs = path.resolve(projectCwd, candidate);
  const area = skillAreaOf(projectCwd, abs);

  // Lexically inside our own skills dir but not owned: a symlink (dangling or
  // resolved) put it, or the whole `.pi/skills` dir, outside the project. Checked
  // before the "ordinary file" early return, or a dangling link reads as writable.
  const lexicalRoot = path.join(realpathNearestExisting(resolveMainCheckoutRoot(projectCwd)) ?? path.resolve(projectCwd), ".pi", "skills");
  const lexicalRel = path.relative(lexicalRoot, abs);
  const lexicallyInSkills =
    lexicalRel !== "" && lexicalRel !== ".." && !lexicalRel.startsWith(`..${path.sep}`) && !path.isAbsolute(lexicalRel);
  if (area === null && !lexicallyInSkills) return { allow: true, path: abs };
  if (area !== "owned" && lexicallyInSkills) {
    return {
      allow: false,
      path: abs,
      reason:
        `⛔ ${candidate} resolves outside ${lexicalRoot} (a symlink, or the skills directory itself points out) — refused. ` +
        `Replace the link with a real file inside the project before editing it.`,
    };
  }

  if (area === "package") {
    log.warn("skill_write_package_refused", { candidate });
    return {
      allow: false,
      path: abs,
      reason:
        `⛔ ${candidate} is a skill shipped in an installed package (node_modules) — product surface, never edited. ` +
        `Write your own copy under ${path.join(projectCwd, ".pi", "skills")}/<name>/SKILL.md (a marked creation is allowed there) ` +
        `and run /adopt-skill <name>; a global copy is yours to place by hand.`,
    };
  }
  if (area === "user-global") {
    log.warn("skill_write_global_refused", { candidate });
    return {
      allow: false,
      path: abs,
      reason:
        `⛔ ${candidate} is a user-global skill (~/.pi/agent/skills or ~/.agents/skills) — shared by every project, never edited by an agent. ` +
        `Create it under ${path.join(projectCwd, ".pi", "skills")}/<name>/SKILL.md with \`${MARKER_LINE}\` instead, ` +
        `then copy it to ~/.agents/skills/<name>/ yourself if you want it globally.`,
    };
  }

  const skill = ownedSkillName(projectCwd, abs) ?? undefined;
  const root = ownedSkillsRoot(projectCwd);
  const file = root && skill ? path.relative(path.join(root, skill), abs) : undefined;

  if (area === "project-agents") {
    log.debug("skill_area_project_agents", { candidate });
    return {
      allow: false,
      path: abs,
      reason:
        `⛔ ${candidate} is in the project's .agents/skills/ discovery directory, not the maintained location. ` +
        `Maintain skills under ${path.join(projectCwd, ".pi", "skills")}/ and run /adopt-skill <name>.`,
    };
  }

  // An auxiliary file (references/*.md, scripts) belongs to its skill: it is judged by
  // the owning SKILL.md, never by applying the auxiliary edit to SKILL.md (Qodo #1079).
  const current = skill ? readSkillFile(projectCwd, skill) : null;
  const isSkillFile = file === "SKILL.md";
  if (!isSkillFile) {
    if (current !== null && isMarkedSkill(current)) return { allow: true, path: abs, skill, file };
    log.warn("skill_write_aux_unmarked", { skill: skill ?? null, file: file ?? null });
    return {
      allow: false,
      path: abs,
      skill,
      file,
      reason:
        `⛔ "${skill ?? candidate}" is owned by this project but not marked for maintenance, so its files cannot be edited. ` +
        `Create or mark SKILL.md first (/adopt-skill ${skill ?? "<name>"}).`,
    };
  }

  // Classify against the RESULTING content (Qodo HIGH): an edit's replacement fragment
  // is not the file, so "the fragment looks marked" must not unlock an unmarked skill.
  const result = resultingContent(current, input);
  if (result !== null && isMarkedSkill(result)) {
    return { allow: true, path: abs, skill, file };
  }
  log.warn("skill_write_unmarked", { skill: skill ?? null, candidate });
  return {
    allow: false,
    path: abs,
    skill,
    file,
    reason:
      `⛔ "${skill ?? candidate}" is owned by this project but not marked for maintenance. ` +
      `Run /adopt-skill ${skill ?? "<name>"}, or add \`${MARKER_LINE}\` to its frontmatter.`,
  };
}

// ── snapshot / diff / notice ────────────────────────────────────────────────

/**
 * Snapshot every regular file in the owned tree (path → mtime:size). Symlinks
 * are not followed: a link is not a file we own, whatever it points at.
 */
export function snapshotSkillTree(root: string | null): Map<string, string> {
  const snapshot = new Map<string, string>();
  if (!root) {
    log.debug("skill_snapshot_no_root");
    return snapshot;
  }
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_SKILL_DEPTH) {
      log.warn("skill_snapshot_depth_cap", { dir, max: MAX_SKILL_DEPTH });
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        // Normal: this project has no `.pi/skills/` yet. Not a warning per turn.
        log.debug("skill_snapshot_absent", { dir });
        return;
      }
      log.warn("skill_snapshot_readdir_failed", {
        dir,
        reason: String((err as Error)?.message ?? err).slice(0, 200),
      });
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        log.debug("skill_snapshot_skip_symlink", { full });
        continue;
      }
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = fs.statSync(full);
        snapshot.set(full, `${stat.mtimeMs}:${stat.size}`);
      } catch (err) {
        // vanished mid-walk — treat as untouched
        log.warn("skill_snapshot_stat_failed", {
          full,
          reason: String((err as Error)?.message ?? err).slice(0, 200),
        });
      }
    }
  };
  walk(root, 0);
  log.debug("skill_snapshot", { root, files: snapshot.size });
  return snapshot;
}

/**
 * Files added or modified between two snapshots. A file whose skill directory
 * did not exist before means the skill was written, not patched.
 */
export function diffSkillTree(
  root: string | null,
  before: Map<string, string>,
  after: Map<string, string>,
): SkillChange[] {
  if (!root) return [];
  const skillsBefore = new Set(
    [...before.keys()].map((file) => path.relative(root, file).split(path.sep)[0]),
  );
  const changes: SkillChange[] = [];
  for (const [file, stamp] of after) {
    if (before.get(file) === stamp) continue;
    const rel = path.relative(root, file);
    const [skill, ...rest] = rel.split(path.sep);
    if (!skill || rest.length === 0) {
      log.debug("skill_diff_outside_skill", { file });
      continue;
    }
    changes.push({
      skill,
      action: skillsBefore.has(skill) ? "patched" : "written",
      file: rest.join(path.sep),
    });
  }
  const sorted = changes.sort((a, b) => a.skill.localeCompare(b.skill) || a.file.localeCompare(b.file));
  log.debug("skill_diff", { root, before: before.size, after: after.size, changes: sorted.length });
  return sorted;
}

/**
 * One line for the whole turn — one entry per skill, the written file named
 * because that is the only change a reader cannot guess. Empty input → "".
 */
export function formatSkillReviewNotice(changes: readonly SkillChange[], provenanceFailed = false): string {
  const perSkill = new Map<string, SkillChange>();
  for (const change of changes) {
    if (!perSkill.has(change.skill)) perSkill.set(change.skill, change);
  }
  log.debug("skill_notice_format", { changes: changes.length, skills: perSkill.size, provenanceFailed });
  const parts = [...perSkill.values()].map((change) =>
    change.action === "written"
      ? `Skill '${change.skill}' written (${change.file})`
      : `Skill '${change.skill}' patched`,
  );
  if (parts.length === 0) return "";
  const suffix = provenanceFailed
    ? " · provenance write failed — .pi/data/skill-review.jsonl not updated"
    : "";
  return `\u{1F4D9} Self-improvement review: ${parts.join(" \u00b7 ")}${suffix}`;
}

// ── provenance ──────────────────────────────────────────────────────────────

export function provenancePath(projectCwd: string): string {
  return path.join(getProjectDataDir(projectCwd), PROVENANCE_FILE);
}

/**
 * Append provenance records with O_APPEND so two sessions writing at once cannot
 * overwrite each other's lines (a read-modify-write dropped a concurrent record).
 * Returns false when the trail could not be written — the caller must say so
 * instead of claiming the change was recorded.
 */
export function appendProvenance(projectCwd: string, records: readonly SkillProvenance[]): boolean {
  if (records.length === 0) return true;
  const file = provenancePath(projectCwd);
  try {
    fs.appendFileSync(file, records.map((record) => `${JSON.stringify(record)}\n`).join(""), { mode: 0o600 });
    rotateProvenance(file);
    return true;
  } catch (err) {
    log.error("provenance_append_failed", { reason: String((err as Error)?.message ?? err).slice(0, 200) });
    fileLog("skill-maintenance", "error", "skill-maintenance", "provenance append failed", err);
    return false;
  }
}

/**
 * Trim an over-large trail to its newest lines, atomically: the trimmed copy is
 * written to a temp file in the same directory and renamed over the trail, so a
 * concurrent append either lands before the rename (and is kept) or after it —
 * it can never be truncated away by a read-then-write window (Qodo #1079).
 * shortcut: the size check races with an append of a few bytes; the worst case is
 * one rotation running a moment early, which loses nothing.
 */
function rotateProvenance(file: string): void {
  try {
    if (fs.statSync(file).size <= PROVENANCE_MAX_BYTES) return;
    const kept = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean).slice(-PROVENANCE_KEEP_LINES);
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, `${kept.join("\n")}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
    log.info("provenance_rotated", { kept: kept.length });
  } catch (err) {
    log.warn("provenance_rotate_failed", { reason: String((err as Error)?.message ?? err).slice(0, 200) });
  }
}

// ── /adopt-skill ────────────────────────────────────────────────────────────

export interface AdoptResult {
  ok: boolean;
  message: string;
}

/**
 * Mark a project-owned skill as maintained: insert the marker and the maintenance
 * instruction. Idempotent. Writes directly — this is the human's command, not an
 * agent write, so it does not go through the tool guard.
 */
export function adoptSkill(projectCwd: string, name: string): AdoptResult {
  const root = ownedSkillsRoot(projectCwd);
  if (!root) {
    return { ok: false, message: `No ${path.join(projectCwd, ".pi", "skills")} directory in this project.` };
  }
  if (!name) {
    return { ok: false, message: "Usage: /adopt-skill <name>" };
  }
  // The argument is user input: a bare skill name only, and the resolved target must
  // pass the same ownership predicate as any other write (`../`, an absolute path and a
  // symlinked skill all fail it) — otherwise adopting a link would edit an outside file.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    log.warn("adopt_skill_bad_name", { name });
    return { ok: false, message: `"${name}" is not a skill name — use a bare name under ${root}.` };
  }
  const file = path.join(root, name, "SKILL.md");
  if (!isOwnedSkillPath(projectCwd, file)) {
    log.warn("adopt_skill_not_owned", { name, file });
    return {
      ok: false,
      message: `"${name}" does not resolve to a file this project owns (symlink or path escape) — refusing to write it.`,
    };
  }
  if (!fs.existsSync(file)) {
    const elsewhere = skillExistsOutside(projectCwd, name);
    log.warn("adopt_skill_refused", { name, existsElsewhere: elsewhere });
    return {
      ok: false,
      message: elsewhere
        ? `"${name}" is not a project skill — copy it into ${path.join(root, name)}/ first, then run /adopt-skill ${name}.`
        : `No project skill named "${name}" under ${root}.`,
    };
  }
  try {
    const content = fs.readFileSync(file, "utf-8");
    const { content: stamped, changed } = stampSkill(content);
    if (!changed) return { ok: true, message: `Skill "${name}" is already maintained.` };
    fs.writeFileSync(file, stamped, "utf-8");
    log.info("adopt_skill_marked", { name, file });
    return { ok: true, message: `✅ Skill "${name}" is now maintained — patching it is allowed from here on.` };
  } catch (err) {
    log.error("adopt_skill_failed", { name, reason: String((err as Error)?.message ?? err).slice(0, 200) });
    return { ok: false, message: `Could not update ${file}: ${(err as Error)?.message ?? err}` };
  }
}

/** True when a skill with this name exists outside the project's own tree. */
function skillExistsOutside(projectCwd: string, name: string): boolean {
  const home = os.homedir();
  const roots = [
    path.join(home, ".pi", "agent", "skills"),
    path.join(home, ".agents", "skills"),
    path.join(path.resolve(projectCwd), ".agents", "skills"),
  ];
  return roots.some((root) => fs.existsSync(path.join(root, name, "SKILL.md")));
}

/** Autocomplete helper: unmarked project skills matching the typed prefix. */
export function completeUnmarkedSkills(
  projectCwd: string,
  prefix: string,
): Array<{ value: string; label: string; description?: string }> {
  const needle = (prefix ?? "").trim().toLowerCase();
  return listUnmarkedSkills(projectCwd)
    .filter((name) => name.includes(needle))
    .map((name) => ({ value: name, label: name, description: "mark for maintenance" }));
}

// ── registration ────────────────────────────────────────────────────────────

const SKILL_INVOCATION = /\/skill:([a-z0-9][a-z0-9-]*)/g;

/** Marked owned skills named in a text (a `/skill:x` invocation or a path under a skill dir). */
export function markedSkillsInText(projectCwd: string, text: string): string[] {
  if (typeof text !== "string" || !text) return [];
  const root = ownedSkillsRoot(projectCwd);
  if (!root) return [];
  const found = new Set<string>();
  const candidates = new Set<string>();
  for (const match of text.matchAll(SKILL_INVOCATION)) candidates.add(match[1]);
  for (const segment of text.matchAll(/skills[\\/]([A-Za-z0-9._-]+)/g)) candidates.add(segment[1]);
  for (const name of candidates) {
    if (isMarkedSkillNamed(projectCwd, name)) found.add(name);
  }
  return [...found];
}

/** Registered tools whose input names a path we care about. */
function pathFromInput(input: unknown): string | null {
  const args = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath"]) {
    const value = args[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

/** Verbs that can only read a file — the shell's whole read surface for skills. */
const READ_ONLY_VERBS = new Set([
  "cat", "less", "head", "tail", "grep", "rg", "ls", "stat", "wc", "diff", "md5sum", "sha256sum",
]);

/** Anything that writes: no shell write to a skill is allowed, whatever its shape. */
const BASH_WRITE_VERBS =
  /(?:^|[\s;|&()])(?:tee|cp|mv|rm|install|dd|truncate|chmod|chown|chgrp|touch|patch|unlink|ln)(?=$|[\s;|&()])|(?:^|[\s;|&()])sed\s+(?:-[A-Za-z]*i|--in-place)(?=$|[\s;|&()])|(?:^|[\s;|&()])perl\s+-[A-Za-z]*i/;

/** Executables or flags that evaluate a quoted argument as code, commands, or file-writing rules. */
const INLINE_CODE_RUNNERS =
  /^(?:bash|sh|zsh|dash|ksh|fish|csh|tcsh|eval|exec|source|\.|python(?:\d+(?:\.\d+)*)?|pypy3?|node|nodejs|tsx|ts-node|bun|deno|perl|ruby|php|lua|awk|gawk|mawk|nawk|sed|gsed|ed|ex|vi|vim|nvim|xargs|find|parallel|powershell|pwsh)$/;

const SAFE_UV_FLAGS = new Set([
  "--script", "-s", "--quiet", "-q", "--no-project", "--isolated", "--offline", "--no-sync", "--locked", "--frozen",
]);
const SAFE_UV_VALUE_FLAGS = new Set(["--with", "--python", "-p"]);

const GH_GLOBAL_VALUE_FLAGS = new Set(["-R", "--repo", "--hostname"]);
const GH_PROSE_SUBCOMMANDS = new Set(["issue", "pr", "release"]);
const GH_PROSE_FLAGS = new Set(["--body", "-b", "--title", "-t", "--notes", "-n"]);
const GIT_PROSE_SUBCOMMANDS = new Set(["commit", "tag", "notes"]);
const GIT_VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

const SKILL_MENTION_RE = /skills[\\/]|\bSKILL\.md\b/;
const QUOTED_SPAN_RE = /\$'(?:[^'\\]|\\.)*'|'[^']*'|"(?:[^"\\]|\\.)*"|\\./g;

/**
 * True when `command` embeds an executable command or process substitution:
 * unescaped `$(...)` or backticks outside single quotes, or unquoted `<(...)` / `>(...)`.
 * Single-quoted `'...'` and `$'...'` spans are literal in bash and never execute.
 */
function hasExecutableSubstitution(command: string): boolean {
  let cursor = 0;
  let detected = false;
  for (const match of command.matchAll(QUOTED_SPAN_RE)) {
    const index = match.index ?? 0;
    const gap = command.slice(cursor, index);
    if (/\$\(|`|[<>]\s*\(/.test(gap)) { detected = true; break; }
    const span = match[0];
    if (span.startsWith('"') && /\$\(|`/.test(span.slice(1, -1).replace(/\\./g, ""))) { detected = true; break; }
    cursor = index + span.length;
  }
  if (!detected && /\$\(|`|[<>]\s*\(/.test(command.slice(cursor))) detected = true;
  log.debug("skill_shell_substitution_check", { detected });
  return detected;
}

/** Split `command` into pipelines (`&&`, `||`, `;`, `&`, `\n`) and pipe stages (`|`) outside quotes. */
function splitPipelines(command: string): string[][] {
  const pipelines: string[][] = [];
  let stages: string[] = [];
  let start = 0;
  let i = 0;
  const flushStage = (end: number): void => {
    const trimmed = command.slice(start, end).trim();
    if (trimmed) stages.push(trimmed);
  };
  const flushPipeline = (end: number): void => {
    flushStage(end);
    if (stages.length > 0) pipelines.push(stages);
    stages = [];
  };
  while (i < command.length) {
    const ch = command[i];
    if (ch === "\\") { i += 2; continue; }
    if (ch === "$" && command[i + 1] === "'") {
      i += 2;
      while (i < command.length && command[i] !== "'") i += command[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      i = end === -1 ? command.length : end + 1;
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < command.length && command[i] !== '"') i += command[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (ch === "#" && (i === 0 || /[\s;&|(\n]/.test(command[i - 1]))) {
      const nl = command.indexOf("\n", i);
      flushPipeline(i);
      if (nl === -1) { start = command.length; break; }
      i = nl + 1;
      start = i;
      continue;
    }
    if ((ch === "&" && command[i + 1] === "&") || (ch === "|" && command[i + 1] === "|")) {
      flushPipeline(i);
      i += 2;
      start = i;
      continue;
    }
    if (ch === ";" || ch === "\n" || (ch === "&" && command[i - 1] !== ">" && command[i - 1] !== "<" && command[i + 1] !== ">")) {
      flushPipeline(i);
      i += 1;
      start = i;
      continue;
    }
    if (ch === "|" && command[i - 1] !== ">") {
      flushStage(i);
      i += command[i + 1] === "&" ? 2 : 1;
      start = i;
      continue;
    }
    i++;
  }
  flushPipeline(command.length);
  log.debug("skill_shell_pipelines", { count: pipelines.length });
  return pipelines;
}

/**
 * Strip shell quoting (`'...'`, `"..."`, `$'...'`, `\x`) from a shell word or span,
 * and expand literal `~`, `$HOME`, and `$PWD` prefixes when `projectCwd` is supplied.
 */
function unquoteWord(raw: string, projectCwd?: string): string {
  let i = 0;
  let value = "";
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === "\\") {
      value += raw[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (ch === "$" && raw[i + 1] === "'") {
      i += 2;
      while (i < raw.length && raw[i] !== "'") {
        if (raw[i] === "\\" && i + 1 < raw.length) { value += raw[i + 1]; i += 2; }
        else value += raw[i++];
      }
      if (i < raw.length) i++;
      continue;
    }
    if (ch === "'") {
      const end = raw.indexOf("'", i + 1);
      if (end === -1) { value += raw.slice(i + 1); i = raw.length; }
      else { value += raw.slice(i + 1, end); i = end + 1; }
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < raw.length && raw[i] !== '"') {
        if (raw[i] === "\\" && i + 1 < raw.length && /["\\$`\n]/.test(raw[i + 1])) {
          value += raw[i + 1];
          i += 2;
        } else {
          value += raw[i++];
        }
      }
      if (i < raw.length) i++;
      continue;
    }
    value += ch;
    i++;
  }
  if (projectCwd !== undefined) {
    value = value
      .replace(/^~(?=$|\/)/, os.homedir())
      .replace(/^\$\{?HOME\}?(?=$|\/)/, os.homedir())
      .replace(/^\$\{?PWD\}?(?=$|\/)/, projectCwd);
  }
  if (value !== raw) log.debug("skill_shell_unquote", { rawLen: raw.length, outLen: value.length });
  return value;
}

interface SegmentWord {
  value: string;
  quoted: boolean;
}

interface ParsedSegment {
  words: SegmentWord[];
  redirectTargets: string[];
  hasWriteRedirect: boolean;
}

/**
 * Parse one pipeline stage into shell words and redirections.
 *
 * `/dev/null` sinks (`2>/dev/null`, `>/dev/null`, `&>/dev/null`) and fd duplications
 * (`2>&1`, `>&2`, `1>&2`, `2>&-`) open no disk file and do not set `hasWriteRedirect`.
 */
function parseSegment(projectCwd: string, segment: string): ParsedSegment {
  const scanWordEnd = (start: number): number => {
    let pos = start;
    while (pos < segment.length && !/[\s()<>]/.test(segment[pos])) {
      if (segment[pos] === "\\") { pos += 2; continue; }
      if (segment[pos] === "$" && segment[pos + 1] === "'") {
        pos += 2;
        while (pos < segment.length && segment[pos] !== "'") pos += segment[pos] === "\\" ? 2 : 1;
        if (pos < segment.length) pos++;
        continue;
      }
      if (segment[pos] === "'") {
        const end = segment.indexOf("'", pos + 1);
        pos = end === -1 ? segment.length : end + 1;
        continue;
      }
      if (segment[pos] === '"') {
        pos++;
        while (pos < segment.length && segment[pos] !== '"') pos += segment[pos] === "\\" ? 2 : 1;
        if (pos < segment.length) pos++;
        continue;
      }
      pos++;
    }
    return pos;
  };

  const words: SegmentWord[] = [];
  const redirectTargets: string[] = [];
  let hasWriteRedirect = false;
  let i = 0;
  while (i < segment.length) {
    while (i < segment.length && /[\s()]/.test(segment[i])) i++;
    if (i >= segment.length) break;

    const rest = segment.slice(i);
    // Match complete fd-duplication operators (`2>&1`, `>&2`, `1>&2`, `2>&-`) BEFORE bare `>`.
    const fdDupMatch = /^(?:\d+)?[<>]&(?:\d+|-)(?=$|[\s()<>])/.exec(rest);
    if (fdDupMatch) {
      i += fdDupMatch[0].length;
      continue;
    }

    const redirMatch = /^(?:&>>?|(?:\d+)?(?:<&|>&|<>|>\||<<-?|<<<|>>?|<))/.exec(rest);
    if (redirMatch) {
      const op = redirMatch[0];
      i += op.length;
      while (i < segment.length && /[ \t]/.test(segment[i])) i++;
      const end = scanWordEnd(i);
      const target = unquoteWord(segment.slice(i, end), projectCwd);
      i = end;
      if (op.includes(">") && target !== "/dev/null") hasWriteRedirect = true;
      if (target && target !== "/dev/null") redirectTargets.push(target);
      continue;
    }

    const end = scanWordEnd(i);
    const raw = segment.slice(i, end);
    i = end > i ? end : i + 1;
    const quoted = /['"\\]/.test(raw);
    const value = unquoteWord(raw, projectCwd);
    if (value !== "" || quoted) {
      words.push({ value, quoted });
    }
  }
  log.debug("skill_shell_segment_parsed", {
    words: words.length,
    redirects: redirectTargets.length,
    hasWriteRedirect,
  });
  return { words, redirectTargets, hasWriteRedirect };
}

/**
 * `timeout` options that take a separate value. Mirrors `PIPE_TIMEOUT_VALUE_OPTIONS` in
 * `enforcement-helpers.ts` (module-private there, so not imported).
 */
const TIMEOUT_VALUE_OPTIONS = new Set(["-s", "--signal", "-k", "--kill-after"]);

/** Unwrap leading control keywords, `FOO=bar` env assignments, `rtk` wrappers, `env`, and `timeout`. */
function commandWordIndex(plainWords: string[]): number {
  let idx = skipToCommandWord(plainWords);
  // `env` and `timeout` nest (`timeout 5 env bash helper`), so unwrap until the word stops changing.
  // Unwrapping only exposes the real verb to the write checks, never hides one.
  for (;;) {
    if (plainWords[idx] === "env") {
      const next = skipToCommandWord(plainWords.slice(idx + 1));
      const candidate = plainWords[idx + 1 + next];
      if (!candidate || candidate.startsWith("-")) break;
      idx = idx + 1 + next;
      continue;
    }
    // `timeout [-s SIG] [-k N] [--signal SIG] [--kill-after N] <duration> <command…>` — without
    // this the verb looks like `timeout`, so a bounded run of a skill helper read as an
    // unknown command and blocked.
    if (plainWords[idx] === "timeout") {
      let next = idx + 1;
      while (plainWords[next]?.startsWith("-")) {
        next += TIMEOUT_VALUE_OPTIONS.has(plainWords[next]) ? 2 : 1;
      }
      next += 1; // the duration operand
      if (!plainWords[next]) break;
      idx = next;
      continue;
    }
    break;
  }
  log.debug("skill_shell_command_word", { idx, verb: plainWords[idx] ?? "" });
  return idx;
}

/** Drop pure remote/commit prose flag values (`gh issue|pr --body`, `git commit -m`) before lookup. */
function pathCandidateTokens(parsed: ParsedSegment, cmdIdx: number): string[] {
  const { words, redirectTargets } = parsed;
  const cmd = words[cmdIdx]?.value ?? "";
  const out: string[] = [];
  if (cmd === "gh") {
    let j = cmdIdx + 1;
    while (j < words.length && words[j].value.startsWith("-")) {
      j += GH_GLOBAL_VALUE_FLAGS.has(words[j].value) ? 2 : 1;
    }
    const sub = words[j]?.value ?? "";
    if (GH_PROSE_SUBCOMMANDS.has(sub)) {
      for (let i = 0; i < words.length; i++) {
        const val = words[i].value;
        if (GH_PROSE_FLAGS.has(val)) { i++; continue; }
        if (/^--(?:body|title|notes)=/.test(val)) continue;
        out.push(val);
      }
      log.debug("skill_shell_candidates_gh_prose", { sub, count: out.length + redirectTargets.length });
      return [...out, ...redirectTargets];
    }
  } else if (cmd === "git") {
    let j = cmdIdx + 1;
    while (j < words.length && words[j].value.startsWith("-")) {
      j += GIT_VALUE_FLAGS.has(words[j].value) ? 2 : 1;
    }
    const sub = words[j]?.value ?? "";
    if (GIT_PROSE_SUBCOMMANDS.has(sub)) {
      for (let i = 0; i < words.length; i++) {
        const val = words[i].value;
        if (val === "-m" || val === "--message") { i++; continue; }
        if (val.startsWith("-m") || val.startsWith("--message=")) continue;
        out.push(val);
      }
      log.debug("skill_shell_candidates_git_prose", { sub, count: out.length + redirectTargets.length });
      return [...out, ...redirectTargets];
    }
  }
  const all = [...words.map((w) => w.value), ...redirectTargets];
  log.debug("skill_shell_candidates", { cmd, count: all.length });
  return all;
}

/**
 * True when any unquoted-value command/flag token (even if originally shell-quoted,
 * e.g. `"bash" "-c" ...`, `'python3' '-c' ...`, `"node" "-e" ...`) runs inline code,
 * a shell, or a stream editor.
 */
function segmentRunsInlineCode(parsed: ParsedSegment, cmdIdx: number): boolean {
  const verb = parsed.words[cmdIdx]?.value ?? "";
  if (READ_ONLY_VERBS.has(verb)) {
    log.debug("skill_shell_inline_readonly", { verb });
    return false;
  }
  const candidates = pathCandidateTokens({ words: parsed.words, redirectTargets: [], hasWriteRedirect: false }, cmdIdx);
  for (let i = cmdIdx; i < candidates.length; i++) {
    const tok = candidates[i];
    const base = path.basename(tok);
    if (
      INLINE_CODE_RUNNERS.test(base) ||
      tok === "-c" ||
      tok === "-e" ||
      tok === "--eval" ||
      tok === "--command" ||
      tok.startsWith("--eval=") ||
      tok.startsWith("--command=") ||
      /^-[A-Za-z]*[ce]$/.test(tok)
    ) {
      log.debug("skill_shell_inline_runner", { verb, token: tok });
      return true;
    }
  }
  log.debug("skill_shell_inline_none", { verb });
  return false;
}

/** Lexically inside known skills directories (or only this project's own `.pi/skills` when `ownedOnly`). */
function lexicallyUnderSkillsRoot(projectCwd: string, abs: string, ownedOnly = false): boolean {
  const realMain = realpathNearestExisting(resolveMainCheckoutRoot(projectCwd)) ?? path.resolve(projectCwd);
  const ownedLexical = path.join(realMain, ".pi", "skills");
  const realCwd = realpathNearestExisting(projectCwd) ?? path.resolve(projectCwd);
  const roots = ownedOnly
    ? [ownedLexical]
    : [
        ownedLexical,
        path.join(realMain, ".agents", "skills"),
        path.join(realCwd, ".pi", "skills"),
        path.join(realCwd, ".agents", "skills"),
        path.join(os.homedir(), ".pi", "agent", "skills"),
        path.join(os.homedir(), ".agents", "skills"),
      ];
  const hit = roots.some((root) => isUnder(root, abs));
  log.debug("skill_lexical_root_check", { abs, ownedOnly, hit });
  return hit;
}

export interface ShellSkillReference {
  token: string;
  abs: string;
  /** Resolved area, or null when the path's meaning cannot be established. */
  area: SkillArea | null;
  /** A bare `SKILL.md`: its meaning depends on the cwd, so it can never be classified. */
  bare: boolean;
}

function collectSegmentSkillReferences(projectCwd: string, parsed: ParsedSegment, cmdIdx: number): ShellSkillReference[] {
  const refs: ShellSkillReference[] = [];
  for (const token of pathCandidateTokens(parsed, cmdIdx)) {
    if (token === "cd" || token.includes("\n")) continue;
    const eq = token.indexOf("=");
    // `--option=/path/to/skill` or `of=/path/to/skill` carries its path after `=`;
    // a bare filename value (`--glob=SKILL.md`) is a pattern, not a target.
    const candidates =
      eq > 0 && /^(?:--?[A-Za-z0-9_-]+|[A-Za-z_][A-Za-z0-9_]*)$/.test(token.slice(0, eq))
        ? [token, unquoteWord(token.slice(eq + 1), projectCwd)]
        : [token];
    const hit = candidates.find((candidate) => {
      const abs = path.resolve(projectCwd, candidate);
      if (skillAreaOf(projectCwd, abs) !== null || lexicallyUnderSkillsRoot(projectCwd, abs)) return true;
      return path.basename(candidate) === "SKILL.md" && !candidate.includes("/") && candidate === token;
    });
    if (hit === undefined) continue;
    const abs = path.resolve(projectCwd, hit);
    const area = skillAreaOf(projectCwd, abs);
    const bare = path.basename(hit) === "SKILL.md" && !hit.includes("/");
    log.debug("skill_shell_reference", { token: hit, area, bare });
    refs.push({ token: hit, abs, area, bare });
  }
  return refs;
}

/**
 * Every token of a command that names something in a skills area.
 *
 * Text only: a literal path, a `~`-expanded one, a `--flag=/path` value that is a real
 * path (not a bare filename), or a bare `SKILL.md`. Resolution happens here; the
 * decision happens in `bashSkillVerdict`.
 */
export function shellSkillReferences(projectCwd: string, command: string): ShellSkillReference[] {
  const refs: ShellSkillReference[] = [];
  for (const stages of splitPipelines(command)) {
    for (const stage of stages) {
      const parsed = parseSegment(projectCwd, stage);
      const cmdIdx = commandWordIndex(parsed.words.map((w) => w.value));
      refs.push(...collectSegmentSkillReferences(projectCwd, parsed, cmdIdx));
    }
  }
  log.debug("skill_shell_references_collected", { count: refs.length });
  return refs;
}

/** True when `scriptAbs` sits at `<skills-root>/<skill>/<script>` without escaping via symlink. */
function isValidSkillScriptTarget(projectCwd: string, scriptAbs: string): boolean {
  if (path.basename(scriptAbs).toUpperCase() === "SKILL.MD") {
    log.debug("skill_script_target_is_skill_md", { scriptAbs });
    return false;
  }
  try {
    if (fs.lstatSync(scriptAbs).isSymbolicLink()) {
      log.debug("skill_script_target_leaf_symlink", { scriptAbs });
      return false;
    }
  } catch {
    // non-existent path: checked structurally below
  }
  const realAbs = realpathNearestExisting(scriptAbs) ?? scriptAbs;
  const area = skillAreaOf(projectCwd, scriptAbs);
  let valid = false;
  if (area === "owned") {
    const root = ownedSkillsRoot(projectCwd);
    valid =
      root !== null &&
      isUnder(root, realAbs) &&
      !hasSymlinkComponent(root, scriptAbs) &&
      path.relative(root, realAbs).split(path.sep).length >= 2;
  } else if (area === "user-global") {
    const home = os.homedir();
    valid = [path.join(home, ".pi", "agent", "skills"), path.join(home, ".agents", "skills")].some((root) => {
      const resolvedRoot = realpathNearestExisting(root) ?? root;
      return (
        isUnder(resolvedRoot, realAbs) &&
        !hasSymlinkComponent(resolvedRoot, realAbs) &&
        path.relative(resolvedRoot, realAbs).split(path.sep).length >= 2
      );
    });
  } else if (area === "project-agents") {
    const realCwd = realpathNearestExisting(projectCwd) ?? path.resolve(projectCwd);
    const root =
      realpathNearestExisting(path.join(realCwd, ".agents", "skills")) ?? path.join(realCwd, ".agents", "skills");
    valid =
      isUnder(root, realAbs) &&
      !hasSymlinkComponent(root, realAbs) &&
      path.relative(root, realAbs).split(path.sep).length >= 2;
  } else if (area === "package") {
    const segs = scriptAbs.split(path.sep);
    const nm = segs.lastIndexOf("node_modules");
    const skillsIdx = nm >= 0 ? segs.indexOf("skills", nm) : -1;
    if (skillsIdx > nm && segs.length - skillsIdx - 1 >= 2) {
      const pkgRoot = segs.slice(0, skillsIdx).join(path.sep) || path.sep;
      const pkgSkillsRoot = segs.slice(0, skillsIdx + 1).join(path.sep) || path.sep;
      let skillsDirIsSymlink = false;
      try {
        skillsDirIsSymlink = fs.lstatSync(pkgSkillsRoot).isSymbolicLink();
      } catch {
        // non-existent package skills root in synthetic path checks
      }
      const resolvedPkgRoot = realpathNearestExisting(pkgRoot) ?? pkgRoot;
      const resolvedSkillsRoot = realpathNearestExisting(pkgSkillsRoot) ?? pkgSkillsRoot;
      let realStayInside = true;
      try {
        realStayInside = isUnder(fs.realpathSync(pkgSkillsRoot), fs.realpathSync(scriptAbs));
      } catch {
        // non-existent target: covered by realpathNearestExisting + hasSymlinkComponent below
      }
      valid =
        !skillsDirIsSymlink &&
        isUnder(resolvedPkgRoot, resolvedSkillsRoot) &&
        !hasSymlinkComponent(pkgSkillsRoot, scriptAbs) &&
        !hasSymlinkComponent(resolvedSkillsRoot, realAbs) &&
        isUnder(resolvedSkillsRoot, realAbs) &&
        realStayInside &&
        path.relative(resolvedSkillsRoot, realAbs).split(path.sep).length >= 2;
    }
  } else {
    // Linked git worktree: `.pi/skills/<skill>/<script>` resolved relative to worktree cwd without symlinks.
    const realCwd = realpathNearestExisting(projectCwd) ?? path.resolve(projectCwd);
    const wtRoot = path.join(realCwd, ".pi", "skills");
    valid =
      isUnder(wtRoot, realAbs) &&
      !hasSymlinkComponent(wtRoot, realAbs) &&
      path.relative(wtRoot, realAbs).split(path.sep).length >= 2;
  }
  log.debug("skill_script_target_check", { scriptAbs, area, valid });
  return valid;
}

/**
 * Evaluate whether the segment executes an allowed read-only/unmarked skill helper script
 * (`.sh`, `.py`, `.mjs`, `.js`) directly, via `bash`/`sh` (no `-c`), via `uv run [--script]`,
 * or via `node` (no `-e`), and references no other skill path.
 *
 * Refuses scripts inside `skill-maintenance: auto` marked project skills: those skills are
 * agent-writable, so running a script there would let an agent modify protected skills.
 */
function isAllowedSkillScriptExec(
  projectCwd: string,
  plainWords: string[],
  cmdIdx: number,
  segmentRefs: readonly ShellSkillReference[],
): { allow: boolean; reason?: string } {
  const args = plainWords.slice(cmdIdx);
  if (args.length === 0 || segmentRefs.length === 0) return { allow: false };

  let scriptIdx = -1;
  let extRe: RegExp | undefined;
  const head = args[0];

  if (head.includes("/")) {
    scriptIdx = 0;
    extRe = /\.(?:sh|py|mjs|js)$/i;
  } else if (head === "bash" || head === "sh" || /^(?:\/usr)?\/bin\/(?:ba)?sh$/.test(head)) {
    scriptIdx = args[1] === "--" ? 2 : 1;
    extRe = /\.sh$/i;
  } else if (head === "node") {
    scriptIdx = args[1] === "--" ? 2 : 1;
    extRe = /\.(?:mjs|js)$/i;
  } else if (head === "uv" && args[1] === "run") {
    let k = 2;
    while (k < args.length && args[k].startsWith("-")) {
      const flag = args[k];
      if (flag === "--") { k++; break; }
      if (SAFE_UV_FLAGS.has(flag)) { k++; continue; }
      if (SAFE_UV_VALUE_FLAGS.has(flag)) { k += 2; continue; }
      if (/^--(?:with|python)=/.test(flag)) { k++; continue; }
      log.debug("skill_shell_uv_unsafe_flag", { flag });
      return { allow: false };
    }
    if (args[k] === "python" || args[k] === "python3") {
      k++;
      if (args[k] === "--") k++;
    }
    scriptIdx = k;
    extRe = /\.py$/i;
  }

  const scriptToken = scriptIdx >= 0 ? args[scriptIdx] : undefined;
  if (!scriptToken || !extRe || !extRe.test(scriptToken)) {
    log.debug("skill_shell_script_not_matched", { head, scriptToken: scriptToken ?? null });
    return { allow: false };
  }
  const scriptAbs = path.resolve(projectCwd, scriptToken);
  if (!isValidSkillScriptTarget(projectCwd, scriptAbs)) return { allow: false };
  if (!segmentRefs.every((ref) => ref.abs === scriptAbs)) {
    log.debug("skill_shell_script_extra_ref", { script: scriptAbs });
    return { allow: false };
  }
  if (args.some((arg, idx) => idx !== scriptIdx && SKILL_MENTION_RE.test(arg))) {
    log.debug("skill_shell_script_arg_mentions_skill", { script: scriptAbs });
    return { allow: false };
  }

  const realAbs = realpathNearestExisting(scriptAbs) ?? scriptAbs;
  const area = skillAreaOf(projectCwd, scriptAbs);
  if (area === "owned" || area === null) {
    const ownedRoot = ownedSkillsRoot(projectCwd);
    const realCwd = realpathNearestExisting(projectCwd) ?? path.resolve(projectCwd);
    const wtRoot = path.join(realCwd, ".pi", "skills");
    const activeRoot = area === "owned" ? ownedRoot : wtRoot;
    const skill = activeRoot ? path.relative(activeRoot, realAbs).split(path.sep)[0] : "";
    const skillMdCandidates = [
      ...(activeRoot && skill ? [path.join(activeRoot, skill, "SKILL.md")] : []),
      ...(ownedRoot && skill && ownedRoot !== activeRoot ? [path.join(ownedRoot, skill, "SKILL.md")] : []),
    ];
    if (skillMdCandidates.some((md) => hasAutoMaintenanceMarker(md)) || hasAutoMaintenanceMarker(scriptAbs)) {
      log.warn("skill_shell_marked_script_refused", { skill, script: scriptAbs });
      return {
        allow: false,
        reason:
          `helper scripts inside marked project skill "${skill || scriptToken}" (${MARKER_LINE}) ` +
          `are agent-writable and cannot be executed via bash.`,
      };
    }
  }

  log.debug("skill_shell_script_allowed", { head, script: scriptAbs });
  return { allow: true };
}

/**
 * Any shell variable expansion. With a `cd` in the command no working directory can be
 * pinned: `$PWD` (and any other variable) expands AFTER the cd, so a reference that
 * `unquoteWord` already turned into an absolute path is not the path the shell uses.
 */
const VARIABLE_EXPANSION_RE = /\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[^}]*\})/;

/**
 * The directory change a command makes, read from the PARSED segments so quoted (`'cd'`)
 * and escaped (`c\d`) forms count — `maskQuoted` blanks exactly those. The target is
 * recorded only for the one pinning shape: the first segment of the first pipeline.
 */
function pinnedCdTarget(projectCwd: string, command: string): { count: number; target: string | null } {
  let count = 0;
  let target: string | null = null;
  const pipelines = splitPipelines(command);
  for (let p = 0; p < pipelines.length; p++) {
    for (let s = 0; s < pipelines[p].length; s++) {
      const words = parseSegment(projectCwd, pipelines[p][s]).words.map((w) => w.value);
      const cmdIdx = commandWordIndex(words);
      if (words[cmdIdx] !== "cd") continue;
      count++;
      if (p === 0 && s === 0 && count === 1) target = words[cmdIdx + 1] ?? null;
    }
  }
  log.debug("skill_shell_cd_scan", { count, target });
  return { count, target };
}

/**
 * Whether a `cd` in the command could change what a skill path means.
 *
 * References are resolved against `projectCwd`, so the guard used to refuse every command
 * that changed directory at all — including `cd <projectCwd> && bash .pi/skills/x/run.sh`,
 * where the cd provably changes nothing. Block only when the cd is unpinnable (not the first
 * segment of the first pipeline, not a literal absolute path, more than one of them, or any
 * variable expansion that expands after the cd) or when a relative reference would resolve
 * elsewhere under it. An absolute literal reference is unaffected by any cd.
 */
function cdChangesSkillMeaning(
  projectCwd: string,
  command: string,
  refs: readonly ShellSkillReference[],
): boolean {
  const { count, target } = pinnedCdTarget(projectCwd, command);
  if (count === 0) return false;
  if (count > 1 || target === null) {
    log.debug("skill_shell_cd_unpinned", { cds: count });
    return true;
  }
  if (!path.isAbsolute(target)) {
    log.debug("skill_shell_cd_relative_target", { target });
    return true;
  }
  if (VARIABLE_EXPANSION_RE.test(command)) {
    log.debug("skill_shell_cd_expansion", { target });
    return true;
  }
  const changes = refs.some(
    (ref) => !path.isAbsolute(ref.token) && path.resolve(target, ref.token) !== ref.abs,
  );
  log.debug("skill_shell_cd_resolved", { target, refs: refs.length, changes });
  return changes;
}

export type ShellVerdict = { block: true; reason: string };

/**
 * Shell guard (Qodo #1079, #1103): the shell reads skills and runs trusted helper scripts,
 * never writes them.
 *
 * A command that names a skills area passes only when EVERY segment is:
 * - an allowlisted read verb (`cat`, `less`, `head`, `tail`, `grep`, `rg`, `ls`, `stat`,
 *   `wc`, `diff`, `md5sum`, `sha256sum`) with no write operator;
 * - `mkdir` inside this project's own skills tree; or
 * - executing a `.sh`/`.py`/`.mjs`/`.js` helper script of an UNMARKED project skill,
 *   user-global skill, or installed package skill, with no write operator (`/dev/null`
 *   sinks and fd duplications like `2>&1` are permitted).
 *
 * No shell write is allowed at all (`>`, `>>`, `>&`, `tee`, `cp`, `mv`, `rm`, `sed -i`,
 * `perl -i`, `chmod`, `touch`, `patch`, inline `python -c` / `node -e` / `bash -c`, etc.).
 * Ambiguity blocks: a bare `SKILL.md`, a `cd` that could change a skill path's meaning, a
 * path through a symlink.
 *
 * Known limit (documented, not widened around): a path built by shell expansion
 * (`t=…; … > "$t"`, `eval`, `find -exec`) carries no literal reference, so no text rule
 * sees it. The file change still reaches the turn-end notice.
 */
export function bashSkillVerdict(projectCwd: string, command: string): ShellVerdict | null {
  if (typeof command !== "string" || command.trim() === "") return null;
  const refs = shellSkillReferences(projectCwd, command);
  const rawMentionsSkill = SKILL_MENTION_RE.test(command) || SKILL_MENTION_RE.test(unquoteWord(command));
  if (refs.length === 0 && !rawMentionsSkill) return null;

  const maskQuoted = (text: string): string =>
    text.replace(QUOTED_SPAN_RE, (match) => (match.startsWith("\\") ? match : " "));
  const block = (reason: string): ShellVerdict => {
    log.warn("skill_shell_blocked", { reason, command: command.slice(0, 200) });
    return { block: true, reason: `⛔ ${reason}` };
  };
  const hint =
    `The shell reads skills (and runs unmarked/read-only helper scripts) but never writes them. Read one with cat/rg/ls; ` +
    `edit a marked skill in ${path.join(projectCwd, ".pi", "skills")}/ with the write/edit tools ` +
    `(run /adopt-skill <name> first if it is not marked yet).`;

  if (refs.some((ref) => ref.bare)) {
    return block(`a bare SKILL.md means whatever the working directory is. ${hint}`);
  }
  const maskedCommand = maskQuoted(command);
  if (cdChangesSkillMeaning(projectCwd, command, refs)) {
    return block(`a command that changes directory cannot be classified against a skill path. ${hint}`);
  }
  // Nested commands run before the outer one: `cat skill $(python3 -c …)`, `<(...)`, `>(...)`.
  if (hasExecutableSubstitution(command)) {
    return block(`this command embeds a nested command (substitution or process substitution). ${hint}`);
  }
  // Options that execute a program for each file turn a "read" into a write.
  if (/\s(?:--pre|--pre-glob|--exec|-exec)\b/.test(maskedCommand)) {
    return block(`this command's options execute another program. ${hint}`);
  }

  const hasHeredoc = /<</.test(maskedCommand);
  const pipelines = splitPipelines(command);
  let totalSegments = 0;
  for (const stages of pipelines) {
    const parsedStages = stages.map((segment) => ({ segment, parsed: parseSegment(projectCwd, segment) }));
    const pipelineMentionsSkill =
      (hasHeredoc && rawMentionsSkill) ||
      parsedStages.some(
        ({ segment, parsed }) =>
          SKILL_MENTION_RE.test(segment) ||
          parsed.words.some((w) => SKILL_MENTION_RE.test(w.value)) ||
          parsed.redirectTargets.some((t) => SKILL_MENTION_RE.test(t)),
      );
    for (const { segment, parsed } of parsedStages) {
      totalSegments++;
      const masked = maskQuoted(segment);
      const plainWords = parsed.words.map((w) => w.value);
      const cmdIdx = commandWordIndex(plainWords);
      const verb = plainWords[cmdIdx] ?? "";
      if (plainWords.slice(cmdIdx + 1).some((w) => /^(?:--pre(?:=|$)|--pre-glob(?:=|$)|--?exec$)/.test(w))) {
        return block(`this command's options execute another program. ${hint}`);
      }
      const segmentRefs = collectSegmentSkillReferences(projectCwd, parsed, cmdIdx);
      const unquotedMentionsSkill = SKILL_MENTION_RE.test(masked);
      const runsInlineCode = segmentRunsInlineCode(parsed, cmdIdx);
      const inlineBodyMentionsSkill =
        runsInlineCode && (pipelineMentionsSkill || plainWords.some((w) => SKILL_MENTION_RE.test(w)));
      const namesSkill = segmentRefs.length > 0 || unquotedMentionsSkill || inlineBodyMentionsSkill;
      if (!namesSkill) continue;

      if (parsed.hasWriteRedirect || BASH_WRITE_VERBS.test(masked)) {
        return block(`this shell command writes (${verb || "?"}) and names a skill. ${hint}`);
      }
      if (READ_ONLY_VERBS.has(verb)) continue;
      if (verb === "mkdir" && segmentRefs.length > 0) {
        // Every operand must be a path this project owns *after* symlinks resolve, and a
        // directory we create must be inside the owned tree — a linked parent escapes it.
        const operands = plainWords.slice(cmdIdx + 1).filter((token) => !token.startsWith("-"));
        const allOperandsAreSkills =
          operands.length > 0 &&
          operands.every((operand) => segmentRefs.some((ref) => ref.abs === path.resolve(projectCwd, operand)));
        const allOwned = segmentRefs.every(
          (ref) => lexicallyUnderSkillsRoot(projectCwd, ref.abs, true) && isOwnedSkillPath(projectCwd, ref.abs),
        );
        if (allOperandsAreSkills && allOwned) continue;
        return block(`mkdir here would create a directory outside this project's own skills tree. ${hint}`);
      }
      const scriptExec = isAllowedSkillScriptExec(projectCwd, plainWords, cmdIdx, segmentRefs);
      if (scriptExec.allow) continue;
      if (scriptExec.reason) return block(`${scriptExec.reason} ${hint}`);
      if (inlineBodyMentionsSkill) {
        return block(`this shell command runs inline code ("${verb || "?"}") that names a skill. ${hint}`);
      }
      return block(`this shell command ("${verb || "?"}") touches a skill path and is not a known read. ${hint}`);
    }
  }
  log.debug("skill_shell_read_allowed", { segments: totalSegments });
  return null;
}

export function registerSkillMaintenance(pi: ExtensionAPI): void {
  // cwd for the completion callback, which gets no ctx
  let currentCwd = process.cwd();
  let turnIndex = 0;
  /** Skills we used this turn, and those already nudged about. Cleared at turn end. */
  let usedSkills = new Set<string>();
  let nudgedSkills = new Set<string>();
  /** Owned-tree snapshot, reconciled at turn end AND at the next turn start. */
  let turnSnapshot = new Map<string, string>();
  /** Paths this process recorded provenance for, during the current turn. */
  let recordedThisTurn = new Set<string>();
  /** Writes allowed at tool_call and not yet confirmed by a successful tool_result. */
  const pendingWrites = new Map<string, { skill: string; file: string; path: string; written: boolean }>();
  /** Skills named by `/skill:` since the last turn ended — they open the next turn. */
  let invokedBeforeTurn = new Set<string>();
  /** Set when a provenance append failed this turn, so the notice can say so. */
  let provenanceFailed = false;
  /** False until the first snapshot is taken, so a cold start reports nothing. */
  let snapshotPrimed = false;

  const turnIdOf = (sessionId: string): string => `${sessionId}:${turnIndex}`;

  /**
   * Report what changed in the owned tree since the last reconcile and hand the
   * caller one line. Deliberately does NOT file whole-tree diffs as provenance:
   * an editor change by the user is nobody's turn (Qodo #1079).
   */
  function reconcile(ctx: any, reason: "turn_end" | "turn_start"): void {
    const root = ownedSkillsRoot(ctx.cwd);
    const after = snapshotSkillTree(root);
    if (!snapshotPrimed) {
      snapshotPrimed = true;
      turnSnapshot = after;
      log.debug("skill_snapshot_primed", { files: after.size });
      return;
    }
    const changes = diffSkillTree(root, turnSnapshot, after);
    turnSnapshot = after;
    if (changes.length === 0) {
      // A write we recorded may have been the only change; keep the failure visible.
      if (provenanceFailed) {
        log.warn("skill_provenance_failed_silent", { reason });
      }
      return;
    }
    log.info("skill_reconcile", { reason, changes: changes.length, provenanceFailed });
    pi.sendMessage(
      {
        customType: "skill-maintenance",
        content: formatSkillReviewNotice(changes, provenanceFailed),
        display: true,
      },
      { triggerTurn: false, deliverAs: "followUp" },
    );
  }

  pi.on("session_start", (_event, ctx) => {
    currentCwd = ctx.cwd;
    turnSnapshot = snapshotSkillTree(ownedSkillsRoot(ctx.cwd));
    snapshotPrimed = true;
  });

  pi.on("turn_start", (_event, ctx) => {
    currentCwd = ctx.cwd;
    turnIndex = ((_event as any)?.turnIndex as number | undefined) ?? turnIndex + 1;
    // A turn aborted after a skill change never reached turn_end: reconcile the
    // leftovers here, before the new turn can add to them.
    try {
      reconcile(ctx, "turn_start");
    } catch (err) {
      log.error("skill_reconcile_start_failed", { reason: String((err as Error)?.message ?? err).slice(0, 200) });
    }
    // `input` fires before turn_start, so keep what it parked for this turn and drop
    // anything an interrupted turn left behind — a stale skill must not be steered,
    // and a stale nudge flag must not silence a real one (Qodo #1079).
    usedSkills = new Set(invokedBeforeTurn);
    invokedBeforeTurn = new Set();
    nudgedSkills = new Set();
    recordedThisTurn = new Set();
    provenanceFailed = false;
  });

  // `/skill:<name>` in the user's message counts as using that skill. Input arrives
  // BEFORE turn_start, so the names are parked and adopted by the turn they open.
  pi.on("input", (event, ctx) => {
    currentCwd = ctx.cwd;
    for (const name of markedSkillsInText(ctx.cwd, (event as any)?.text ?? "")) {
      usedSkills.add(name);
      invokedBeforeTurn.add(name);
    }
  });

  // ── write guard: marked + owned only, for every session ──────────────────
  pi.on("tool_call", (event, ctx) => {
    const toolName = String((event as any)?.toolName ?? "");
    const input = (event as any)?.input;

    if (toolName === "bash") {
      const command = typeof (input as any)?.command === "string" ? (input as any).command : "";
      const shell = bashSkillVerdict(ctx.cwd, command);
      return shell ? { block: true, reason: shell.reason } : undefined;
    }
    if (!WRITE_TOOLS.has(toolName)) return;
    const target = pathFromInput(input);
    if (!target) return;
    const verdict = classifySkillWrite(ctx.cwd, target, input);
    if (!verdict.allow) {
      log.debug("skill_write_blocked", { toolName, target, skill: verdict.skill });
      return { block: true, reason: verdict.reason ?? "skill write blocked" };
    }
    if (!verdict.skill) return;

    // Allowed — but provenance is only written once the tool actually succeeded.
    const resolved = realpathNearestExisting(path.resolve(ctx.cwd, target)) ?? path.resolve(ctx.cwd, target);
    pendingWrites.set(String((event as any)?.toolCallId ?? ""), {
      skill: verdict.skill,
      file: verdict.file ?? "SKILL.md",
      path: resolved,
      written: turnSnapshot.get(resolved) === undefined,
    });
    log.debug("skill_write_allowed", { skill: verdict.skill, file: verdict.file ?? "SKILL.md" });
    return;
  });

  // ── mid-turn nudge + provenance on success ───────────────────────────────
  pi.on("tool_result", (event, ctx) => {
    const input = (event as any)?.input;
    const target = pathFromInput(input);
    if (target) {
      const skill = ownedSkillName(ctx.cwd, target);
      if (skill && isMarkedSkillNamed(ctx.cwd, skill)) usedSkills.add(skill);
    } else if (typeof (input as any)?.command === "string") {
      for (const name of markedSkillsInText(ctx.cwd, (input as any).command)) usedSkills.add(name);
    }

    const callId = String((event as any)?.toolCallId ?? "");
    const pending = pendingWrites.get(callId);
    if (pending) {
      pendingWrites.delete(callId);
      if ((event as any)?.isError === true) {
        log.warn("skill_write_failed_not_recorded", { skill: pending.skill, file: pending.file });
      } else {
        const sessionId = (ctx as any)?.sessionManager?.getSessionId?.() ?? "";
        const ok = appendProvenance(ctx.cwd, [
          {
            skill: pending.skill,
            action: pending.written ? "written" : "patched",
            file: pending.file,
            sessionId,
            turnId: turnIdOf(sessionId),
            at: new Date().toISOString(),
          },
        ]);
        if (!ok) provenanceFailed = true;
        else recordedThisTurn.add(pending.path);
        log.info("skill_write_recorded", { skill: pending.skill, action: pending.written ? "written" : "patched" });
      }
    }

    if ((event as any)?.isError !== true) return;
    for (const skill of usedSkills) {
      if (nudgedSkills.has(skill)) continue;
      nudgedSkills.add(skill);
      log.info("skill_maintenance_nudge", { skill });
      pi.sendMessage(
        {
          customType: "skill-maintenance-nudge",
          content:
            `The guidance from skill \`${skill}\` just failed. Fix the skill now, ` +
            `or state in one line why it still applies.`,
          display: true,
        },
        // "steer": queued behind this tool batch, before the next model call — the
        // only supported mid-turn injection (docs/extensions.md, pi.sendMessage).
        { deliverAs: "steer" },
      );
    }
  });

  // ── end of turn: one line; per-turn state resets here, not at turn start ─
  pi.on("turn_end", (_event, ctx) => {
    try {
      reconcile(ctx, "turn_end");
    } catch (err) {
      log.error("skill_maintenance_turn_end_failed", { reason: String((err as Error)?.message ?? err).slice(0, 200) });
      fileLog("skill-maintenance", "error", "skill-maintenance", "turn_end reconcile failed", err);
    } finally {
      usedSkills = new Set();
      invokedBeforeTurn = new Set();
      nudgedSkills = new Set();
      pendingWrites.clear();
    }
  });

  // ── /adopt-skill ─────────────────────────────────────────────────────────
  pi.registerCommand("adopt-skill", {
    description: "Mark a project skill as maintained (skill-maintenance: auto) so agents may patch it",
    getArgumentCompletions: (prefix: string) => completeUnmarkedSkills(currentCwd, prefix),
    handler: async (args, ctx) => {
      currentCwd = ctx.cwd;
      const name = (args ?? "").trim().split(/\s+/)[0] ?? "";
      if (!name) {
        const available = listUnmarkedSkills(ctx.cwd);
        ctx.ui.notify(
          available.length > 0
            ? `Usage: /adopt-skill <name>. Unmarked project skills: ${available.join(", ")}`
            : "Usage: /adopt-skill <name>. Every project skill is already maintained.",
          "info",
        );
        return;
      }
      const result = adoptSkill(ctx.cwd, name);
      ctx.ui.notify(result.message, result.ok ? "info" : "warning");
    },
  });
}
