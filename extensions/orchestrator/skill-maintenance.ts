/**
 * Skill maintenance (issues #1074, #1147, #1155).
 *
 * Non-blocking skill maintenance without a background model call:
 * - Pi's `pi.getCommands()` supplies loaded skills across project, user, and symlinked
 *   shared directories (plus a lightweight `.pi/skills/` fallback before `/reload`);
 * - `/adopt-skill <name>` stamps `skill-maintenance: auto` on any non-package skill
 *   (brand-new `<project>/.pi/skills/<name>/SKILL.md` writes auto-adopt);
 * - failed adopted skills steer mid-turn; edits log to `.pi/data/skill-review.jsonl`
 *   with a one-line turn summary.
 */

import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../shared/logger.js";
import { fileLog } from "../shared/file-logger.js";
import { getProjectDataDir, resolveMainCheckoutRoot } from "./utils.js";

const log = createLogger("skill-maintenance");
const errMsg = (err: unknown): string => String((err as Error)?.message ?? err).slice(0, 200);

export const MARKER_KEY = "skill-maintenance";
export const MARKER_VALUE = "auto";
export const MARKER_LINE = `${MARKER_KEY}: ${MARKER_VALUE}`;
export const PROVENANCE_FILE = "skill-review.jsonl";
export const MAINTAINER_INSTRUCTION =
  "**IMPORTANT — keep this skill true:** this skill is adopted and it is your responsibility to fix or improve it " +
  "whenever it is wrong, incomplete, or misleading while you use it (and its description, if routing was wrong), " +
  "then say one line: `Skill updated: <name> — <why>`.";

const PROVENANCE_MAX_BYTES = 1_000_000;
const PROVENANCE_KEEP_LINES = 2000;
const MAX_SKILL_DEPTH = 32;
const WRITE_TOOLS = new Set(["write", "edit", "multi_edit"]);
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SKILL_INVOCATION_RE = /\/skill:([A-Za-z0-9][A-Za-z0-9._-]*)/g;
const MARKER_LINE_RE = new RegExp(`^\\s*${MARKER_KEY}\\s*:\\s*${MARKER_VALUE}\\s*$`);

export type SkillChangeAction = "patched" | "written";
export interface SkillChange {
  skill: string;
  action: SkillChangeAction;
  file: string;
}
export interface SkillProvenance extends SkillChange {
  sessionId: string;
  turnId: string;
  at: string;
}
export interface RegisteredSkillInfo {
  name: string;
  filePath: string;
  baseDir: string;
  scope: "project" | "user" | "temporary";
  origin: "package" | "top-level";
}
export interface AdoptResult {
  ok: boolean;
  message: string;
}

// ── paths & discovery ───────────────────────────────────────────────────────

