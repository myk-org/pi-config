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
import { getProjectDataDir } from "./utils.js";

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
      return tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
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
  const realCwd = realpathNearestExisting(projectCwd) ?? path.resolve(projectCwd);
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
  if (typeof candidate !== "string" || candidate.trim() === "") return false;
  const root = ownedSkillsRoot(projectCwd);
  if (!root) return false;
  const target = realpathNearestExisting(path.resolve(projectCwd, candidate));
  if (!target) return false;
  if (hasSymlinkComponent(root, target)) {
    log.warn("owned_skill_symlink_refused", { candidate });
    return false;
  }
  const rel = path.relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
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

export type SkillArea = "owned" | "package" | "user-global" | "third-party";

/** Which skills area a path belongs to, or null when it is not a skill file at all. */
export function skillAreaOf(projectCwd: string, candidate: string): SkillArea | null {
  const abs = path.resolve(projectCwd, candidate);
  if (isOwnedSkillPath(projectCwd, abs)) return "owned";
  const segments = abs.split(path.sep);
  const skillsAt = segments.lastIndexOf("skills");
  // Anything at or below a skills/ directory that we do not own is somebody else's —
  // including a file sitting directly in `.pi/skills/` through a symlink.
  const isSkillFile = skillsAt >= 0 && segments.length > skillsAt + 1;
  if (!isSkillFile) return null;
  if (segments.includes("node_modules")) return "package";
  const home = os.homedir();
  for (const globalRoot of [path.join(home, ".pi", "agent", "skills"), path.join(home, ".agents", "skills")]) {
    const rel = path.relative(globalRoot, abs);
    if (rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) {
      return "user-global";
    }
  }
  return "third-party";
}

/** New text a write/edit call would land in the file. */
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
  newText: string,
): SkillWriteVerdict {
  const abs = path.resolve(projectCwd, candidate);
  const area = skillAreaOf(projectCwd, abs);
  if (area === null) return { allow: true, path: abs };

  // Lexically inside our own skills dir but not owned: a symlink (dangling or
  // resolved) put it, or the whole `.pi/skills` dir, outside the project.
  const lexicalRoot = path.join(realpathNearestExisting(projectCwd) ?? path.resolve(projectCwd), ".pi", "skills");
  const lexicalRel = path.relative(lexicalRoot, abs);
  const lexicallyInSkills =
    lexicalRel !== "" && lexicalRel !== ".." && !lexicalRel.startsWith(`..${path.sep}`) && !path.isAbsolute(lexicalRel);
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
    return {
      allow: false,
      path: abs,
      reason:
        `⛔ ${candidate} is a skill shipped in the pi package (node_modules) — product surface, never edited. ` +
        `Copy it into ${path.join(projectCwd, ".pi", "skills")}/ and run /adopt-skill <name> to maintain a local copy.`,
    };
  }
  if (area === "user-global") {
    return {
      allow: false,
      path: abs,
      reason:
        `⛔ ${candidate} is a user-global skill (~/.pi/agent/skills or ~/.agents/skills) — shared by every project, never edited. ` +
        `Copy it into ${path.join(projectCwd, ".pi", "skills")}/ and run /adopt-skill <name>.`,
    };
  }

  const skill = ownedSkillName(projectCwd, abs) ?? undefined;
  const root = ownedSkillsRoot(projectCwd);
  const file = root && skill ? path.relative(path.join(root, skill), abs) : undefined;

  if (area === "third-party") {
    return {
      allow: false,
      path: abs,
      skill,
      file,
      reason:
        `⛔ ${candidate} is shipped or third-party (outside ${path.join(projectCwd, ".pi", "skills")}) — product surface we never edit in place. ` +
        `Copy it into ${path.join(projectCwd, ".pi", "skills")}/ and run /adopt-skill <name> to maintain a local copy.`,
    };
  }

  const current = skill ? readSkillFile(projectCwd, skill) : null;
  const marked = current !== null && isMarkedSkill(current);
  if (marked || isMarkedSkill(newText)) {
    return { allow: true, path: abs, skill, file };
  }
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
  if (!root) return snapshot;
  const walk = (dir: string, depth: number): void => {
    if (depth > 8) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // absent tree — nothing owned yet
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = fs.statSync(full);
        snapshot.set(full, `${stat.mtimeMs}:${stat.size}`);
      } catch {
        // vanished mid-walk — treat as untouched
      }
    }
  };
  walk(root, 0);
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
    if (!skill || rest.length === 0) continue;
    changes.push({
      skill,
      action: skillsBefore.has(skill) ? "patched" : "written",
      file: rest.join(path.sep),
    });
  }
  return changes.sort((a, b) => a.skill.localeCompare(b.skill) || a.file.localeCompare(b.file));
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
 * Trim an over-large trail to its newest lines.
 * shortcut: the trim is a read-modify-write, so a write that lands inside the trim
 * window can be lost — it only runs once the file passes 1 MB, and the audit value
 * of the newest lines outweighs the growth of an unbounded file.
 */
