/**
 * Post-turn skill review (issue #1074).
 *
 * Skills are effectively write-once: `skill-creator` makes one and dreaming may
 * promote another, but nothing patches a skill that has drifted. After a
 * substantive turn this spawns a small review agent that may patch — or create —
 * **this project's own** skills, then reports what changed in one line:
 *
 *   📙 Self-improvement review: Skill 'x' patched · Skill 'y' written (references/z.md)
 *
 * Ownership is decided by real path: only files whose real path sits under
 * `<project>/.pi/skills/` may be written. Shipped package skills, user-global
 * skills, and anything behind a symlink that resolves outside are somebody
 * else's files — patching them is data loss we cannot see coming.
 *
 * The reviewer's output is not read: the parent derives every change from a
 * before/after snapshot of the owned tree, so provenance and the notice do not
 * depend on the agent telling the truth.
 */

import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../shared/logger.js";
import { fileLog } from "../shared/file-logger.js";
import { isPiOneshotInvocation } from "../shared/oneshot.js";
import { decideAsyncLlmDispatch } from "./async-capability.js";
import { discoverAgents } from "./agents.js";
import { getSetting } from "./project-settings.js";
import { getProjectDataDir } from "./utils.js";

const log = createLogger("skill-review");

/** Child agent name — the write guard is scoped to it (async children carry PI_AGENT_NAME). */
export const SKILL_REVIEW_AGENT = "skill-reviewer";

/** Provenance trail, one JSON line per written file. */
export const PROVENANCE_FILE = "skill-review.jsonl";

/** Minimum gap between reviews. A turn is substantive often; an LLM call per turn is not cheap. */
const MIN_INTERVAL_MS = 5 * 60 * 1000;

const PROVENANCE_CAP = 2000;

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

/** The project's own skills directory, with symlinks resolved. */
export function ownedSkillsRoot(projectCwd: string): string {
  const realCwd = realpathNearestExisting(projectCwd) ?? path.resolve(projectCwd);
  return realpathNearestExisting(path.join(realCwd, ".pi", "skills")) ?? path.join(realCwd, ".pi", "skills");
}

/**
 * Pure ownership predicate: true only for a real path inside the project's own
 * `.pi/skills/`. Prefix-string matching is not enough — a symlink inside the
 * directory resolves elsewhere, and that file is not ours.
 */