export function realpathNearestExisting(target: string): string | null {
  let current = path.resolve(target);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
    } catch (err) {
      const parent = path.dirname(current);
      if (parent === current) {
        log.warn("realpath_unsupported", { target, reason: errMsg(err) });
        return null;
      }
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

function isAtOrUnder(root: string, abs: string): boolean {
  const rel = path.relative(root, abs);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function hasPackageSkillSegments(p: string): boolean {
  const segs = p.split(path.sep);
  const nm = segs.indexOf("node_modules");
  return nm >= 0 && segs.indexOf("skills", nm) > nm;
}

/** True when `candidate` (raw or resolved) sits under `node_modules/.../skills/`. */
export function isPackageSkillPath(candidate: string): boolean {
  if (typeof candidate !== "string" || candidate.trim() === "") return false;
  const resolved = path.resolve(candidate);
  const real = realpathNearestExisting(resolved);
  return hasPackageSkillSegments(candidate) || hasPackageSkillSegments(resolved) || (real !== null && hasPackageSkillSegments(real));
}

/** True when `targetPath`'s realpath points at a registered `origin === "package"` skill. */
export function isRegisteredPackageTarget(targetPath: string, skills?: readonly RegisteredSkillInfo[]): boolean {
  if (!skills?.length || typeof targetPath !== "string" || targetPath.trim() === "") return false;
  const resolved = path.resolve(targetPath);
  const realTarget = realpathNearestExisting(resolved) ?? resolved;
  for (const skill of skills) {
    if (skill.origin !== "package") continue;
    const realFile = realpathNearestExisting(skill.filePath) ?? path.resolve(skill.filePath);
    if (realTarget === realFile) return true;
    if (path.basename(skill.filePath) === "SKILL.md") {
      const realBase = realpathNearestExisting(skill.baseDir) ?? path.resolve(skill.baseDir);
      if (isAtOrUnder(realBase, realTarget)) return true;
    }
  }
  return false;
}

/** Extract every loaded skill from Pi's `ExtensionAPI.getCommands()` output. */
export function skillsFromCommands(
  commands: ReadonlyArray<{
    name?: string;
    source?: string;
    sourceInfo?: { path?: string; baseDir?: string; scope?: string; origin?: string };
  }>,
): RegisteredSkillInfo[] {
  const out: RegisteredSkillInfo[] = [];
  for (const cmd of commands) {
    if (cmd.source !== "skill") continue;
    if (typeof cmd.name !== "string" || !cmd.name.startsWith("skill:")) {
      log.warn("skill_command_malformed", { reason: "invalid_name", name: cmd.name ?? null });
      continue;
    }
    const name = cmd.name.slice("skill:".length);
    const rawPath = cmd.sourceInfo?.path;
    if (!name || typeof rawPath !== "string" || rawPath.trim() === "") {
      log.warn("skill_command_malformed", { reason: "missing_path", name: cmd.name });
      continue;
    }
    const filePath = path.resolve(rawPath);
    // Derive baseDir from filePath: Pi sets sourceInfo.baseDir to the scope root, not the skill dir.
    const rawScope = cmd.sourceInfo?.scope;
    const scope: RegisteredSkillInfo["scope"] =
      rawScope === "project" || rawScope === "user" || rawScope === "temporary" ? rawScope : "temporary";
    const origin: RegisteredSkillInfo["origin"] = cmd.sourceInfo?.origin === "package" ? "package" : "top-level";
    out.push({ name, filePath, baseDir: path.dirname(filePath), scope, origin });
  }
  return out;
}

/** True when a skill may be adopted (excludes shipped package skills and symlinks to them). */
export function isAdoptableSkill(skill: RegisteredSkillInfo, allSkills?: readonly RegisteredSkillInfo[]): boolean {
  if (skill.origin === "package" || isPackageSkillPath(skill.filePath) || isPackageSkillPath(skill.baseDir)) {
    return false;
  }
  if (isRegisteredPackageTarget(skill.filePath, allSkills)) return false;
  if (path.basename(skill.filePath) === "SKILL.md" && isRegisteredPackageTarget(skill.baseDir, allSkills)) {
    return false;
  }
  return true;
}

function projectSkillsRoots(projectCwd: string): string[] {
  const roots: string[] = [];
  for (const base of [projectCwd, resolveMainCheckoutRoot(projectCwd)]) {
    const dir = path.join(realpathNearestExisting(base) ?? path.resolve(base), ".pi", "skills");
    if (!roots.includes(dir)) roots.push(dir);
  }
  return roots;
}

function readSkillContent(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    log.debug("skill_read_failed", { filePath, reason: errMsg(err) });
    return null;
  }
}

function fallbackProjectSkill(
  projectCwd: string,
  name: string,
  allSkills?: readonly RegisteredSkillInfo[],
): RegisteredSkillInfo | null {
  for (const root of projectSkillsRoots(projectCwd)) {
    const dir = path.join(root, name);
    try {
      const filePath = path.join(dir, "SKILL.md");
      if (!fs.statSync(dir).isDirectory() || !fs.statSync(filePath).isFile()) continue;
      const isPkg =
        isPackageSkillPath(dir) ||
        isPackageSkillPath(filePath) ||
        isRegisteredPackageTarget(dir, allSkills) ||
        isRegisteredPackageTarget(filePath, allSkills);
      return { name, filePath, baseDir: dir, scope: "project", origin: isPkg ? "package" : "top-level" };
    } catch (err) {
      log.debug("fallback_project_skill_unavailable", { name, dir, reason: errMsg(err) });
    }
  }
  return null;
}

function listFallbackProjectSkills(projectCwd: string, allSkills?: readonly RegisteredSkillInfo[]): RegisteredSkillInfo[] {
  const byName = new Map<string, RegisteredSkillInfo>();
  for (const root of projectSkillsRoots(projectCwd)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (err) {
      log.debug("fallback_project_skills_readdir_failed", { root, reason: errMsg(err) });
      continue;
    }
    for (const entry of entries) {
      if ((!entry.isDirectory() && !entry.isSymbolicLink()) || byName.has(entry.name)) continue;
      const skill = fallbackProjectSkill(projectCwd, entry.name, allSkills);
      if (skill) byName.set(skill.name, skill);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function matchSkillPath(
  projectCwd: string,
  abs: string,
  skills?: readonly RegisteredSkillInfo[],
): { skill: RegisteredSkillInfo; file: string } | null {
  const realAbs = realpathNearestExisting(abs) ?? abs;
  const search = (list: readonly RegisteredSkillInfo[]) => {
    for (const skill of list) {
      const realBase = realpathNearestExisting(skill.baseDir) ?? skill.baseDir;
      const realFile = realpathNearestExisting(skill.filePath) ?? skill.filePath;
      if (path.basename(skill.filePath) !== "SKILL.md") {
        if (abs === skill.filePath || realAbs === realFile) return { skill, file: path.basename(skill.filePath) };
        continue;
      }
      if (isAtOrUnder(skill.baseDir, abs)) return { skill, file: path.relative(skill.baseDir, abs) || "." };
      if (isAtOrUnder(realBase, realAbs)) return { skill, file: path.relative(realBase, realAbs) || "." };
      if (realAbs === realFile) return { skill, file: "SKILL.md" };
    }
    return null;
  };
  return (skills?.length ? search(skills) : null) ?? search(listFallbackProjectSkills(projectCwd, skills));
}

function isBrandNewSkillFile(abs: string): boolean {
  try {
    fs.lstatSync(abs);
    return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return true;
    log.warn("skill_lstat_failed", { abs, reason: errMsg(err) });
    return false;
  }
}

function brandNewProjectSkillName(projectCwd: string, abs: string): string | null {
  const realAbs = realpathNearestExisting(abs) ?? abs;
  for (const root of projectSkillsRoots(projectCwd)) {
    for (const [base, target] of [[root, abs], [realpathNearestExisting(root) ?? root, realAbs]] as const) {
      const rel = path.relative(base, target);
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
      const parts = rel.split(path.sep);
      if (parts.length === 2 && parts[1] === "SKILL.md" && SKILL_NAME_RE.test(parts[0])) return parts[0];
    }
  }
  return null;
}

// ── marker & /adopt-skill ───────────────────────────────────────────────────

export function isMarkedSkill(content: string): boolean {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  return match !== null && match[1].split(/\r?\n/).some((line) => MARKER_LINE_RE.test(line));
}

export function stampSkill(content: string): { content: string; changed: boolean } {
  if (isMarkedSkill(content) && content.includes("IMPORTANT — keep this skill true")) {
    return { content, changed: false };
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  let stamped: string;
  if (match === null) {
    stamped = `---\n${MARKER_LINE}\n---\n\n${MAINTAINER_INSTRUCTION}\n\n${content.replace(/^\s*\n/, "")}`;
  } else {
    const fm = isMarkedSkill(content) ? match[1] : `${match[1]}\n${MARKER_LINE}`;
    const body = content.slice(match[0].length).replace(/^\r?\n+/, "");
    const nextBody = body.includes("IMPORTANT — keep this skill true") ? body : `${MAINTAINER_INSTRUCTION}\n\n${body}`;
    stamped = `---\n${fm}\n---\n\n${nextBody}`;
  }
  return { content: stamped, changed: stamped !== content };
}

function allAdoptableSkills(projectCwd: string, skills?: readonly RegisteredSkillInfo[]): Map<string, RegisteredSkillInfo> {
  const byName = new Map<string, RegisteredSkillInfo>();
  for (const skill of [...(skills ?? []), ...listFallbackProjectSkills(projectCwd, skills)]) {
    if (isAdoptableSkill(skill, skills) && !byName.has(skill.name)) byName.set(skill.name, skill);
  }
  return byName;
}

function collectAdoptableUnmarkedSkills(projectCwd: string, skills?: readonly RegisteredSkillInfo[]): RegisteredSkillInfo[] {
  const unmarked: RegisteredSkillInfo[] = [];
  for (const skill of allAdoptableSkills(projectCwd, skills).values()) {
    const content = readSkillContent(skill.filePath);
    if (content !== null && !isMarkedSkill(content)) unmarked.push(skill);
  }
  return unmarked.sort((a, b) => a.name.localeCompare(b.name));
}

export function listUnmarkedSkills(projectCwd: string, skills?: readonly RegisteredSkillInfo[]): string[] {
  return collectAdoptableUnmarkedSkills(projectCwd, skills).map((s) => s.name);
}

export function completeUnmarkedSkills(
  projectCwd: string,
  prefix: string,
  skills?: readonly RegisteredSkillInfo[],
): Array<{ value: string; label: string; description?: string }> {
  const needle = (prefix ?? "").trim().toLowerCase();
  return collectAdoptableUnmarkedSkills(projectCwd, skills)
    .filter((s) => s.name.toLowerCase().includes(needle))
    .map((s) => ({ value: s.name, label: s.name, description: `${s.scope} — mark for maintenance` }));
}

export function adoptSkill(projectCwd: string, name: string, skills?: readonly RegisteredSkillInfo[]): AdoptResult {
  if (!name) return { ok: false, message: "Usage: /adopt-skill <name>" };
  if (!SKILL_NAME_RE.test(name)) {
    log.warn("adopt_skill_bad_name", { name });
    return { ok: false, message: `"${name}" is not a skill name — use a bare skill name.` };
  }
  const matched = skills?.find((s) => s.name === name) ?? fallbackProjectSkill(projectCwd, name, skills);
  if (!matched) {
    log.warn("adopt_skill_not_found", { name });
    return { ok: false, message: `No skill named "${name}" found.` };
  }
  if (!isAdoptableSkill(matched, skills)) {
    log.warn("adopt_skill_package_refused", { name, file: matched.filePath });
    return { ok: false, message: `"${name}" is a shipped package skill and cannot be adopted.` };
  }
  try {
    const { content: stamped, changed } = stampSkill(fs.readFileSync(matched.filePath, "utf-8"));
    if (!changed) return { ok: true, message: `Skill "${name}" is already maintained.` };
    fs.writeFileSync(matched.filePath, stamped, "utf-8");
    log.info("adopt_skill_marked", { name, file: matched.filePath, scope: matched.scope });
    return { ok: true, message: `✅ Skill "${name}" is now maintained.` };
  } catch (err) {
    log.error("adopt_skill_failed", { name, reason: errMsg(err) });
    return { ok: false, message: `Could not update ${matched.filePath}: ${(err as Error)?.message ?? err}` };
  }
}

export function markedSkillsInText(projectCwd: string, text: string, skills?: readonly RegisteredSkillInfo[]): string[] {
  if (typeof text !== "string" || !text) return [];
  const byName = allAdoptableSkills(projectCwd, skills);
  const found = new Set<string>();
  const addIfMarked = (skill: RegisteredSkillInfo | undefined): void => {
    if (!skill || found.has(skill.name)) return;
    const content = readSkillContent(skill.filePath);
    if (content !== null && isMarkedSkill(content)) found.add(skill.name);
  };
  for (const match of text.matchAll(SKILL_INVOCATION_RE)) addIfMarked(byName.get(match[1]));
  for (const skill of byName.values()) {
    const realBase = realpathNearestExisting(skill.baseDir);
    if (text.includes(skill.baseDir) || (realBase !== null && text.includes(realBase))) addIfMarked(skill);
  }
  return [...found];
}

// ── snapshot, diff, notice & provenance ─────────────────────────────────────

export function snapshotSkillTree(root: string | null): Map<string, string> {
  const snapshot = new Map<string, string>();
  if (!root) return snapshot;
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_SKILL_DEPTH) {
      log.warn("skill_snapshot_depth_cap", { dir, max: MAX_SKILL_DEPTH });
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      const level = (err as NodeJS.ErrnoException)?.code === "ENOENT" ? "debug" : "warn";
      log[level]("skill_snapshot_readdir_failed", { dir, reason: errMsg(err) });
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { walk(full, depth + 1); continue; }
      if (!entry.isFile()) continue;
      try {
        const stat = fs.statSync(full);
        snapshot.set(full, `${stat.mtimeMs}:${stat.size}`);
      } catch (err) {
        log.warn("skill_snapshot_stat_failed", { full, reason: errMsg(err) });
      }
    }
  };
  walk(root, 0);
  return snapshot;
}

export function diffSkillTree(root: string | null, before: Map<string, string>, after: Map<string, string>): SkillChange[] {
  if (!root) return [];
  const skillsBefore = new Set([...before.keys()].map((f) => path.relative(root, f).split(path.sep)[0]));
  const changes: SkillChange[] = [];
  for (const [file, stamp] of after) {
    if (before.get(file) === stamp) continue;
    const [skill, ...rest] = path.relative(root, file).split(path.sep);
    if (!skill || rest.length === 0) continue;
    changes.push({ skill, action: skillsBefore.has(skill) ? "patched" : "written", file: rest.join(path.sep) });
  }
  return changes.sort((a, b) => a.skill.localeCompare(b.skill) || a.file.localeCompare(b.file));
}

export function formatSkillReviewNotice(changes: readonly SkillChange[], provenanceFailed = false): string {
  const perSkill = new Map<string, SkillChange>();
  for (const c of changes) if (!perSkill.has(c.skill)) perSkill.set(c.skill, c);
  const parts = [...perSkill.values()].map((c) =>
    c.action === "written" ? `Skill '${c.skill}' written (${c.file})` : `Skill '${c.skill}' patched`,
  );
  if (parts.length === 0) return "";
  const suffix = provenanceFailed ? " · provenance write failed — .pi/data/skill-review.jsonl not updated" : "";
  return `\u{1F4D9} Self-improvement review: ${parts.join(" \u00b7 ")}${suffix}`;
}

export function provenancePath(projectCwd: string): string {
  return path.join(getProjectDataDir(projectCwd), PROVENANCE_FILE);
}

export function appendProvenance(projectCwd: string, records: readonly SkillProvenance[]): boolean {
  if (records.length === 0) return true;
  const file = provenancePath(projectCwd);
  try {
    fs.appendFileSync(file, records.map((r) => `${JSON.stringify(r)}\n`).join(""), { mode: 0o600 });
    rotateProvenance(file);
    return true;
  } catch (err) {
    log.error("provenance_append_failed", { reason: errMsg(err) });
    fileLog("skill-maintenance", "error", "skill-maintenance", "provenance append failed", err);
    return false;
  }
}

export function rotateProvenance(file: string): void {
  try {
    if (fs.statSync(file).size <= PROVENANCE_MAX_BYTES) return;
    const kept = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean).slice(-PROVENANCE_KEEP_LINES);
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, `${kept.join("\n")}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
    log.info("provenance_rotated", { kept: kept.length });
  } catch (err) {
    log.warn("provenance_rotate_failed", { reason: errMsg(err) });
  }
}

// ── registration ────────────────────────────────────────────────────────────

function pathFromInput(input: unknown): string | null {
  const args = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath"]) {
    if (typeof args[key] === "string" && args[key]) return args[key] as string;
  }
  return null;
}

export function registerSkillMaintenance(pi: ExtensionAPI): void {
  let currentCwd = process.cwd();
  let turnIndex = 0;
  let usedSkills = new Set<string>();
  let nudgedSkills = new Set<string>();
  let invokedBeforeTurn = new Set<string>();
  let turnSnapshot = new Map<string, string>();
  let recordedChangesThisTurn: SkillChange[] = [];
  const pendingWrites = new Map<string, { skill: string; file: string; written: boolean }>();
  let provenanceFailed = false;
  let snapshotPrimed = false;

  const getLiveSkills = (): RegisteredSkillInfo[] => {
    try {
      const skills = skillsFromCommands(typeof pi.getCommands === "function" ? pi.getCommands() : []);
      log.debug("skills_from_pi_commands", { count: skills.length });
      return skills;
    } catch (err) {
      log.warn("skills_from_pi_commands_failed", { reason: errMsg(err) });
      return [];
    }
  };

  function reconcile(ctx: any, reason: "turn_end" | "turn_start"): void {
    const root = projectSkillsRoots(ctx.cwd)[0];
    const after = snapshotSkillTree(root);
    const treeChanges = snapshotPrimed ? diffSkillTree(root, turnSnapshot, after) : [];
    snapshotPrimed = true;
    turnSnapshot = after;
    const merged = new Map<string, SkillChange>();
    for (const change of [...recordedChangesThisTurn.splice(0), ...treeChanges]) {
      const key = `${change.skill}:${change.file}`;
      if (!merged.has(key)) merged.set(key, change);
    }
    const changes = [...merged.values()].sort((a, b) => a.skill.localeCompare(b.skill) || a.file.localeCompare(b.file));
    if (changes.length === 0) {
      if (provenanceFailed) log.warn("skill_provenance_failed_silent", { reason });
      return;
    }
    log.info("skill_reconcile", { reason, changes: changes.length, provenanceFailed });
    pi.sendMessage(
      { customType: "skill-maintenance", content: formatSkillReviewNotice(changes, provenanceFailed), display: true },
      { triggerTurn: false, deliverAs: "followUp" },
    );
  }

  pi.on("session_start", (_event, ctx) => {
    currentCwd = ctx.cwd;
    turnSnapshot = snapshotSkillTree(projectSkillsRoots(ctx.cwd)[0]);
    snapshotPrimed = true;
  });

  pi.on("turn_start", (event, ctx) => {
    currentCwd = ctx.cwd;
    turnIndex = ((event as any)?.turnIndex as number | undefined) ?? turnIndex + 1;
    try { reconcile(ctx, "turn_start"); } catch (err) { log.error("skill_reconcile_start_failed", { reason: errMsg(err) }); }
    usedSkills = new Set(invokedBeforeTurn);
    invokedBeforeTurn = new Set();
    nudgedSkills = new Set();
    provenanceFailed = false;
  });

  pi.on("input", (event, ctx) => {
    currentCwd = ctx.cwd;
    for (const name of markedSkillsInText(ctx.cwd, (event as any)?.text ?? "", getLiveSkills())) {
      usedSkills.add(name);
      invokedBeforeTurn.add(name);
    }
  });

  pi.on("tool_call", (event, ctx) => {
    const toolName = String((event as any)?.toolName ?? "");
    if (!WRITE_TOOLS.has(toolName)) return;
    const input = (event as any)?.input;
    const target = pathFromInput(input);
    if (!target) return;

    const abs = path.resolve(ctx.cwd, target);
    const liveSkills = getLiveSkills();
    const callId = String((event as any)?.toolCallId ?? "");

    if (toolName === "write" && typeof (input as any)?.content === "string") {
      const newSkill = brandNewProjectSkillName(ctx.cwd, abs);
      if (newSkill && isBrandNewSkillFile(abs) && !isPackageSkillPath(abs) && !isRegisteredPackageTarget(abs, liveSkills)) {
        if (!isMarkedSkill((input as any).content)) {
          (input as any).content = stampSkill((input as any).content).content;
          log.info("skill_creation_auto_adopted", { skill: newSkill, target });
        }
        pendingWrites.set(callId, { skill: newSkill, file: "SKILL.md", written: true });
        return;
      }
    }

    const matched = matchSkillPath(ctx.cwd, abs, liveSkills);
    if (!matched) return;
    pendingWrites.set(callId, { skill: matched.skill.name, file: matched.file, written: isBrandNewSkillFile(abs) });
    log.debug("skill_write_tracked", { skill: matched.skill.name, file: matched.file });
  });

  pi.on("tool_result", (event, ctx) => {
    const liveSkills = getLiveSkills();
    const input = (event as any)?.input;
    const target = pathFromInput(input);
    if (target) {
      const matched = matchSkillPath(ctx.cwd, path.resolve(ctx.cwd, target), liveSkills);
      if (matched && isAdoptableSkill(matched.skill, liveSkills)) {
        const content = readSkillContent(matched.skill.filePath);
        if (content !== null && isMarkedSkill(content)) usedSkills.add(matched.skill.name);
      }
    } else if (typeof (input as any)?.command === "string") {
      for (const name of markedSkillsInText(ctx.cwd, (input as any).command, liveSkills)) usedSkills.add(name);
    }

    const pending = pendingWrites.get(String((event as any)?.toolCallId ?? ""));
    if (pending) {
      pendingWrites.delete(String((event as any)?.toolCallId ?? ""));
      if ((event as any)?.isError === true) {
        log.warn("skill_write_failed_not_recorded", { skill: pending.skill, file: pending.file });
      } else {
        const action: SkillChangeAction = pending.written ? "written" : "patched";
        recordedChangesThisTurn.push({ skill: pending.skill, action, file: pending.file });
        const sessionId = (ctx as any)?.sessionManager?.getSessionId?.() ?? "";
        const ok = appendProvenance(ctx.cwd, [
          { skill: pending.skill, action, file: pending.file, sessionId, turnId: `${sessionId}:${turnIndex}`, at: new Date().toISOString() },
        ]);
        if (!ok) provenanceFailed = true;
        log.info("skill_write_recorded", { skill: pending.skill, action, file: pending.file });
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
          content: `The guidance from skill \`${skill}\` just failed. Fix the skill now, or state in one line why it still applies.`,
          display: true,
        },
        { deliverAs: "steer" },
      );
    }
  });

  pi.on("turn_end", (_event, ctx) => {
    try {
      reconcile(ctx, "turn_end");
    } catch (err) {
      log.error("skill_maintenance_turn_end_failed", { reason: errMsg(err) });
      fileLog("skill-maintenance", "error", "skill-maintenance", "turn_end reconcile failed", err);
    } finally {
      usedSkills = new Set();
      invokedBeforeTurn = new Set();
      nudgedSkills = new Set();
      pendingWrites.clear();
      provenanceFailed = false;
    }
  });

  pi.registerCommand("adopt-skill", {
    description: "Mark a skill as maintained (skill-maintenance: auto) so agents keep it true",
    getArgumentCompletions: (prefix: string) => completeUnmarkedSkills(currentCwd, prefix, getLiveSkills()),
    handler: async (args, ctx) => {
      currentCwd = ctx.cwd;
      const liveSkills = getLiveSkills();
      const name = (args ?? "").trim().split(/\s+/)[0] ?? "";
      if (!name) {
        const available = listUnmarkedSkills(ctx.cwd, liveSkills);
        ctx.ui.notify(
          available.length > 0
            ? `Usage: /adopt-skill <name>. Unmarked skills: ${available.join(", ")}`
            : "Usage: /adopt-skill <name>. Every adoptable skill is already maintained.",
          "info",
        );
        return;
      }
      const result = adoptSkill(ctx.cwd, name, liveSkills);
      ctx.ui.notify(result.message, result.ok ? "info" : "warning");
    },
  });
}