function rotateProvenance(file: string): void {
  try {
    if (fs.statSync(file).size <= PROVENANCE_MAX_BYTES) return;
    const kept = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean).slice(-PROVENANCE_KEEP_LINES);
    fs.writeFileSync(file, `${kept.join("\n")}\n`, { mode: 0o600 });
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
  const file = path.join(root, name, "SKILL.md");
  if (!fs.existsSync(file)) {
    const elsewhere = isMarkedSkillAnywhere(projectCwd, name);
    log.info("adopt_skill_refused", { name, existsElsewhere: elsewhere });
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
function isMarkedSkillAnywhere(projectCwd: string, name: string): boolean {
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

export function registerSkillMaintenance(pi: ExtensionAPI): void {
  // cwd for the completion callback, which gets no ctx
  let currentCwd = process.cwd();
  let turnIndex = 0;
  /** Skills we used this turn, and those already nudged about. */
  let usedSkills = new Set<string>();
  let nudgedSkills = new Set<string>();
  /** Owned-tree snapshot at turn start, for the end-of-turn notice. */
  let turnSnapshot = new Map<string, string>();
  /** Paths whose provenance record was already written at write time. */
  let recordedThisTurn = new Set<string>();

  const turnIdOf = (sessionId: string): string => `${sessionId}:${turnIndex}`;

  pi.on("session_start", (_event, ctx) => {
    currentCwd = ctx.cwd;
  });

  pi.on("turn_start", (_event, ctx) => {
    currentCwd = ctx.cwd;
    turnIndex = ((_event as any)?.turnIndex as number | undefined) ?? turnIndex + 1;
    usedSkills = new Set();
    nudgedSkills = new Set();
    recordedThisTurn = new Set();
    turnSnapshot = snapshotSkillTree(ownedSkillsRoot(ctx.cwd));
  });

  // `/skill:<name>` in the user's message counts as using that skill.
  pi.on("input", (event, ctx) => {
    currentCwd = ctx.cwd;
    for (const name of markedSkillsInText(ctx.cwd, (event as any)?.text ?? "")) usedSkills.add(name);
  });

  // ── write guard: marked + owned only, for every session ──────────────────
  pi.on("tool_call", (event, ctx) => {
    const toolName = String((event as any)?.toolName ?? "");
    if (!WRITE_TOOLS.has(toolName)) return; // bash stays available to the main agent
    const target = pathFromInput((event as any)?.input);
    if (!target) return;
    const verdict = classifySkillWrite(ctx.cwd, target, incomingText((event as any)?.input));
    if (!verdict.allow) {
      log.warn("skill_write_blocked", { toolName, target, skill: verdict.skill });
      return { block: true, reason: verdict.reason ?? "skill write blocked" };
    }
    if (!verdict.skill) return;

    // Attribution comes from the call itself, not from a whole-tree diff.
    const resolved = realpathNearestExisting(path.resolve(ctx.cwd, target)) ?? path.resolve(ctx.cwd, target);
    const previous = turnSnapshot.get(resolved);
    const sessionId = (ctx as any)?.sessionManager?.getSessionId?.() ?? "";
    const record: SkillProvenance = {
      skill: verdict.skill,
      action: previous === undefined ? "written" : "patched",
      file: verdict.file ?? "SKILL.md",
      sessionId,
      turnId: turnIdOf(sessionId),
      at: new Date().toISOString(),
    };
    if (appendProvenance(ctx.cwd, [record])) recordedThisTurn.add(resolved);
    log.info("skill_write_allowed", { skill: record.skill, action: record.action, file: record.file });
    return;
  });

  // ── mid-turn nudge: a marked skill we used just failed ───────────────────
  pi.on("tool_result", (event, ctx) => {
    const input = (event as any)?.input;
    const target = pathFromInput(input);
    if (target) {
      const skill = ownedSkillName(ctx.cwd, target);
      if (skill && isMarkedSkillNamed(ctx.cwd, skill)) usedSkills.add(skill);
    } else if (typeof (input as any)?.command === "string") {
      for (const name of markedSkillsInText(ctx.cwd, (input as any).command)) usedSkills.add(name);
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

  // ── end of turn: one line, and any writes not already recorded ───────────
  pi.on("turn_end", (_event, ctx) => {
    try {
      const root = ownedSkillsRoot(ctx.cwd);
      const changes = diffSkillTree(root, turnSnapshot, snapshotSkillTree(root));
      if (changes.length === 0) return;

      const sessionId = (ctx as any)?.sessionManager?.getSessionId?.() ?? "";
      const at = new Date().toISOString();
      const turnId = turnIdOf(sessionId);
      const unrecorded: SkillProvenance[] = changes
        .filter((change) => {
          const abs = root ? path.join(root, change.skill, change.file) : "";
          return !recordedThisTurn.has(abs);
        })
        .map((change) => ({ ...change, sessionId, turnId, at }));
      const provenanceOk = appendProvenance(ctx.cwd, unrecorded);

      pi.sendMessage(
        {
          customType: "skill-maintenance",
          content: formatSkillReviewNotice(changes, !provenanceOk),
          display: true,
        },
        { triggerTurn: false, deliverAs: "followUp" },
      );
      log.info("skill_maintenance_notice", { changes: changes.length, provenanceOk });
    } catch (err) {
      log.error("skill_maintenance_turn_end_failed", { reason: String((err as Error)?.message ?? err).slice(0, 200) });
      fileLog("skill-maintenance", "error", "skill-maintenance", "turn_end reconcile failed", err);
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
