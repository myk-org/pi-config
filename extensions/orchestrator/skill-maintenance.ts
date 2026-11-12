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
  if (!isSkillFile && current !== null) {
    if (isMarkedSkill(current)) return { allow: true, path: abs, skill, file };
    log.warn("skill_write_aux_unmarked", { skill: skill ?? null, file: file ?? null });
    return {
      allow: false,
      path: abs,
      skill,
      file,
      reason:
        `⛔ "${skill ?? candidate}" is owned by this project but not marked for maintenance, so its files cannot be edited. ` +
        `Run /adopt-skill ${skill ?? "<name>"}.`,
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
const BASH_WRITE_OPERATOR = /[>]|\btee\b|\bcp\b|\bmv\b|\brm\b|\bsed\s+-[a-z]*i|\binstall\b|\bdd\b|\btruncate\b|\bchmod\b/;

/** Shell control operators that start a new command. */
const SHELL_SEPARATORS = /(?:&&|\|\||;|\||\n)/;

/**
 * Replace quoted text with spaces: an operator or a verb inside quotes is an argument.
 * The quoted text is still scanned separately for a skills path, so it cannot hide one.
 */
function maskQuoted(command: string): string {
  return command.replace(/'(?:[^'\\]|\\.)*'/g, " ").replace(/"(?:[^"\\]|\\.)*"/g, " ");
}

/** Expand the literal home forms a shell would expand, so they cannot hide a path. */
function expandHomeToken(token: string): string {
  return token
    .replace(/^~(?=$|\/)/, os.homedir())
    .replace(/^\$\{?HOME\}?(?=$|\/)/, os.homedir());
}

/** Whitespace/operator split, quotes and leading redirections stripped. */
function shellTokens(segment: string): string[] {
  return segment
    .split(/[\s;|&()<>`]+/)
    .map((token) => expandHomeToken(token.replace(/^[0-9&]?>+/, "").replace(/["']/g, "")))
    .filter(Boolean);
}

/** Lexically inside a skills directory we know, even when it does not resolve there. */
function lexicallyUnderSkillsRoot(projectCwd: string, abs: string): boolean {
  const realCwd = realpathNearestExisting(resolveMainCheckoutRoot(projectCwd)) ?? path.resolve(projectCwd);
  const roots = [
    path.join(realCwd, ".pi", "skills"),
    path.join(realCwd, ".agents", "skills"),
    path.join(os.homedir(), ".pi", "agent", "skills"),
    path.join(os.homedir(), ".agents", "skills"),
  ];
  return roots.some((root) => {
    const rel = path.relative(root, abs);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  });
}

export interface ShellSkillReference {
  token: string;
  abs: string;
  /** Resolved area, or null when the path's meaning cannot be established. */
  area: SkillArea | null;
  /** A bare `SKILL.md`: its meaning depends on the cwd, so it can never be classified. */
  bare: boolean;
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
  for (const token of shellTokens(command)) {
    if (token === "cd") continue;
    // `--option=/path/to/skill` carries its path after the `=`; a bare filename value
    // (`--glob=SKILL.md`) is a pattern, not a target, and must not become a reference.
    const candidates = token.includes("=") ? [token, token.slice(token.indexOf("=") + 1)] : [token];
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

export type ShellVerdict = { block: true; reason: string };

/**
 * Shell guard (Qodo #1079): the shell reads skills, never writes them.
 *
 * A command that names a skills area passes only when EVERY segment is a read — an
 * allowlisted verb (`cat`, `less`, `head`, `tail`, `grep`, `rg`, `ls`, `stat`, `wc`,
 * `diff`, `md5sum`, `sha256sum`) with no write operator. `mkdir` is the single
 * exception, and only inside this project's own skills tree, so a new skill directory
 * can be created; the file itself still has to be written with `write`/`edit`, where
 * ownership and the marker apply and the write is audited.
 *
 * No shell write is allowed at all. Every previous version tried to classify writes
 * (`cp` source vs destination, `-t`, `--target-directory`, `>&`, pipelines) and each
 * shape was another bypass; a read-only rule cannot be chipped at. Ambiguity blocks:
 * a bare `SKILL.md`, a `cd` into a skills area, a path through a symlink.
 *
 * Known limit (documented, not widened around): a path built by shell expansion
 * (`t=…; … > "$t"`, `eval`, `find -exec`) carries no literal reference, so no text rule
 * sees it. The file change still reaches the turn-end notice.
 */
export function bashSkillVerdict(projectCwd: string, command: string): ShellVerdict | null {
  if (typeof command !== "string" || command.trim() === "") return null;
  const refs = shellSkillReferences(projectCwd, command);
  const rawMentionsSkill = /skills[\\/]|\bSKILL\.md\b/.test(command);
  if (refs.length === 0 && !rawMentionsSkill) return null;

  const block = (reason: string): ShellVerdict => {
    log.warn("skill_shell_blocked", { reason, command: command.slice(0, 200) });
    return { block: true, reason: `⛔ ${reason}` };
  };
  const hint =
    `The shell reads skills but never writes them. Read one with cat/rg/ls; ` +
    `edit a marked skill in ${path.join(projectCwd, ".pi", "skills")}/ with the write/edit tools ` +
    `(run /adopt-skill <name> first if it is not marked yet).`;

  if (refs.some((ref) => ref.bare)) {
    return block(`a bare SKILL.md means whatever the working directory is. ${hint}`);
  }
  if (/(?:^|[\s;&|])cd\s/.test(maskQuoted(command))) {
    return block(`a command that changes directory cannot be classified against a skill path. ${hint}`);
  }
  // Nested commands run before the outer one: `cat skill $(python3 -c …)` writes first.
  if (/\$\(|`/.test(command)) {
    return block(`this command embeds a command substitution, which can run any program. ${hint}`);
  }
  // Options that execute a program for each file turn a "read" into a write.
  if (/\s(?:--pre|--pre-glob|--exec|-exec)\b/.test(maskQuoted(command))) {
    return block(`this command's options execute another program. ${hint}`);
  }

  const segments = command.split(SHELL_SEPARATORS).map((segment) => segment.trim()).filter(Boolean);
  for (const segment of segments) {
    const masked = maskQuoted(segment);
    const verb = shellTokens(masked)[0] ?? "";
    const segmentRefs = shellSkillReferences(projectCwd, segment);
    const namesSkill =
      segmentRefs.length > 0 || /skills[\\/]|\bSKILL\.md\b/.test(segment) || rawMentionsSkill;
    if (!namesSkill) continue;

    if (BASH_WRITE_OPERATOR.test(masked)) {
      return block(`this shell command writes (${verb || "?"}) and names a skill. ${hint}`);
    }
    if (READ_ONLY_VERBS.has(verb)) continue;
    if (verb === "mkdir" && segmentRefs.length > 0) {
      // Every operand must be a path this project owns *after* symlinks resolve, and a
      // directory we create must be inside the owned tree — a linked parent escapes it.
      const operands = shellTokens(masked).filter((token, index) => index > 0 && !token.startsWith("-"));
      const allOperandsAreSkills = operands.every((operand) =>
        segmentRefs.some((ref) => ref.abs === path.resolve(projectCwd, operand)),
      );
      const allOwned = segmentRefs.every(
        (ref) => allOwnedLexical(projectCwd, ref.abs) && isOwnedSkillPath(projectCwd, ref.abs),
      );
      if (allOperandsAreSkills && allOwned) continue;
      return block(`mkdir here would create a directory outside this project's own skills tree. ${hint}`);
    }
    return block(`this shell command ("${verb || "?"}") touches a skill path and is not a known read. ${hint}`);
  }
  log.debug("skill_shell_read_allowed", { segments: segments.length });
  return null;
}

/** True when `abs` sits lexically inside this project's own `.pi/skills/`. */
function allOwnedLexical(projectCwd: string, abs: string): boolean {
  const lexicalRoot = path.join(realpathNearestExisting(resolveMainCheckoutRoot(projectCwd)) ?? path.resolve(projectCwd), ".pi", "skills");
  const rel = path.relative(lexicalRoot, abs);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
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