export function isOwnedSkillPath(projectCwd: string, candidate: string): boolean {
  if (typeof candidate !== "string" || candidate.trim() === "") return false;
  const root = ownedSkillsRoot(projectCwd);
  const target = realpathNearestExisting(path.resolve(projectCwd, candidate));
  if (!target) return false;
  const rel = path.relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** Skill name owning a path, or null when it is not an owned skill file. */
export function ownedSkillName(projectCwd: string, candidate: string): string | null {
  if (!isOwnedSkillPath(projectCwd, candidate)) return null;
  const root = ownedSkillsRoot(projectCwd);
  const rel = path.relative(root, realpathNearestExisting(path.resolve(projectCwd, candidate))!);
  const name = rel.split(path.sep)[0];
  return name && name !== "" ? name : null;
}

/**
 * Snapshot every regular file in the owned tree (path → mtime:size). Symlinks
 * are not followed: a link is not a file we own, whatever it points at.
 */
export function snapshotSkillTree(root: string): Map<string, string> {
  const snapshot = new Map<string, string>();
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
  root: string,
  before: Map<string, string>,
  after: Map<string, string>,
): SkillChange[] {
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
export function formatSkillReviewNotice(changes: readonly SkillChange[]): string {
  const perSkill = new Map<string, SkillChange>();
  for (const change of changes) {
    if (!perSkill.has(change.skill)) perSkill.set(change.skill, change);
  }
  const parts = [...perSkill.values()].map((change) =>
    change.action === "written"
      ? `Skill '${change.skill}' written (${change.file})`
      : `Skill '${change.skill}' patched`,
  );
  return parts.length === 0 ? "" : `\u{1F4D9} Self-improvement review: ${parts.join(" \u00b7 ")}`;
}

export function provenancePath(projectCwd: string): string {
  return path.join(getProjectDataDir(projectCwd), PROVENANCE_FILE);
}

/** Append provenance records; keeps the trail bounded. Never throws. */
export function appendProvenance(projectCwd: string, records: readonly SkillProvenance[]): boolean {
  if (records.length === 0) return false;
  const file = provenancePath(projectCwd);
  try {
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf-8").split("\n").filter(Boolean) : [];
    const lines = [...existing, ...records.map((record) => JSON.stringify(record))];
    const kept = lines.slice(-PROVENANCE_CAP);
    fs.writeFileSync(file, `${kept.join("\n")}\n`, { mode: 0o600 });
    return true;
  } catch (err) {
    log.warn("provenance_append_failed", { reason: String((err as Error)?.message ?? err).slice(0, 200) });
    fileLog("skill-review", "warn", "skill-review", "provenance append failed", err);
    return false;
  }
}

/** True when this process is the review child (async children carry PI_AGENT_NAME). */
export function isSkillReviewerChild(): boolean {
  return process.env.PI_AGENT_NAME === SKILL_REVIEW_AGENT;
}

const WRITE_TOOLS = new Set(["write", "edit", "multi_edit", "apply_patch", "applypatch"]);

/**
 * Guard for the review child: writes only inside the owned tree, and no shell
 * (a shell would route around the path check in one line).
 */
export function evaluateReviewWrite(
  projectCwd: string,
  toolName: string,
  input: unknown,
): { block: true; reason: string } | null {
  if (toolName === "bash") {
    return {
      block: true,
      reason: "skill review: no shell — write only inside this project's .pi/skills/",
    };
  }
  if (!WRITE_TOOLS.has(toolName)) return null;
  const args = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const target = args.path ?? args.file_path ?? args.filePath;
  if (typeof target === "string" && isOwnedSkillPath(projectCwd, target)) return null;
  return {
    block: true,
    reason: `skill review: ${toolName} is limited to ${ownedSkillsRoot(projectCwd)} — that directory is the only file you may touch`,
  };
}

/** Compact, bounded description of the finished turn for the review agent. */
export function buildTurnDigest(
  message: unknown,
  toolResults: unknown,
  maxChars = 2500,
): string {
  const parts: string[] = [];
  const content = (message as any)?.content;
  if (typeof content === "string") parts.push(content);
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === "string") parts.push(block);
      else if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
    }
  }
  const text = parts.join("\n").trim();
  const lines: string[] = [];
  if (text) lines.push(`Assistant said:\n${text.slice(0, maxChars)}`);
  if (Array.isArray(toolResults)) {
    const calls = toolResults.slice(0, 20).map((result: any) => {
      const input = result?.input ?? {};
      const detail = input.path ?? input.command ?? input.query ?? "";
      return `- ${String(result?.toolName ?? "tool")} ${String(detail).slice(0, 120)}`.trim();
    });
    if (calls.length > 0) lines.push(`Tools used:\n${calls.join("\n")}`);
  }
  return lines.join("\n\n").slice(0, maxChars * 2);
}

export function buildReviewPrompt(projectCwd: string, digest: string, reviewRoot: string): string {
  return (
    `Skill review — did this project's own skills drift during the turn below?\n\n` +
    `Owned skills directory (the ONLY place you may write): ${reviewRoot}\n` +
    `Project: ${projectCwd}\n\n` +
    `Rules:\n` +
    `- Patch an existing skill only when the turn contradicts it: a command or path it documents changed, ` +
    `a step it teaches was wrong, or a case it must cover was learned the hard way. Edit its SKILL.md or add/edit a references/*.md.\n` +
    `- Create a new skill (${reviewRoot}/<name>/SKILL.md, with YAML frontmatter name + description) only for a multi-step workflow this turn proved reusable.\n` +
    `- Write nothing when neither applies. That is the normal outcome — do not touch a skill to look busy.\n` +
    `- No shell, no file outside the owned directory, no git. Report nothing: the caller records what changed from the filesystem.\n\n` +
    `Turn:\n${digest || "(no digest available)"}`
  );
}

