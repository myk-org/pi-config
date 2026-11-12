/**
 * Skill maintenance (issue #1074).
 *
 * A skill is maintained only when its frontmatter carries `skill-maintenance: auto`.
 * The write guard is the whole safety story: marked + real path under
 * `<project>/.pi/skills/`, everything else refused with a reason that says what it
 * is. Provenance is recorded after a write succeeds, and a skill that just failed
 * steers the turn to fix itself.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  adoptSkill,
  appendProvenance,
  bashSkillVerdict,
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

/** A write tool input. */
const write = (content: string) => ({ content });

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

function provenanceRecords(cwd: string): any[] {
  const file = provenancePath(cwd);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
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

describe("ownership — real path under <project>/.pi/skills", () => {
  it("owns an existing skill file inside the project", () => {
    const { cwd, root } = project();
    const file = writeSkill(root, "searxng");
    assert.equal(isOwnedSkillPath(cwd, file), true);
    assert.equal(ownedSkillName(cwd, file), "searxng");
  });

  it("owns a not-yet-created file inside an owned skill", () => {
    const { cwd, root } = project();
    writeSkill(root, "searxng");
    assert.equal(isOwnedSkillPath(cwd, path.join(root, "searxng", "references", "api.md")), true);
    assert.equal(isOwnedSkillPath(cwd, path.join(root, "new-skill", "SKILL.md")), true);
  });

  it("rejects the skills directory itself", () => {
    const { cwd, root } = project();
    writeSkill(root, "searxng");
    assert.equal(isOwnedSkillPath(cwd, root), false);
    assert.equal(isOwnedSkillPath(cwd, ""), false);
  });

  it("rejects a path outside the project", () => {
    const { cwd, root } = project();
    writeSkill(root, "searxng");
    assert.equal(isOwnedSkillPath(cwd, path.join(cwd, ".pi", "memory", "lessons.md")), false);
    assert.equal(isOwnedSkillPath(cwd, path.join(root, "..", "..", "outside.md")), false);
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

  it("rejects a dangling symlink inside the owned tree", () => {
    const { cwd, root } = project();
    const outside = tempDir("skill-maint-dangling-");
    fs.symlinkSync(path.join(outside, "not-yet-created.md"), path.join(root, "dangling.md"));
    assert.equal(isOwnedSkillPath(cwd, path.join(root, "dangling.md")), false);
  });

  it("blocks a dangling symlink write through the classifier", () => {
    const { cwd, root } = project();
    const outside = tempDir("skill-maint-dangling-");
    fs.symlinkSync(path.join(outside, "not-yet-created.md"), path.join(root, "dangling.md"));
    const verdict = classifySkillWrite(cwd, path.join(root, "dangling.md"), write(MARKED));
    assert.equal(verdict.allow, false);
    assert.match(verdict.reason ?? "", /symlink/);
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
    assert.equal(
      classifySkillWrite(cwd, path.join(cwd, ".pi", "skills", "searxng", "SKILL.md"), write(MARKED)).allow,
      false,
    );
  });
});

describe("known skills roots only (Qodo HIGH — ordinary files stay writable)", () => {
  it("treats a directory merely named skills as an ordinary path", () => {
    const cwd = path.join(tempDir("skill-maint-src-"), "skills", "foo");
    fs.mkdirSync(path.join(cwd, ".pi", "skills"), { recursive: true });
    const ordinary = path.join(cwd, "notes", "skills", "thing.md");
    assert.equal(skillAreaOf(cwd, ordinary), null);
    assert.equal(classifySkillWrite(cwd, ordinary, write("text")).allow, true);
  });

  it("treats a project checked out under ~/src/skills/<name> as ordinary", () => {
    const cwd = path.join(tempDir("skill-maint-src-"), "skills", "myproject");
    fs.mkdirSync(path.join(cwd, ".pi", "skills"), { recursive: true });
    const ordinary = path.join(cwd, "src", "index.ts");
    assert.equal(skillAreaOf(cwd, ordinary), null);
    assert.equal(classifySkillWrite(cwd, ordinary, write("x")).allow, true);
  });

  it("treats the repository's own shipped skills directory as ordinary", () => {
    const { cwd } = project();
    const shipped = path.join(cwd, "skills", "conflict-resolver", "SKILL.md");
    assert.equal(skillAreaOf(cwd, shipped), null);
    assert.equal(classifySkillWrite(cwd, shipped, write("x")).allow, true);
  });

  it("names user-global skills", () => {
    const { cwd } = project();
    const globalPi = path.join(os.homedir(), ".pi", "agent", "skills", "homeassistant", "SKILL.md");
    const globalAgents = path.join(os.homedir(), ".agents", "skills", "homeassistant", "SKILL.md");
    assert.equal(skillAreaOf(cwd, globalPi), "user-global");
    assert.equal(skillAreaOf(cwd, globalAgents), "user-global");
    const verdict = classifySkillWrite(cwd, globalPi, write(MARKED));
    assert.equal(verdict.allow, false);
    assert.match(verdict.reason ?? "", /user-global/);
  });

  it("names packaged skills under node_modules", () => {
    const { cwd } = project();
    const pkg = path.join(tempDir("skill-maint-pkg-"), "node_modules", "pi-orchestrator-config", "skills", "x", "SKILL.md");
    assert.equal(skillAreaOf(cwd, pkg), "package");
    const verdict = classifySkillWrite(cwd, pkg, write(MARKED));
    assert.equal(verdict.allow, false);
    assert.match(verdict.reason ?? "", /package/);
  });

  it("names the project's .agents/skills discovery directory", () => {
    const { cwd } = project();
    const agents = path.join(cwd, ".agents", "skills", "x", "SKILL.md");
    fs.mkdirSync(path.dirname(agents), { recursive: true });
    assert.equal(skillAreaOf(cwd, agents), "project-agents");
    assert.match(classifySkillWrite(cwd, agents, write(MARKED)).reason ?? "", /\.agents\/skills/);
  });
});

describe("the marker decides", () => {
  it("reads skill-maintenance: auto from frontmatter only", () => {
    assert.equal(isMarkedSkill(MARKED), true);
    assert.equal(isMarkedSkill(UNMARKED), false);
  });

  it("ignores the marker outside frontmatter", () => {
    assert.equal(isMarkedSkill("# no frontmatter\nskill-maintenance: auto\n"), false);
  });

  it("ignores a different marker value", () => {
    assert.equal(isMarkedSkill(`---\nname: x\nskill-maintenance: manual\n---\n`), false);
  });

  it("stamps the marker into content that has frontmatter", () => {
    const stamped = stampSkill(UNMARKED);
    assert.equal(stamped.changed, true);
    assert.equal(isMarkedSkill(stamped.content), true);
    assert.ok(stamped.content.includes(MAINTAINER_INSTRUCTION));
    assert.ok(stamped.content.includes("# SearXNG"));
  });

  it("creates frontmatter when the skill has none", () => {
    const bare = stampSkill("# Bare skill\n");
    assert.equal(isMarkedSkill(bare.content), true);
    assert.ok(bare.content.startsWith(`---\n${MARKER_LINE}\n---\n`));
  });

  it("leaves stamped content alone on a second pass", () => {
    const once = stampSkill(UNMARKED);
    const twice = stampSkill(once.content);
    assert.equal(twice.changed, false);
    assert.equal(twice.content, once.content);
  });

  it("allows a marked owned skill", () => {
    const { cwd, root } = project();
    const marked = writeSkill(root, "marked", MARKED);
    const verdict = classifySkillWrite(cwd, marked, { edits: [{ oldText: "Run the query.", newText: "Run it." }] });
    assert.equal(verdict.allow, true);
    assert.equal(verdict.skill, "marked");
  });

  it("blocks an unmarked owned skill with the adopt hint", () => {
    const { cwd, root } = project();
    const unmarked = writeSkill(root, "unmarked", UNMARKED);
    const verdict = classifySkillWrite(cwd, unmarked, { edits: [{ oldText: "Run the query.", newText: "Run it." }] });
    assert.equal(verdict.allow, false);
    assert.match(verdict.reason ?? "", /\/adopt-skill unmarked/);
  });

  it("allows an edit that adds the marker to an unmarked skill", () => {
    const { cwd, root } = project();
    const unmarked = writeSkill(root, "unmarked", UNMARKED);
    const verdict = classifySkillWrite(cwd, unmarked, {
      edits: [{ oldText: "description: \"Search with the local instance\"\n", newText: `description: "Search with the local instance"\n${MARKER_LINE}\n` }],
    });
    assert.equal(verdict.allow, true);
  });

  it("refuses a prose-only edit to an unmarked skill, even one quoting the marker", () => {
    const { cwd, root } = project();
    const unmarked = writeSkill(root, "unmarked", UNMARKED);
    const verdict = classifySkillWrite(cwd, unmarked, {
      edits: [{ oldText: "Run the query.", newText: `Run the query.\n\nNever add \`${MARKER_LINE}\` by hand.` }],
    });
    assert.equal(verdict.allow, false);
  });

  it("allows a marked creation under .pi/skills", () => {
    const { cwd, root } = project();
    assert.equal(classifySkillWrite(cwd, path.join(root, "fresh", "SKILL.md"), write(MARKED)).allow, true);
  });

  it("refuses an unmarked creation under .pi/skills", () => {
    const { cwd, root } = project();
    assert.equal(classifySkillWrite(cwd, path.join(root, "fresh", "SKILL.md"), write(UNMARKED)).allow, false);
  });

  it("reads the new text out of a write input", () => {
    assert.equal(incomingText({ content: "abc" }), "abc");
    assert.equal(incomingText({ edits: [{ newText: "a" }, { newText: "b" }] }), "a\nb");
    assert.equal(incomingText(null), "");
  });
});

describe("bash guard (Qodo #1079)", () => {
  it("blocks a shell write to a user-global skill", () => {
    const { cwd } = project();
    const global = path.join(os.homedir(), ".pi", "agent", "skills", "x", "SKILL.md");
    const verdict = bashSkillVerdict(cwd, `echo hacked > ${global}`);
    assert.equal(verdict?.block, true);
    assert.match(verdict?.reason ?? "", /does not own/);
  });

  it("blocks a shell copy into the project's .agents/skills", () => {
    const { cwd } = project();
    const verdict = bashSkillVerdict(cwd, `cp SKILL.md ${path.join(cwd, ".agents", "skills", "x", "SKILL.md")}`);
    assert.equal(verdict?.block, true);
  });

  it("leaves a read of a global skill alone", () => {
    const { cwd } = project();
    const global = path.join(os.homedir(), ".pi", "agent", "skills", "x", "SKILL.md");
    assert.equal(bashSkillVerdict(cwd, `cat ${global}`), null);
  });

  it("leaves an ordinary write alone", () => {
    const { cwd } = project();
    assert.equal(bashSkillVerdict(cwd, "echo hi > notes.txt"), null);
  });
});

describe("/adopt-skill", () => {
  it("marks an unmarked project skill", () => {
    const { cwd, root } = project();
    const file = writeSkill(root, "searxng", UNMARKED);
    const result = adoptSkill(cwd, "searxng");
    assert.equal(result.ok, true);
    assert.match(result.message, /now maintained/);
    const content = fs.readFileSync(file, "utf-8");
    assert.equal(isMarkedSkill(content), true);
    assert.ok(content.includes(MAINTAINER_INSTRUCTION));
  });

  it("is idempotent", () => {
    const { cwd, root } = project();
    const file = writeSkill(root, "searxng", UNMARKED);
    adoptSkill(cwd, "searxng");
    const once = fs.readFileSync(file, "utf-8");
    const second = adoptSkill(cwd, "searxng");
    assert.equal(second.ok, true);
    assert.match(second.message, /already maintained/);
    assert.equal(fs.readFileSync(file, "utf-8"), once);
  });

  it("refuses a path traversal in the skill name", () => {
    const { cwd } = project();
    const outside = tempDir("skill-maint-outside-");
    const victim = path.join(outside, "victim", "SKILL.md");
    fs.mkdirSync(path.dirname(victim), { recursive: true });
    fs.writeFileSync(victim, UNMARKED);

    const result = adoptSkill(cwd, "../../../../" + path.relative(path.dirname(path.dirname(cwd)), victim));
    assert.equal(result.ok, false);
    assert.equal(fs.readFileSync(victim, "utf-8"), UNMARKED);
  });

  it("refuses an absolute path as the skill name", () => {
    const { cwd, root } = project();
    writeSkill(root, "searxng", UNMARKED);
    const result = adoptSkill(cwd, path.join(root, "searxng", "SKILL.md"));
    assert.equal(result.ok, false);
    assert.match(result.message, /not a skill name/);
  });

  it("refuses a symlinked skill without touching the outside file", () => {
    const { cwd, root } = project();
    const outside = tempDir("skill-maint-outside-");
    const victimDir = path.join(outside, "victim");
    fs.mkdirSync(victimDir, { recursive: true });
    fs.writeFileSync(path.join(victimDir, "SKILL.md"), UNMARKED);
    fs.symlinkSync(victimDir, path.join(root, "linked"));

    const result = adoptSkill(cwd, "linked");
    assert.equal(result.ok, false);
    assert.match(result.message, /symlink|does not resolve/);
    assert.equal(fs.readFileSync(path.join(victimDir, "SKILL.md"), "utf-8"), UNMARKED);
  });

  it("refuses a skill that lives outside the project", () => {
    const { cwd } = project();
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

  it("reports a name that does not exist in the project", () => {
    const { cwd } = project();
    assert.match(adoptSkill(cwd, "definitely-missing").message, /No project skill named/);
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

describe("snapshot", () => {
  it("skips symlinks out of the owned tree", () => {
    const { cwd, root } = project();
    const outside = tempDir("skill-maint-outside-");
    fs.writeFileSync(path.join(outside, "SKILL.md"), "# Outside\n");
    fs.symlinkSync(outside, path.join(root, "linked"));
    assert.equal(snapshotSkillTree(ownedSkillsRoot(cwd)).size, 0);
  });
});

describe("diff", () => {
  it("reports a modified skill as patched", () => {
    const { cwd, root } = project();
    const existing = writeSkill(root, "searxng");
    const owned = ownedSkillsRoot(cwd);
    const before = snapshotSkillTree(owned);
    fs.writeFileSync(existing, "# SearXNG\n\nnew step\n");
    assert.deepEqual(diffSkillTree(owned, before, snapshotSkillTree(owned)), [
      { skill: "searxng", action: "patched", file: "SKILL.md" },
    ]);
  });

  it("reports a new skill as written", () => {
    const { cwd, root } = project();
    writeSkill(root, "searxng");
    const owned = ownedSkillsRoot(cwd);
    const before = snapshotSkillTree(owned);
    fs.mkdirSync(path.join(root, "homeassistant"), { recursive: true });
    fs.writeFileSync(path.join(root, "homeassistant", "SKILL.md"), MARKED);
    assert.deepEqual(diffSkillTree(owned, before, snapshotSkillTree(owned)), [
      { skill: "homeassistant", action: "written", file: "SKILL.md" },
    ]);
  });
});

describe("notice", () => {
  it("names each skill once in one line", () => {
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

  it("says when provenance failed", () => {
    assert.match(
      formatSkillReviewNotice([{ skill: "x", action: "patched", file: "SKILL.md" }], true),
      /provenance write failed/,
    );
  });

  it("is empty when nothing changed", () => {
    assert.equal(formatSkillReviewNotice([]), "");
  });
});

describe("provenance", () => {
  it("appends records without rewriting earlier lines", () => {
    const { cwd } = project();
    const one = { skill: "a", action: "patched" as const, file: "SKILL.md", sessionId: "s1", turnId: "s1:1", at: "t1" };
    const two = { skill: "b", action: "written" as const, file: "SKILL.md", sessionId: "s2", turnId: "s2:2", at: "t2" };
    assert.equal(appendProvenance(cwd, [one]), true);
    assert.equal(appendProvenance(cwd, [two]), true);
    assert.deepEqual(provenanceRecords(cwd).map((record) => record.skill), ["a", "b"]);
  });

  it("reports failure when the trail cannot be written", () => {
    const { cwd } = project();
    fs.mkdirSync(provenancePath(cwd), { recursive: true }); // a directory where the file goes
    assert.equal(
      appendProvenance(cwd, [{ skill: "a", action: "patched", file: "SKILL.md", sessionId: "s", turnId: "s:1", at: "t" }]),
      false,
    );
  });

  it("rotates an over-large trail to the newest records", () => {
    const { cwd } = project();
    const file = provenancePath(cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const pad = "x".repeat(600);
    const original = Array.from({ length: 2100 }, (_, i) => JSON.stringify({ skill: `old-${i + 1}`, pad }));
    fs.writeFileSync(file, `${original.join("\n")}\n`);
    assert.ok(fs.statSync(file).size > 1_000_000);

    appendProvenance(cwd, [
      { skill: "newest", action: "patched", file: "SKILL.md", sessionId: "s", turnId: "s:9", at: "t" },
    ]);

    const kept = provenanceRecords(cwd);
    assert.equal(kept.length, 2000);
    const firstOriginal = 2100 + 1 - 2000 + 1;
    assert.equal(kept[0].skill, `old-${firstOriginal}`);
    assert.equal(kept[kept.length - 1].skill, "newest");
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

describe("write guard in the main session", () => {
  it("blocks an unmarked project skill", async () => {
    const { cwd, root } = project();
    const unmarked = writeSkill(root, "unmarked", UNMARKED);
    const h = harness(cwd);
    await h.emit("turn_start", { turnIndex: 3 });
    const blocked = await h.emit("tool_call", {
      toolCallId: "c1",
      toolName: "edit",
      input: { path: unmarked, edits: [{ oldText: "Run the query.", newText: "Run it." }] },
    });
    assert.equal(blocked?.block, true);
    assert.match(blocked?.reason ?? "", /\/adopt-skill unmarked/);
  });

  it("allows a marked skill (write recorded only after success)", async () => {
    const { cwd, root } = project();
    const marked = writeSkill(root, "marked", MARKED);
    const h = harness(cwd);
    await h.emit("turn_start", { turnIndex: 3 });
    const allowed = await h.emit("tool_call", {
      toolCallId: "c2",
      toolName: "edit",
      input: { path: marked, edits: [{ oldText: "Run the query.", newText: "Run it." }] },
    });
    assert.equal(allowed, undefined);
    // nothing recorded before the tool ran
    assert.deepEqual(provenanceRecords(cwd), []);

    await h.emit("tool_result", {
      toolCallId: "c2",
      toolName: "edit",
      input: { path: marked },
      isError: false,
    });
    const [record] = provenanceRecords(cwd);
    assert.deepEqual(
      { skill: record.skill, action: record.action, file: record.file, sessionId: record.sessionId, turnId: record.turnId },
      { skill: "marked", action: "patched", file: "SKILL.md", sessionId: "test-session", turnId: "test-session:3" },
    );
  });

  it("does not record a write whose tool call failed", async () => {
    const { cwd, root } = project();
    const marked = writeSkill(root, "marked", MARKED);
    const h = harness(cwd);
    await h.emit("turn_start", { turnIndex: 3 });
    await h.emit("tool_call", {
      toolCallId: "c3",
      toolName: "write",
      input: { path: marked, content: MARKED },
    });
    await h.emit("tool_result", { toolCallId: "c3", toolName: "write", input: { path: marked }, isError: true });
    assert.deepEqual(provenanceRecords(cwd), []);
  });

  it("leaves a shell write to an ordinary file alone", async () => {
    const { cwd } = project();
    const h = harness(cwd);
    await h.emit("turn_start", { turnIndex: 1 });
    assert.equal(await h.emit("tool_call", { toolCallId: "b1", toolName: "bash", input: { command: "echo hi > x" } }), undefined);
    assert.equal(
      await h.emit("tool_call", { toolCallId: "b2", toolName: "write", input: { path: "src/index.ts", content: "x" } }),
      undefined,
    );
  });

  it("blocks a bash write to a skill this project does not own", async () => {
    const { cwd } = project();
    const h = harness(cwd);
    await h.emit("turn_start", { turnIndex: 1 });
    const blocked = await h.emit("tool_call", {
      toolCallId: "b3",
      toolName: "bash",
      input: { command: `echo x > ${path.join(os.homedir(), ".agents", "skills", "y", "SKILL.md")}` },
    });
    assert.equal(blocked?.block, true);
  });
});

describe("end-of-turn notice", () => {
  it("reports a created skill once", async () => {
    const { cwd, root } = project();
    const h = harness(cwd);
    await h.emit("turn_start", { turnIndex: 5 });
    const created = path.join(root, "fresh", "SKILL.md");
    await h.emit("tool_call", { toolCallId: "c5", toolName: "write", input: { path: created, content: MARKED } });
    fs.mkdirSync(path.join(root, "fresh"), { recursive: true });
    fs.writeFileSync(created, MARKED);
    await h.emit("tool_result", { toolCallId: "c5", toolName: "write", input: { path: created }, isError: false });
    await h.emit("turn_end", { turnIndex: 5 });

    const notices = h.messages.filter((message) => message.customType === "skill-maintenance");
    assert.equal(notices.length, 1);
    assert.equal(notices[0].content, "\u{1F4D9} Self-improvement review: Skill 'fresh' written (SKILL.md)");
    assert.equal(provenanceRecords(cwd).length, 1);
  });

  it("says so when provenance cannot be written", async () => {
    const { cwd, root } = project();
    const file = writeSkill(root, "searxng", MARKED);
    const h = harness(cwd);
    await h.emit("turn_start", { turnIndex: 9 });
    fs.rmSync(provenancePath(cwd), { recursive: true, force: true });
    fs.mkdirSync(provenancePath(cwd), { recursive: true }); // append must fail

    await h.emit("tool_call", {
      toolCallId: "c9",
      toolName: "write",
      input: { path: file, content: `${MARKED}\nchanged\n` },
    });
    fs.writeFileSync(file, `${MARKED}\nchanged\n`);
    await h.emit("tool_result", { toolCallId: "c9", toolName: "write", input: { path: file }, isError: false });
    await h.emit("turn_end", { turnIndex: 9 });

    const notices = h.messages.filter((message) => message.customType === "skill-maintenance");
    assert.equal(notices.length, 1);
    assert.match(notices[0].content, /patched/);
    assert.match(notices[0].content, /provenance write failed/);
  });

  it("emits nothing when no skill file changed", async () => {
    const { cwd, root } = project();
    writeSkill(root, "searxng", MARKED);
    const h = harness(cwd);
    await h.emit("turn_start", { turnIndex: 2 });
    await h.emit("turn_end", { turnIndex: 2 });
    assert.equal(h.messages.filter((message) => message.customType === "skill-maintenance").length, 0);
  });

  it("does not attribute a user's editor change to the turn", async () => {
    const { cwd, root } = project();
    const file = writeSkill(root, "searxng", MARKED);
    const h = harness(cwd);
    await h.emit("turn_start", { turnIndex: 11 });
    // the user edits the file in their editor — no tool call involved
    fs.writeFileSync(file, `${MARKED}\nuser edit\n`);
    await h.emit("turn_end", { turnIndex: 11 });

    assert.equal(h.messages.filter((message) => message.customType === "skill-maintenance").length, 1);
    assert.deepEqual(provenanceRecords(cwd), []);
  });

  it("reconciles a turn that never reached turn_end", async () => {
    const { cwd, root } = project();
    const file = writeSkill(root, "searxng", MARKED);
    const h = harness(cwd);
    await h.emit("turn_start", { turnIndex: 1 });
    fs.writeFileSync(file, `${MARKED}\naborted turn edit\n`);
    // no turn_end: the turn was aborted
    await h.emit("turn_start", { turnIndex: 2 });

    const notices = h.messages.filter((message) => message.customType === "skill-maintenance");
    assert.equal(notices.length, 1);
    assert.match(notices[0].content, /'searxng' patched/);

    await h.emit("turn_end", { turnIndex: 2 });
    assert.equal(h.messages.filter((message) => message.customType === "skill-maintenance").length, 1);
  });
});

describe("in-turn nudge", () => {
  it("steers once when a marked skill used this turn fails", async () => {
    const { cwd, root } = project();
    const file = writeSkill(root, "searxng", MARKED);
    const h = harness(cwd);
    await h.emit("turn_start", { turnIndex: 4 });
    await h.emit("input", { text: "/skill:searxng find the docs" });

    await h.emit("tool_result", { toolCallId: "t1", toolName: "read", input: { path: file }, isError: true });
    const nudges = h.messages.filter((message) => message.customType === "skill-maintenance-nudge");
    assert.equal(nudges.length, 1);
    assert.match(nudges[0].content, /`searxng` just failed/);
    assert.equal(nudges[0].options.deliverAs, "steer");

    await h.emit("tool_result", { toolCallId: "t2", toolName: "read", input: { path: file }, isError: true });
    assert.equal(h.messages.filter((message) => message.customType === "skill-maintenance-nudge").length, 1);
  });

  it("nudges after an invocation that arrived before turn_start", async () => {
    const { cwd, root } = project();
    const file = writeSkill(root, "searxng", MARKED);
    const h = harness(cwd);
    await h.emit("input", { text: "/skill:searxng" }); // real order: input first
    await h.emit("turn_start", { turnIndex: 4 });
    await h.emit("tool_result", { toolCallId: "t3", toolName: "read", input: { path: file }, isError: true });
    assert.equal(h.messages.filter((message) => message.customType === "skill-maintenance-nudge").length, 1);
  });

  it("uses the error signal only", async () => {
    const { cwd, root } = project();
    const file = writeSkill(root, "searxng", MARKED);
    const h = harness(cwd);
    await h.emit("turn_start", { turnIndex: 6 });
    await h.emit("input", { text: "/skill:searxng" });
    await h.emit("tool_result", { toolCallId: "t4", toolName: "read", input: { path: file }, isError: false });
    assert.equal(h.messages.filter((message) => message.customType === "skill-maintenance-nudge").length, 0);
    await h.emit("tool_result", { toolCallId: "t5", toolName: "read", input: { path: file }, isError: true });
    assert.equal(h.messages.filter((message) => message.customType === "skill-maintenance-nudge").length, 1);
  });

  it("never nudges about an unmarked skill", async () => {
    const { cwd, root } = project();
    writeSkill(root, "unmarked", UNMARKED);
    const h = harness(cwd);
    await h.emit("turn_start", { turnIndex: 7 });
    await h.emit("input", { text: "/skill:unmarked" });
    await h.emit("tool_result", { toolCallId: "t6", toolName: "bash", input: { command: "ls" }, isError: true });
    assert.equal(h.messages.filter((message) => message.customType === "skill-maintenance-nudge").length, 0);
    assert.deepEqual(markedSkillsInText(cwd, "/skill:unmarked"), []);
  });
});

describe("command registration", () => {
  it("autocompletes unmarked skills", async () => {
    const { cwd, root } = project();
    writeSkill(root, "marked", MARKED);
    writeSkill(root, "unmarked", UNMARKED);
    const h = harness(cwd);
    await h.emit("session_start");
    const command = h.commands.get("adopt-skill");
    assert.ok(command);
    assert.deepEqual(
      command.getArgumentCompletions("").map((item: any) => item.value),
      ["unmarked"],
    );
  });

  it("adopts a skill through the command handler", async () => {
    const { cwd, root } = project();
    writeSkill(root, "unmarked", UNMARKED);
    const h = harness(cwd);
    const notices: string[] = [];
    await h.commands.get("adopt-skill").handler("unmarked", {
      cwd,
      ui: { notify: (message: string) => notices.push(message) },
      sessionManager: { getSessionId: () => "s" },
    });
    assert.match(notices[0], /now maintained/);
    assert.equal(readSkillFile(cwd, "unmarked")!.includes(MARKER_LINE), true);
  });
});


describe("second-round findings (Qodo #1079)", () => {
  it("guards the main checkout's skills from a linked worktree", () => {
    const repo = tempDir("skill-maint-repo-");
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "README.md"), "x\n");
    execFileSync("git", ["add", "README.md"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: repo });
    const worktree = path.join(tempDir("skill-maint-wt-"), "wt");
    execFileSync("git", ["worktree", "add", "-q", worktree], { cwd: repo });

    const root = path.join(repo, ".pi", "skills");
    fs.mkdirSync(root, { recursive: true });
    const unmarked = writeSkill(root, "unmarked", UNMARKED);

    // a worktree session must see the project's real skills, not treat them as ordinary
    assert.equal(ownedSkillsRoot(worktree), fs.realpathSync(root));
    assert.equal(isOwnedSkillPath(worktree, unmarked), true);
    assert.equal(
      classifySkillWrite(worktree, unmarked, { edits: [{ oldText: "Run the query.", newText: "Run it." }] }).allow,
      false,
    );
    assert.deepEqual(listUnmarkedSkills(worktree), ["unmarked"]);
  });

  it("allows a references file of a marked skill", () => {
    const { cwd, root } = project();
    writeSkill(root, "marked", MARKED);
    const reference = path.join(root, "marked", "references", "api.md");
    const verdict = classifySkillWrite(cwd, reference, write("# API\n\nUse --flag.\n"));
    assert.equal(verdict.allow, true);
    assert.equal(verdict.file, path.join("references", "api.md"));
  });

  it("refuses a references file of an unmarked skill", () => {
    const { cwd, root } = project();
    writeSkill(root, "unmarked", UNMARKED);
    const reference = path.join(root, "unmarked", "references", "api.md");
    const verdict = classifySkillWrite(cwd, reference, write("# API\n"));
    assert.equal(verdict.allow, false);
    assert.match(verdict.reason ?? "", /\/adopt-skill unmarked/);
  });

  it("records a shell write into an owned skill", async () => {
    const { cwd, root } = project();
    const file = writeSkill(root, "marked", MARKED);
    const h = harness(cwd);
    await h.emit("turn_start", { turnIndex: 1 });
    const command = `printf 'more\\n' >> ${path.relative(cwd, file)}`;
    assert.equal(await h.emit("tool_call", { toolCallId: "b1", toolName: "bash", input: { command } }), undefined);
    fs.writeFileSync(file, `${MARKED}\nshell edit\n`);
    await h.emit("tool_result", { toolCallId: "b1", toolName: "bash", input: { command }, isError: false });

    const [record] = provenanceRecords(cwd);
    assert.equal(record.skill, "marked");
    assert.equal(record.action, "patched");
    assert.equal(record.file, "SKILL.md");
  });

  it("does not record a failed shell write", async () => {
    const { cwd, root } = project();
    const file = writeSkill(root, "marked", MARKED);
    const h = harness(cwd);
    await h.emit("turn_start", { turnIndex: 1 });
    const command = `printf 'x' >> ${path.relative(cwd, file)}`;
    await h.emit("tool_call", { toolCallId: "b2", toolName: "bash", input: { command } });
    await h.emit("tool_result", { toolCallId: "b2", toolName: "bash", input: { command }, isError: true });
    assert.deepEqual(provenanceRecords(cwd), []);
  });

  it("nudges again after an aborted turn", async () => {
    const { cwd, root } = project();
    const file = writeSkill(root, "marked", MARKED);
    const h = harness(cwd);
    await h.emit("turn_start", { turnIndex: 1 });
    await h.emit("input", { text: "/skill:marked" });
    await h.emit("tool_result", { toolCallId: "t1", toolName: "read", input: { path: file }, isError: true });
    // the turn is aborted: no turn_end
    await h.emit("turn_start", { turnIndex: 2 });
    await h.emit("tool_result", { toolCallId: "t2", toolName: "read", input: { path: file }, isError: true });

    const nudges = h.messages.filter((message) => message.customType === "skill-maintenance-nudge");
    assert.equal(nudges.length, 2);
  });

  it("does not steer about a skill left over from an aborted turn", async () => {
    const { cwd, root } = project();
    writeSkill(root, "marked", MARKED);
    const h = harness(cwd);
    // real order: the invocation arrives before the turn it opens
    await h.emit("input", { text: "/skill:marked" });
    await h.emit("turn_start", { turnIndex: 1 });
    // aborted before any failure; the next turn carries no invocation
    await h.emit("turn_start", { turnIndex: 2 });
    await h.emit("tool_result", {
      toolCallId: "t3",
      toolName: "read",
      input: { path: path.join(cwd, "README.md") },
      isError: true,
    });
    assert.equal(h.messages.filter((message) => message.customType === "skill-maintenance-nudge").length, 0);
  });

  it("logs an unreadable skills tree without warning for an absent one", async () => {
    const home = makeTempDir("skill-maint-log-");
    cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    const unreadable = path.join(home, "locked");
    fs.mkdirSync(unreadable, { recursive: true });
    fs.chmodSync(unreadable, 0o000);
    try {
      const { getPiLogPath, setGlobalSessionId } = await import("../../../extensions/shared/file-logger.js");
      setGlobalSessionId("skill-maint-log-test");
      const missing = path.join(home, "nope", ".pi", "skills");
      assert.equal(snapshotSkillTree(missing).size, 0);
      assert.equal(snapshotSkillTree(unreadable).size, 0);
      const logPath = getPiLogPath("skill-maintenance");
      assert.ok(logPath);
      const body = fs.readFileSync(logPath, "utf-8");
      assert.match(body, /skill_snapshot_readdir_failed/);
      assert.ok(body.includes(unreadable), "the failing directory is named");
      assert.ok(!body.includes(missing), "an absent skills tree is not a warning");
    } finally {
      fs.chmodSync(unreadable, 0o755);
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });
});
