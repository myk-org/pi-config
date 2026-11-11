/**
 * Post-turn skill review (issue #1074).
 *
 * The review may patch only this project's own skills. Ownership is a real-path
 * predicate — a symlink inside `.pi/skills/` that resolves outside, a shipped
 * package skill, and a user-global skill are all somebody else's files — and the
 * provenance trail plus the one-line notice are derived from a filesystem diff,
 * not from what the review agent claims it did.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  appendProvenance,
  buildReviewPrompt,
  buildTurnDigest,
  diffSkillTree,
  evaluateReviewWrite,
  formatSkillReviewNotice,
  isOwnedSkillPath,
  isSkillReviewerChild,
  ownedSkillName,
  ownedSkillsRoot,
  provenancePath,
  registerSkillReview,
  SKILL_REVIEW_AGENT,
  snapshotSkillTree,
} from "../../../extensions/orchestrator/skill-review.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

const cleanups: Array<() => void> = [];
const envBackup: Record<string, string | undefined> = {};

function project(): { cwd: string; skills: string } {
  const cwd = makeTempDir("skill-review-");
  const skills = path.join(cwd, ".pi", "skills");
  fs.mkdirSync(skills, { recursive: true });
  cleanups.push(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return { cwd, skills };
}

function writeSkill(skills: string, name: string, body = "# Skill\n"): string {
  const dir = path.join(skills, name);
  fs.mkdirSync(path.join(dir, "references"), { recursive: true });
  const file = path.join(dir, "SKILL.md");
  fs.writeFileSync(file, body);
  return file;
}

beforeEach(() => {
  for (const key of ["PI_SUBAGENT_CHILD", "PI_AGENT_NAME", "PI_SKILL_REVIEW"]) {
    envBackup[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of Object.keys(envBackup)) {
    if (envBackup[key] === undefined) delete process.env[key];
    else process.env[key] = envBackup[key];
  }
  while (cleanups.length > 0) cleanups.pop()!();
});

describe("ownership predicate — real path under <project>/.pi/skills (issue #1074)", () => {
  it("owns an existing skill file and a new file inside an owned skill", () => {
    const { cwd, skills } = project();
    const file = writeSkill(skills, "searxng");
    assert.equal(isOwnedSkillPath(cwd, file), true);
    assert.equal(isOwnedSkillPath(cwd, path.join(skills, "searxng", "references", "api.md")), true);
    // a skill that does not exist yet is still ours to create
    assert.equal(isOwnedSkillPath(cwd, path.join(skills, "new-skill", "SKILL.md")), true);
    assert.equal(ownedSkillName(cwd, file), "searxng");
  });

  it("rejects the skills directory itself and paths outside it", () => {
    const { cwd, skills } = project();
    writeSkill(skills, "searxng");
    assert.equal(isOwnedSkillPath(cwd, skills), false);
    assert.equal(isOwnedSkillPath(cwd, path.join(cwd, ".pi", "memory", "lessons.md")), false);
    assert.equal(isOwnedSkillPath(cwd, path.join(cwd, "extensions", "orchestrator", "rules.ts")), false);
    assert.equal(isOwnedSkillPath(cwd, path.join(skills, "..", "..", "outside.md")), false);
    assert.equal(isOwnedSkillPath(cwd, ""), false);
    assert.equal(ownedSkillName(cwd, path.join(cwd, "README.md")), null);
  });

  it("rejects a symlink inside .pi/skills that resolves outside", () => {
    const { cwd, skills } = project();
    const outside = makeTempDir("skill-review-outside-");
    cleanups.push(() => fs.rmSync(outside, { recursive: true, force: true }));
    fs.mkdirSync(path.join(outside, "victim"), { recursive: true });
    fs.writeFileSync(path.join(outside, "victim", "SKILL.md"), "# Victim\n");
    fs.symlinkSync(path.join(outside, "victim"), path.join(skills, "linked"));

    assert.equal(isOwnedSkillPath(cwd, path.join(skills, "linked", "SKILL.md")), false);
    assert.equal(isOwnedSkillPath(cwd, path.join(skills, "linked", "new.md")), false);
    assert.equal(ownedSkillName(cwd, path.join(skills, "linked", "SKILL.md")), null);
  });

  it("rejects shipped package skills and user-global skills", () => {
    const { cwd } = project();
    const packageSkills = makeTempDir("skill-review-package-");
    cleanups.push(() => fs.rmSync(packageSkills, { recursive: true, force: true }));
    const shipped = path.join(packageSkills, "node_modules", "pi-orchestrator-config", "skills", "conflict-resolver");
    fs.mkdirSync(shipped, { recursive: true });
    fs.writeFileSync(path.join(shipped, "SKILL.md"), "# Shipped\n");

    const global = makeTempDir("skill-review-global-");
    cleanups.push(() => fs.rmSync(global, { recursive: true, force: true }));
    fs.mkdirSync(path.join(global, "homeassistant"), { recursive: true });
    fs.writeFileSync(path.join(global, "homeassistant", "SKILL.md"), "# Global\n");

    assert.equal(isOwnedSkillPath(cwd, path.join(shipped, "SKILL.md")), false);
    assert.equal(isOwnedSkillPath(cwd, path.join(global, "homeassistant", "SKILL.md")), false);
    assert.equal(ownedSkillName(cwd, path.join(global, "homeassistant", "SKILL.md")), null);
  });
});

describe("filesystem diff — what the review actually did", () => {
  it("reports a modified skill as patched and a new skill as written", () => {
    const { cwd, skills } = project();
    const existing = writeSkill(skills, "searxng");
    const root = ownedSkillsRoot(cwd);
    const before = snapshotSkillTree(root);

    fs.writeFileSync(existing, "# SearXNG\n\nnew step\n");
    fs.mkdirSync(path.join(skills, "homeassistant"), { recursive: true });
    fs.writeFileSync(path.join(skills, "homeassistant", "SKILL.md"), "# Home Assistant\n");

    const changes = diffSkillTree(root, before, snapshotSkillTree(root));
    assert.deepEqual(changes, [
      { skill: "homeassistant", action: "written", file: "SKILL.md" },
      { skill: "searxng", action: "patched", file: "SKILL.md" },
    ]);
  });

  it("does not follow symlinks out of the owned tree", () => {
    const { cwd, skills } = project();
    const outside = makeTempDir("skill-review-outside-");
    cleanups.push(() => fs.rmSync(outside, { recursive: true, force: true }));
    fs.writeFileSync(path.join(outside, "SKILL.md"), "# Outside\n");
    fs.symlinkSync(outside, path.join(skills, "linked"));
    assert.equal(snapshotSkillTree(ownedSkillsRoot(cwd)).size, 0);
  });
});

describe("one-line notice", () => {
  it("names each skill once, in one line, and names the written file", () => {
    const notice = formatSkillReviewNotice([
      { skill: "image-pixel-measurement", action: "patched", file: "SKILL.md" },
      { skill: "image-pixel-measurement", action: "patched", file: "references/x.md" },
      { skill: "homeassistant", action: "written", file: "references/voice-pe-ecosystem.md" },
    ]);
    assert.equal(
      notice,
      "\u{1F4D9} Self-improvement review: Skill 'image-pixel-measurement' patched \u00b7 " +
        "Skill 'homeassistant' written (references/voice-pe-ecosystem.md)",
    );
    assert.equal(notice.split("\n").length, 1);
  });

  it("is empty when nothing changed", () => {
    assert.equal(formatSkillReviewNotice([]), "");
  });
});

describe("provenance", () => {
  it("appends skill, action, file, sessionId and turnId per written file", () => {
    const { cwd } = project();
    const ok = appendProvenance(cwd, [
      { skill: "searxng", action: "patched", file: "SKILL.md", sessionId: "s1", turnId: "s1:4", at: "2026-01-01T00:00:00.000Z" },
    ]);
    assert.equal(ok, true);
    const lines = fs.readFileSync(provenancePath(cwd), "utf-8").trim().split("\n");
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), {
      skill: "searxng",
      action: "patched",
      file: "SKILL.md",
      sessionId: "s1",
      turnId: "s1:4",
      at: "2026-01-01T00:00:00.000Z",
    });
  });
});

describe("write guard for the review child", () => {
  it("allows owned skill writes and blocks everything else", () => {
    const { cwd, skills } = project();
    const owned = path.join(skills, "searxng", "SKILL.md");

    assert.equal(evaluateReviewWrite(cwd, "write", { path: owned }), null);
    assert.equal(evaluateReviewWrite(cwd, "edit", { path: owned }), null);
    assert.equal(evaluateReviewWrite(cwd, "read", { path: owned }), null);

    assert.equal(evaluateReviewWrite(cwd, "write", { path: path.join(cwd, "src", "index.ts") })?.block, true);
    assert.equal(evaluateReviewWrite(cwd, "edit", { path: "/home/user/.pi/agent/skills/homeassistant/SKILL.md" })?.block, true);
    assert.equal(evaluateReviewWrite(cwd, "bash", { command: "echo x > .pi/skills/x/SKILL.md" })?.block, true);
  });
});

describe("turn digest", () => {
  it("includes the assistant text and the tools the turn used", () => {
    const digest = buildTurnDigest(
      { content: [{ type: "text", text: "Renamed the flag." }] },
      [{ toolName: "bash", input: { command: "rg --new-flag" } }, { toolName: "edit", input: { path: ".pi/skills/x/SKILL.md" } }],
    );
    assert.match(digest, /Renamed the flag\./);
    assert.match(digest, /bash rg --new-flag/);
    assert.match(digest, /edit \.pi\/skills\/x\/SKILL\.md/);
  });

  it("names the owned directory as the only writable place", () => {
    const { cwd } = project();
    const prompt = buildReviewPrompt(cwd, "digest", ownedSkillsRoot(cwd));
    assert.match(prompt, new RegExp(ownedSkillsRoot(cwd).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(prompt, /ONLY place you may write/);
  });
});

// ── integration through the registered extension hooks ─────────────────────

interface Harness {
  spawns: Array<{ agent: string; task: string; options: any }>;
  messages: Array<{ content: string; customType?: string }>;
  emit: (event: string, data?: any) => Promise<any>;
}

function harness(cwd: string): Harness {
  const handlers = new Map<string, Function[]>();
  const spawns: Harness["spawns"] = [];
  const messages: Harness["messages"] = [];
  const pi: any = {
    on(event: string, fn: Function) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
    },
    sendMessage(message: any) {
      messages.push({ content: message?.content, customType: message?.customType });
    },
  };
  const spawnAsyncAgent: any = (agent: string, task: string, _cwd: string, _agents: any[], options: any) => {
    spawns.push({ agent, task, options });
    return { id: `${agent}-1` };
  };
  registerSkillReview(pi, spawnAsyncAgent);
  return {
    spawns,
    messages,
    async emit(event, data = {}) {
      let result: any;
      for (const fn of handlers.get(event) ?? []) {
        const out = await fn(data, {
          cwd,
          mode: "tui",
          model: { provider: "anthropic" },
          sessionManager: { getSessionId: () => "test-session" },
        });
        if (out !== undefined) result = out;
      }
      return result;
    },
  };
}

describe("review runs only for substantive turns (issue #1074)", () => {
  it("skips a turn that used no tools", async () => {
    const { cwd } = project();
    const h = harness(cwd);
    await h.emit("turn_start", { turnIndex: 1 });
    await h.emit("turn_end", { turnIndex: 1, toolResults: [], message: { content: "hello" } });
    assert.equal(h.spawns.length, 0);
  });

  it("spawns the review agent for a turn that used tools", async () => {
    const { cwd, skills } = project();
    writeSkill(skills, "searxng");
    const h = harness(cwd);
    await h.emit("turn_start", { turnIndex: 2 });
    await h.emit("turn_end", {
      turnIndex: 2,
      toolResults: [{ toolName: "edit", input: { path: "extensions/x.ts" } }],
      message: { content: "Changed the flag." },
    });
    assert.equal(h.spawns.length, 1);
    assert.equal(h.spawns[0].agent, SKILL_REVIEW_AGENT);
    assert.equal(h.spawns[0].options.fireAndForget, true);
  });

  it("skips a turn whose tool call was blocked", async () => {
    const { cwd } = project();
    const h = harness(cwd);
    await h.emit("turn_start", { turnIndex: 3 });
    // a blocked call never runs, so it has no durationMs
    await h.emit("tool_execution_end", { toolName: "bash", isError: true, durationMs: undefined });
    await h.emit("turn_end", {
      turnIndex: 3,
      toolResults: [{ toolName: "edit", input: { path: "extensions/x.ts" } }],
      message: { content: "handled the block" },
    });
    assert.equal(h.spawns.length, 0);
  });

  it("honours skill_review=false", async () => {
    const { cwd } = project();
    process.env.PI_SKILL_REVIEW = "false";
    const h = harness(cwd);
    await h.emit("turn_start", { turnIndex: 4 });
    await h.emit("turn_end", {
      turnIndex: 4,
      toolResults: [{ toolName: "edit", input: { path: "extensions/x.ts" } }],
      message: { content: "changed" },
    });
    assert.equal(h.spawns.length, 0);
  });
});

describe("notice and provenance come from the filesystem, once per turn", () => {
  it("emits one line and one record set when the review changed an owned skill", async () => {
    const { cwd, skills } = project();
    const file = writeSkill(skills, "searxng");
    const h = harness(cwd);
    await h.emit("turn_start", { turnIndex: 7 });
    await h.emit("turn_end", {
      turnIndex: 7,
      toolResults: [{ toolName: "edit", input: { path: "extensions/x.ts" } }],
      message: { content: "the search flag changed" },
    });
    assert.equal(h.spawns.length, 1);

    // stand-in for the review agent's write
    fs.writeFileSync(file, "# SearXNG\n\nuse --new-flag\n");
    h.spawns[0].options.onComplete({ text: "done", isError: false });

    assert.equal(h.messages.length, 1);
    assert.equal(h.messages[0].customType, "skill-review");
    assert.equal(h.messages[0].content, "\u{1F4D9} Self-improvement review: Skill 'searxng' patched");
    const record = JSON.parse(fs.readFileSync(provenancePath(cwd), "utf-8").trim());
    assert.equal(record.skill, "searxng");
    assert.equal(record.action, "patched");
    assert.equal(record.file, "SKILL.md");
    assert.equal(record.sessionId, "test-session");
    assert.equal(record.turnId, "test-session:7");
  });

  it("emits nothing when the review changed nothing", async () => {
    const { cwd, skills } = project();
    writeSkill(skills, "searxng");
    const h = harness(cwd);
    await h.emit("turn_start", { turnIndex: 8 });
    await h.emit("turn_end", {
      turnIndex: 8,
      toolResults: [{ toolName: "read", input: { path: "extensions/x.ts" } }],
      message: { content: "read only" },
    });
    h.spawns[0].options.onComplete({ text: "nothing to do", isError: false });
    assert.equal(h.messages.length, 0);
    assert.equal(fs.existsSync(provenancePath(cwd)), false);
  });
});

describe("review child registration", () => {
  it("registers the write guard instead of the review when it is the review child", async () => {
    const { cwd, skills } = project();
    process.env.PI_AGENT_NAME = SKILL_REVIEW_AGENT;
    assert.equal(isSkillReviewerChild(), true);
    const h = harness(cwd);
    assert.equal(h.spawns.length, 0);

    const allowed = await h.emit("tool_call", { toolName: "write", input: { path: path.join(skills, "x", "SKILL.md") } });
    assert.equal(allowed, undefined);
    const blocked = await h.emit("tool_call", { toolName: "write", input: { path: path.join(cwd, "package.json") } });
    assert.equal(blocked?.block, true);
    const bashBlocked = await h.emit("tool_call", { toolName: "bash", input: { command: "touch x" } });
    assert.equal(bashBlocked?.block, true);
  });
});