export function registerSkillReview(
  pi: ExtensionAPI,
  spawnAsyncAgent: (
    agentName: string,
    task: string,
    cwd: string,
    agents: any[],
    options?: {
      fireAndForget?: boolean;
      name?: string;
      parentModelId?: string;
      parentProvider?: string;
      onComplete?: (result: { text: string; isError: boolean }) => void;
    },
  ) => { id: string; error?: string },
): void {
  // The review child gets the write guard; the parent gets the review itself.
  if (isSkillReviewerChild()) {
    pi.on("tool_call", (event, ctx) => {
      const toolName = String((event as any)?.toolName ?? "");
      const verdict = evaluateReviewWrite(ctx.cwd, toolName, (event as any)?.input);
      if (verdict) {
        log.warn("skill_reviewer_write_blocked", { toolName });
        return verdict;
      }
      return undefined;
    });
    return;
  }
  if (process.env.PI_SUBAGENT_CHILD === "1") return;
  if (isPiOneshotInvocation()) {
    log.info("skip register: oneshot print/json");
    return;
  }

  // A blocked tool call never runs (no result in turn_end's toolResults), so the
  // only place to see it is tool_execution_end — a call that did not execute has
  // no durationMs. Such a turn is not a lesson; skip the review.
  let blockedThisTurn = false;
  let reviewInFlight = false;
  let lastReviewAt = 0;

  pi.on("turn_start", () => {
    blockedThisTurn = false;
  });

  pi.on("tool_execution_end", (event) => {
    if ((event as any)?.durationMs === undefined) blockedThisTurn = true;
  });

  pi.on("turn_end", async (event, ctx) => {
    try {
      const mode = (ctx as any)?.mode;
      if (mode === "print" || mode === "json") return;
      if (blockedThisTurn) {
        log.debug("skill_review_skipped_blocked_turn");
        return;
      }
      // Substantive = the turn used tools. A plain answer teaches no command.
      const toolResults = (event as any)?.toolResults;
      if (!Array.isArray(toolResults) || toolResults.length === 0) return;
      if (reviewInFlight) {
        log.debug("skill_review_skipped_in_flight");
        return;
      }
      if (Date.now() - lastReviewAt < MIN_INTERVAL_MS) {
        log.debug("skill_review_skipped_interval");
        return;
      }
      if (getSetting(ctx.cwd, "skill_review") === false) return;

      const parentProvider = (ctx as any)?.model?.provider as string | undefined;
      const dispatch = decideAsyncLlmDispatch({ parentProvider, cwd: ctx.cwd, mustAsync: true });
      if (dispatch.action === "skip") {
        log.debug("skill_review_skipped_no_async_llm", dispatch.note);
        return;
      }

      const reviewRoot = ownedSkillsRoot(ctx.cwd);
      const before = snapshotSkillTree(reviewRoot);
      const sessionId = (ctx as any)?.sessionManager?.getSessionId?.() ?? "";
      const turnIndex = (event as any)?.turnIndex;
      const turnId = `${sessionId}:${turnIndex ?? "?"}`;
      const digest = buildTurnDigest((event as any)?.message, toolResults);
      const { agents } = discoverAgents(ctx.cwd, "user");

      reviewInFlight = true;
      lastReviewAt = Date.now();
      const sidecar = dispatch.action === "sidecar-async" ? dispatch.sidecar : undefined;
      const { id } = spawnAsyncAgent(
        SKILL_REVIEW_AGENT,
        buildReviewPrompt(ctx.cwd, digest, reviewRoot),
        ctx.cwd,
        agents,
        {
          // Silent on purpose: the reply text is not consumed — the notice and the
          // provenance trail come from the filesystem diff below, not from the agent.
          fireAndForget: true,
          name: "Skill review",
          parentModelId: sidecar?.model,
          parentProvider: sidecar?.provider,
          onComplete: () => {
            reviewInFlight = false;
            try {
              const changes = diffSkillTree(reviewRoot, before, snapshotSkillTree(reviewRoot));
              if (changes.length === 0) {
                log.debug("skill_review_no_changes", { turnId });
                return;
              }
              const at = new Date().toISOString();
              const records: SkillProvenance[] = changes.map((change) => ({
                ...change,
                sessionId,
                turnId,
                at,
              }));
              appendProvenance(ctx.cwd, records);
              log.info("skill_review_changes", { turnId, changes: records.length });
              pi.sendMessage(
                {
                  customType: "skill-review",
                  content: formatSkillReviewNotice(changes),
                  display: true,
                },
                { triggerTurn: false, deliverAs: "followUp" },
              );
            } catch (err) {
              log.error("skill_review_post_failed", { reason: String((err as Error)?.message ?? err).slice(0, 200) });
              fileLog("skill-review", "error", "skill-review", "post-review reconcile failed", err);
            }
          },
        },
      );
      if (!id) {
        reviewInFlight = false;
        log.warn("skill_review_spawn_failed");
      } else {
        log.debug("skill_review_spawned", { id, turnId });
      }
    } catch (err) {
      log.error("skill_review_failed", { reason: String((err as Error)?.message ?? err).slice(0, 200) });
      fileLog("skill-review", "error", "skill-review", "turn review failed", err);
    }
  });
}
