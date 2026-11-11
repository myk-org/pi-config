/**
 * Skill maintenance (issue #1074).
 *
 * A skill is maintained only when its frontmatter carries `skill-maintenance: auto`.
 * The write guard is the whole safety story: marked + real path under
 * `<project>/.pi/skills/`, everything else refused with a reason that says what it
 * is. Provenance is recorded at write time, and a skill that just failed steers the
 * turn to fix itself.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  adoptSkill,
  appendProvenance,
  classifySkillWrite,
  completeUnmarkedSkills,
  diffSkillTree,
  formatSkillReviewNotice,
  incomingText,
  isMarkedSkill,
  isOwnedSkillPath,
  listUnmarkedSkills,
  MAINTAINER_INSTRUCTION,
  MARKER_LINE,
  markedSkillsInText,
  ownedSkillName,
  ownedSkillsRoot,
  provenancePath,
  readSkillFile,
  registerSkillMaintenance,
  skillAreaOf,
  snapshotSkillTree,
  stampSkill,
} from "../../../extensions/orchestrator/skill-maintenance.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

const cleanups: Array<() => void> = [];
const envBackup: Record<string, string | undefined> = {};

const MARKED = `---\nname: searxng\ndescription: "Search with the local instance"\n${MARKER_LINE}\n---\n\n# SearXNG\n\nRun the query.\n`;
const UNMARKED = `---\nname: searxng\ndescription: "Search with the local instance"\n---\n\n# SearXNG\n\nRun the query.\n`;

function project(): { cwd: string; root: string } {
  const cwd = makeTempDir("skill-maint-");
  const root = path.join(cwd, ".pi", "skills");
  fs.mkdirSync(root, { recursive: true });
  cleanups.push(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return { cwd, root };
}

function writeSkill(root: string, name: string, content = MARKED): string {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, "references"), { recursive: true });
  const file = path.join(dir, "SKILL.md");
  fs.writeFileSync(file, content);
  return file;
}

function tempDir(prefix: string): string {
  const dir = makeTempDir(prefix);
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

beforeEach(() => {
  for (const key of ["PI_SUBAGENT_CHILD", "PI_AGENT_NAME"]) {
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

describe("ownership — real path under <project>/.pi/skills (issue #1074)", () => {
  it("owns an existing skill file and a new file inside an owned skill", () => {
    const { cwd, root } = project();
    const file = writeSkill(root, "searxng");
    assert.equal(isOwnedSkillPath(cwd, file), true);
    assert.equal(isOwnedSkillPath(cwd, path.join(root, "searxng", "references", "api.md")), true);
    assert.equal(isOwnedSkillPath(cwd, path.join(root, "new-skill", "SKILL.md")), true);
    assert.equal(ownedSkillName(cwd, file), "searxng");
  });

  it("rejects the skills directory itself and paths outside it", () => {
    const { cwd, root } = project();
    writeSkill(root, "searxng");
    assert.equal(isOwnedSkillPath(cwd, root), false);
    assert.equal(isOwnedSkillPath(cwd, path.join(cwd, ".pi", "memory", "lessons.md")), false);
    assert.equal(isOwnedSkillPath(cwd, path.join(root, "..", "..", "outside.md")), false);
    assert.equal(isOwnedSkillPath(cwd, ""), false);
  });

  it("rejects a symlink inside .pi/skills that resolves outside", () => {
    const { cwd, root } = project();
    const outside = tempDir("skill-maint-outside-");
    fs.mkdirSync(path.join(outside, "victim"), { recursive: true });
    fs.writeFileSync(path.join(outside, "victim", "SKILL.md"), "# Victim\n");
    fs.symlinkSync(path.join(outside, "victim"), path.join(root, "linked"));

    assert.equal(isOwnedSkillPath(cwd, path.join(root, "linked", "SKILL.md")), false);
    assert.equal(isOwnedSkillPath(cwd, path.join(root, "linked", "new.md")), false);
  });

  it("rejects a DANGLING symlink inside the owned tree (write would land outside)", () => {
    const { cwd, root } = project();
    const outside = tempDir("skill-maint-dangling-");
    // target does not exist yet: realpath reconstruction used to call this owned
    fs.symlinkSync(path.join(outside, "not-yet-created.md"), path.join(root, "dangling.md"));
    assert.equal(isOwnedSkillPath(cwd, path.join(root, "dangling.md")), false);
    const verdict = classifySkillWrite(cwd, path.join(root, "dangling.md"), MARKED);
    assert.equal(verdict.allow, false);
  });

  it("rejects a .pi/skills directory that is itself a symlink out of the project", () => {
    const cwd = tempDir("skill-maint-linked-root-");
    const outside = tempDir("skill-maint-linked-target-");
    fs.mkdirSync(path.join(outside, "searxng"), { recursive: true });
    fs.writeFileSync(path.join(outside, "searxng", "SKILL.md"), MARKED);
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.symlinkSync(outside, path.join(cwd, ".pi", "skills"));

    assert.equal(ownedSkillsRoot(cwd), null);
    assert.equal(isOwnedSkillPath(cwd, path.join(cwd, ".pi", "skills", "searxng", "SKILL.md")), false);
    assert.equal(classifySkillWrite(cwd, path.join(cwd, ".pi", "skills", "searxng", "SKILL.md"), MARKED).allow, false);
  });
});

describe("the marker decides (issue #1074)", () => {
  it("reads skill-maintenance: auto from frontmatter only", () => {
    assert.equal(isMarkedSkill(MARKED), true);
    assert.equal(isMarkedSkill(UNMARKED), false);
    assert.equal(isMarkedSkill("# no frontmatter\nskill-maintenance: auto\n"), false);
    assert.equal(isMarkedSkill(`---\nname: x\nskill-maintenance: manual\n---\n`), false);
  });

  it("stamps the marker and the instruction, creating frontmatter when absent", () => {
    const stamped = stampSkill(UNMARKED);
    assert.equal(stamped.changed, true);
    assert.equal(isMarkedSkill(stamped.content), true);
    assert.ok(stamped.content.includes(MAINTAINER_INSTRUCTION));
    // marker inside frontmatter, instruction after it
    assert.ok(stamped.content.indexOf(MARKER_LINE) < stamped.content.indexOf("---\n\n" + MAINTAINER_INSTRUCTION));

    const bare = stampSkill("# Bare skill\n");
    assert.equal(isMarkedSkill(bare.content), true);
    assert.ok(bare.content.startsWith(`---\n${MARKER_LINE}\n---\n`));

    const again = stampSkill(stamped.content);
    assert.equal(again.changed, false);
    assert.equal(again.content, stamped.content);
  });

  it("allows a marked owned skill and blocks an unmarked one with the adopt hint", () => {
    const { cwd, root } = project();
    const marked = writeSkill(root, "marked", MARKED);
    const unmarked = writeSkill(root, "unmarked", UNMARKED);

    assert.deepEqual(
      { allow: classifySkillWrite(cwd, marked, "edit").allow, skill: classifySkillWrite(cwd, marked, "edit").skill },
      { allow: true, skill: "marked" },
    );
    const blocked = classifySkillWrite(cwd, unmarked, "edited body");
    assert.equal(blocked.allow, false);
    assert.match(blocked.reason ?? "", /\/adopt-skill unmarked/);
  });

  it("allows a write that itself introduces the marker (no creation deadlock)", () => {
    const { cwd, root } = project();
    const created = path.join(root, "fresh", "SKILL.md");
    assert.equal(classifySkillWrite(cwd, created, MARKED).allow, true);
    // ...but not an unmarked creation
    assert.equal(classifySkillWrite(cwd, path.join(root, "fresh2", "SKILL.md"), UNMARKED).allow, false);
  });

  it("names package, user-global and third-party skills as not ours", () => {
    const { cwd } = project();
    const pkg = path.join(tempDir("skill-maint-pkg-"), "node_modules", "pi-orchestrator-config", "skills", "x", "SKILL.md");
    const globalPi = path.join(os.homedir(), ".pi", "agent", "skills", "homeassistant", "SKILL.md");
    const globalAgents = path.join(os.homedir(), ".agents", "skills", "homeassistant", "SKILL.md");
    const thirdParty = path.join(tempDir("skill-maint-repo-"), "skills", "conflict-resolver", "SKILL.md");
    const repoFile = path.join(cwd, "extensions", "orchestrator", "index.ts");

    assert.equal(skillAreaOf(cwd, pkg), "package");
    assert.match(classifySkillWrite(cwd, pkg, MARKED).reason ?? "", /package/);
    assert.equal(skillAreaOf(cwd, globalPi), "user-global");
    assert.equal(skillAreaOf(cwd, globalAgents), "user-global");
    assert.match(classifySkillWrite(cwd, globalPi, MARKED).reason ?? "", /user-global/);
    assert.equal(skillAreaOf(cwd, thirdParty), "third-party");
    assert.match(classifySkillWrite(cwd, thirdParty, MARKED).reason ?? "", /adopt-skill/);
    assert.equal(skillAreaOf(cwd, repoFile), null);
    assert.equal(classifySkillWrite(cwd, repoFile, "anything").allow, true);
  });

  it("reads the new text out of write and edit shapes", () => {
    assert.equal(incomingText({ content: "abc" }), "abc");
    assert.equal(incomingText({ newText: "abc" }), "abc");
    assert.equal(incomingText({ edits: [{ newText: "a" }, { newText: "b" }] }), "a\nb");
    assert.equal(incomingText(null), "");
  });
});

describe("/adopt-skill", () => {
  it("marks an unmarked project skill and is idempotent", () => {
    const { cwd, root } = project();
    const file = writeSkill(root, "searxng", UNMARKED);

    const first = adoptSkill(cwd, "searxng");
    assert.equal(first.ok, true);
    assert.match(first.message, /now maintained/);
    const content = fs.readFileSync(file, "utf-8");
    assert.equal(isMarkedSkill(content), true);
    assert.ok(content.includes(MAINTAINER_INSTRUCTION));
    assert.ok(content.includes("# SearXNG")); // body preserved

    const second = adoptSkill(cwd, "searxng");
    assert.equal(second.ok, true);
    assert.match(second.message, /already maintained/);
    assert.equal(fs.readFileSync(file, "utf-8"), content);
  });

  it("creates frontmatter when the skill has none", () => {
    const { cwd, root } = project();
    const file = writeSkill(root, "bare", "# Bare\n");
    assert.equal(adoptSkill(cwd, "bare").ok, true);
    const content = fs.readFileSync(file, "utf-8");
    assert.ok(content.startsWith(`---\n${MARKER_LINE}\n---\n`));
    assert.equal(isMarkedSkill(content), true);
  });

  it("refuses a skill that lives outside the project and one that does not exist", () => {
    const { cwd } = project();
    assert.match(adoptSkill(cwd, "definitely-missing").message, /No project skill named/);

    const fakeHome = tempDir("skill-maint-home-");
    fs.mkdirSync(path.join(fakeHome, ".agents", "skills", "elsewhere"), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, ".agents", "skills", "elsewhere", "SKILL.md"), UNMARKED);
    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const result = adoptSkill(cwd, "elsewhere");
      assert.equal(result.ok, false);
      assert.match(result.message, /copy it into .* first/);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  it("offers only unmarked project skills to autocomplete", () => {
    const { cwd, root } = project();
    writeSkill(root, "marked", MARKED);
    writeSkill(root, "unmarked", UNMARKED);
    assert.deepEqual(listUnmarkedSkills(cwd), ["unmarked"]);
    assert.deepEqual(
      completeUnmarkedSkills(cwd, "unm").map((item) => item.value),
      ["unmarked"],
    );
    assert.deepEqual(completeUnmarkedSkills(cwd, "zzz"), []);
  });
});

describe("snapshot / diff / notice", () => {
  it("reports a modified skill as patched and a new skill as written", () => {
    const { cwd, root } = project();
    const existing = writeSkill(root, "searxng");
    const owned = ownedSkillsRoot(cwd);
    const before = snapshotSkillTree(owned);

    fs.writeFileSync(existing, "# SearXNG\n\nnew step\n");
    fs.mkdirSync(path.join(root, "homeassistant"), { recursive: true });
    fs.writeFileSync(path.join(root, "homeassistant", "SKILL.md"), MARKED);

    assert.deepEqual(diffSkillTree(owned, before, snapshotSkillTree(owned)), [
      { skill: "homeassistant", action: "written", file: "SKILL.md" },
      { skill: "searxng", action: "patched", file: "SKILL.md" },
    ]);
  });

  it("does not follow symlinks out of the owned tree", () => {
    const { cwd, root } = project();
    const outside = tempDir("skill-maint-outside-");
    fs.writeFileSync(path.join(outside, "SKILL.md"), "# Outside\n");
    fs.symlinkSync(outside, path.join(root, "linked"));
    assert.equal(snapshotSkillTree(ownedSkillsRoot(cwd)).size, 0);
  });

  it("writes one line, one entry per skill, and says when provenance failed", () => {
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
    assert.match(formatSkillReviewNotice([{ skill: "x", action: "patched", file: "SKILL.md" }], true), /provenance write failed/);
    assert.equal(formatSkillReviewNotice([]), "");
  });
});

describe("provenance is append-only", () => {
  it("appends records without rewriting earlier lines", () => {
    const { cwd } = project();
    const one = { skill: "a", action: "patched" as const, file: "SKILL.md", sessionId: "s1", turnId: "s1:1", at: "t1" };
    const two = { skill: "b", action: "written" as const, file: "SKILL.md", sessionId: "s2", turnId: "s2:2", at: "t2" };
    assert.equal(appendProvenance(cwd, [one]), true);
    assert.equal(appendProvenance(cwd, [two]), true);
    const lines = fs.readFileSync(provenancePath(cwd), "utf-8").trim().split("\n");
    assert.deepEqual(lines.map((line) => JSON.parse(line).skill), ["a", "b"]);
  });

  it("reports failure instead of pretending", () => {
    const { cwd } = project();
    const file = provenancePath(cwd);
    fs.mkdirSync(cwd, { recursive: true });
    // a directory where the trail file should be: the append cannot succeed
    fs.mkdirSync(file, { recursive: true });
    assert.equal(
      appendProvenance(cwd, [{ skill: "a", action: "patched", file: "SKILL.md", sessionId: "s", turnId: "s:1", at: "t" }]),
      false,
    );
  });
});

// ── integration through the registered hooks ───────────────────────────────

interface Harness {
  messages: Array<{ content: string; customType?: string; options?: any }>;
  commands: Map<string, any>;
  emit: (event: string, data?: any) => Promise<any>;
}

function harness(cwd: string): Harness {
  const handlers = new Map<string, Function[]>();
  const messages: Harness["messages"] = [];
  const commands = new Map<string, any>();
  const pi: any = {
    on(event: string, fn: Function) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
    },
    sendMessage(message: any, options: any) {
      messages.push({ content: message?.content, customType: message?.customType, options });
    },
    registerCommand(name: string, options: any) {
      commands.set(name, options);
    },
  };
  registerSkillMaintenance(pi);
  const ctx = {
    cwd,
    mode: "tui",
    sessionManager: { getSessionId: () => "test-session" },
    ui: { notify: () => {} },
  };
  return {
    messages,
    commands,
    async emit(event, data = {}) {
      let result: any;
      for (const fn of handlers.get(event) ?? []) {
        const out = await fn(data, ctx);
        if (out !== undefined) result = out;
      }
      return result;
    },
  };
}

describe("write guard in the main session (issue #1074)", () => {
  it("blocks an unmarked project skill and allows a marked one, recording the write", async () => {
    const { cwd, root } = project();
    const marked = writeSkill(root, "marked", MARKED);
    const unmarked = writeSkill(root, "unmarked", UNMARKED);
    const h = harness(cwd);
    await h.emit("turn_start", { turnIndex: 3 });

    const blocked = await h.emit("tool_call", { toolName: "edit", input: { path: unmarked, newText: "x" } });
    assert.equal(blocked?.block, true);
    assert.match(blocked?.reason ?? "", /\/adopt-skill unmarked/);

    const allowed = await h.emit("tool_call", { toolName: "edit", input: { path: marked, newText: "x" } });
    assert.equal(allowed, undefined);

    const record = JSON.parse(fs.readFileSync(provenancePath(cwd), "utf-8").trim());
    assert.deepEqual(
      { skill: record.skill, action: record.action, file: record.file, sessionId: record.sessionId, turnId: record.turnId },
      { skill: "marked", action: "patched", file: "SKILL.md", sessionId: "test-session", turnId: "test-session:3" },
    );
  });

  it("leaves bash and non-skill writes alone", async () => {
    const { cwd } = project();
    const h = harness(cwd);
    await h.emit("turn_start", { turnIndex: 1 });
    assert.equal(await h.emit("tool_call", { toolName: "bash", input: { command: "echo hi > x" } }), undefined);
    assert.equal(await h.emit("tool_call", { toolName: "write", input: { path: "src/index.ts", content: "x" } }), undefined);
  });

  it("records a created skill as written and reports it in the turn-end notice", async () => {
    const { cwd, root } = project();
    const h = harness(cwd);
    await h.emit("turn_start", { turnIndex: 5 });
    const created = path.join(root, "fresh", "SKILL.md");
    assert.equal(await h.emit("tool_call", { toolName: "write", input: { path: created, content: MARKED } }), undefined);

    fs.mkdirSync(path.join(root, "fresh"), { recursive: true });
    fs.writeFileSync(created, MARKED);
    await h.emit("turn_end", { turnIndex: 5 });

    assert.equal(h.messages.length, 1);
    assert.equal(h.messages[0].customType, "skill-maintenance");
    assert.equal(h.messages[0].content, "\u{1F4D9} Self-improvement review: Skill 'fresh' written (SKILL.md)");
    const lines = fs.readFileSync(provenancePath(cwd), "utf-8").trim().split("\n");
    // one record at write time, and the turn-end diff does not duplicate it
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).action, "written");
  });

  it("says so in the notice when provenance cannot be written", async () => {
    const { cwd, root } = project();
    const file = writeSkill(root, "searxng", MARKED);
    const h = harness(cwd);
    await h.emit("turn_start", { turnIndex: 9 });
    fs.rmSync(provenancePath(cwd), { recursive: true, force: true });
    fs.mkdirSync(provenancePath(cwd), { recursive: true }); // append must fail

    fs.writeFileSync(file, `${MARKED}\nchanged\n`);
    await h.emit("turn_end", { turnIndex: 9 });

    assert.equal(h.messages.length, 1);
    assert.match(h.messages[0].content, /patched/);
    assert.match(h.messages[0].content, /provenance write failed/);
  });

  it("emits nothing when no skill file changed", async () => {
    const { cwd, root } = project();
    writeSkill(root, "searxng", MARKED);
    const h = harness(cwd);
    await h.emit("turn_start", { turnIndex: 2 });
    await h.emit("turn_end", { turnIndex: 2 });
    assert.equal(h.messages.length, 0);
  });
});

describe("in-turn nudge (issue #1074)", () => {
  it("steers once when a marked skill used this turn fails", async () => {
    const { cwd, root } = project();
    const file = writeSkill(root, "searxng", MARKED);
    const h = harness(cwd);
    await h.emit("turn_start", { turnIndex: 4 });
    await h.emit("input", { text: "/skill:searxng find the docs" });

    await h.emit("tool_result", { toolName: "read", input: { path: file }, isError: true });
    assert.equal(h.messages.length, 1);
    assert.equal(h.messages[0].customType, "skill-maintenance-nudge");
    assert.match(h.messages[0].content, /`searxng` just failed/);
    assert.equal(h.messages[0].options.deliverAs, "steer");

    // once per skill per turn
    await h.emit("tool_result", { toolName: "read", input: { path: file }, isError: true });
    assert.equal(h.messages.length, 1);
  });

  it("uses the error signal, not a missing duration", async () => {
    const { cwd, root } = project();
    const file = writeSkill(root, "searxng", MARKED);
    const h = harness(cwd);
    await h.emit("turn_start", { turnIndex: 6 });
    await h.emit("input", { text: "/skill:searxng" });

    await h.emit("tool_result", { toolName: "read", input: { path: file }, isError: false });
    assert.equal(h.messages.length, 0);

    await h.emit("tool_result", { toolName: "read", input: { path: file }, isError: true });
    assert.equal(h.messages.length, 1);
  });

  it("never nudges about an unmarked skill", async () => {
    const { cwd, root } = project();
    writeSkill(root, "unmarked", UNMARKED);
    const h = harness(cwd);
    await h.emit("turn_start", { turnIndex: 7 });
    await h.emit("input", { text: "/skill:unmarked" });
    await h.emit("tool_result", { toolName: "bash", input: { command: "ls" }, isError: true });
    assert.equal(h.messages.length, 0);
    assert.deepEqual(markedSkillsInText(cwd, "/skill:unmarked"), []);
  });
});

describe("command registration", () => {
  it("registers /adopt-skill with autocomplete of unmarked skills", async () => {
    const { cwd, root } = project();
    writeSkill(root, "marked", MARKED);
    writeSkill(root, "unmarked", UNMARKED);
    const h = harness(cwd);
    const command = h.commands.get("adopt-skill");
    assert.ok(command);
    await h.emit("session_start");
    assert.deepEqual(
      command.getArgumentCompletions("").map((item: any) => item.value),
      ["unmarked"],
    );

    const notices: string[] = [];
    const ctx = {
      cwd,
      ui: { notify: (message: string) => notices.push(message) },
      sessionManager: { getSessionId: () => "s" },
    };
    await command.handler("unmarked", ctx);
    assert.match(notices[0], /now maintained/);
    assert.equal(readSkillFile(cwd, "unmarked")!.includes(MARKER_LINE), true);
  });
});
