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
  realpathNearestExisting,
  registerSkillMaintenance,
  skillAreaOf,
  snapshotSkillTree,
  stampSkill,
} from "../../../extensions/orchestrator/skill-maintenance.js";
import { getPiLogPath, setLogLevelPin } from "../../../extensions/shared/file-logger.js";
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

/**
 * Run `body` with the logger writing under a throwaway HOME and session id, then restore every
 * global it touched — HOME, session id and the level pin — so no later test inherits the temp
 * path, and prove the operator's real `~/.pi/logs` gained nothing for this session id.
 */
function inTempLogHome(sid: string, body: (home: string) => Promise<void>, level?: "debug" | "warn"): Promise<void>;
function inTempLogHome(sid: string, body: (home: string) => void, level?: "debug" | "warn"): void;
function inTempLogHome(
  sid: string,
  body: (home: string) => void | Promise<void>,
  level: "debug" | "warn" = "debug",
): void | Promise<void> {
  const realLog = path.join(os.homedir(), ".pi", "logs", "skill-maintenance", sid, "main.log");
  const stamp = () => (fs.existsSync(realLog) ? `${fs.statSync(realLog).size}:${fs.statSync(realLog).mtimeMs}` : "absent");
  const before = stamp();
  const home = tempDir(`skill-maint-log-${sid}-`);
  const savedHome = process.env.HOME;
  const savedSid = (globalThis as any).__piConfigSessionId;
  process.env.HOME = home;
  (globalThis as any).__piConfigSessionId = sid;
  setLogLevelPin("skill-maintenance", level);
  const cleanup = () => {
    setLogLevelPin("skill-maintenance", null);
    if (savedSid === undefined) delete (globalThis as any).__piConfigSessionId;
    else (globalThis as any).__piConfigSessionId = savedSid;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    assert.equal((globalThis as any).__piConfigSessionId, savedSid, "session id leaked into later tests");
    assert.equal(process.env.HOME, savedHome, "HOME leaked into later tests");
    assert.equal(stamp(), before, `test wrote to the real home: ${realLog}`);
  };
  let result: void | Promise<void>;
  try {
    result = body(home);
  } catch (err) {
    cleanup();
    throw err;
  }
  if (result && typeof (result as Promise<void>).then === "function") {
    return (result as Promise<void>).finally(cleanup);
  }
  cleanup();
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

  it("allows a marked creation under .pi/skills without autoAdopt", () => {
    const { cwd, root } = project();
    const input = write(MARKED);
    const verdict = classifySkillWrite(cwd, path.join(root, "fresh", "SKILL.md"), input);
    assert.equal(verdict.allow, true);
    assert.ok(!verdict.autoAdopt);
    assert.equal(input.content, MARKED);
  });

  it("allows an unmarked write creation under .pi/skills with autoAdopt without mutating input", () => {
    const { cwd, root } = project();
    const input = write(UNMARKED);
    const verdict = classifySkillWrite(cwd, path.join(root, "fresh", "SKILL.md"), input);
    assert.equal(verdict.allow, true);
    assert.equal(verdict.autoAdopt, true);
    assert.equal(verdict.skill, "fresh");
    assert.equal(verdict.file, "SKILL.md");
    assert.equal(input.content, UNMARKED);
  });

  it("refuses overwriting an existing unmarked SKILL.md with unmarked write", () => {
    const { cwd, root } = project();
    const existing = writeSkill(root, "existing", UNMARKED);
    const verdict = classifySkillWrite(cwd, existing, write(UNMARKED));
    assert.equal(verdict.allow, false);
    assert.ok(!verdict.autoAdopt);
  });

  it("refuses overwriting an unreadable existing SKILL.md without auto-adopting", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    inTempLogHome("skill-maint-unreadable-existing", () => {
      const { cwd, root } = project();
      const existing = writeSkill(root, "locked", UNMARKED);
      fs.chmodSync(existing, 0o000);
      try {
        const verdict = classifySkillWrite(cwd, existing, write(UNMARKED));
        assert.equal(verdict.allow, false);
        assert.ok(!verdict.autoAdopt);
        const markedVerdict = classifySkillWrite(cwd, existing, write(MARKED));
        assert.equal(markedVerdict.allow, false);
        assert.ok(!markedVerdict.autoAdopt);
        const logPath = getPiLogPath("skill-maintenance");
        assert.ok(logPath);
        assert.match(fs.readFileSync(logPath, "utf-8"), /skill_write_unreadable_existing/);
      } finally {
        fs.chmodSync(existing, 0o644);
      }
    }, "warn");
  });

  it("refuses an edit targeting a missing SKILL.md", () => {
    const { cwd, root } = project();
    const verdict = classifySkillWrite(cwd, path.join(root, "missing", "SKILL.md"), {
      edits: [{ oldText: "a", newText: "b" }],
    });
    assert.equal(verdict.allow, false);
  });

  it("never auto-adopts unmarked writes via symlink, .agents/skills, or user-global", () => {
    const { cwd, root } = project();
    const outside = tempDir("skill-maint-outside-");
    fs.symlinkSync(outside, path.join(root, "linked"));
    assert.equal(classifySkillWrite(cwd, path.join(root, "linked", "SKILL.md"), write(UNMARKED)).allow, false);
    assert.equal(
      classifySkillWrite(cwd, path.join(cwd, ".agents", "skills", "fresh", "SKILL.md"), write(UNMARKED)).allow,
      false,
    );
    assert.equal(
      classifySkillWrite(cwd, path.join(os.homedir(), ".agents", "skills", "fresh", "SKILL.md"), write(UNMARKED)).allow,
      false,
    );
  });

  it("reads the new text out of a write input", () => {
    assert.equal(incomingText({ content: "abc" }), "abc");
    assert.equal(incomingText({ edits: [{ newText: "a" }, { newText: "b" }] }), "a\nb");
    assert.equal(incomingText(null), "");
  });
});

describe("shell guard (Qodo #1079)", () => {
  const globalSkill = () => path.join(os.homedir(), ".agents", "skills", "x", "SKILL.md");

  it("blocks a shell write to a user-global skill", () => {
    const { cwd } = project();
    assert.equal(bashSkillVerdict(cwd, `echo hacked > ${globalSkill()}`)?.block, true);
  });

  it("blocks a redirection glued to the path", () => {
    const { cwd } = project();
    assert.equal(bashSkillVerdict(cwd, `echo hacked >${globalSkill()}`)?.block, true);
  });

  it("blocks the >& redirection form", () => {
    const { cwd } = project();
    assert.equal(bashSkillVerdict(cwd, "cat README.md >& ~/.agents/skills/x/SKILL.md")?.block, true);
  });

  it("blocks a home-relative target", () => {
    const { cwd } = project();
    assert.equal(bashSkillVerdict(cwd, "echo hacked > ~/.agents/skills/x/SKILL.md")?.block, true);
  });

  it("blocks a bare SKILL.md after cd into a skills area", () => {
    const { cwd } = project();
    assert.equal(bashSkillVerdict(cwd, "cd ~/.agents/skills/x && printf x >> SKILL.md")?.block, true);
  });

  it("blocks a path through a symlink out of the area", () => {
    const { cwd, root } = project();
    const outside = tempDir("skill-maint-outside-");
    fs.writeFileSync(path.join(outside, "SKILL.md"), "# Outside\n");
    fs.symlinkSync(outside, path.join(root, "linked"));
    assert.equal(bashSkillVerdict(cwd, `printf x >> ${path.join(root, "linked", "SKILL.md")}`)?.block, true);
  });

  it("blocks every shell write into a skill, marked or not", () => {
    const { cwd, root } = project();
    writeSkill(root, "marked", MARKED);
    writeSkill(root, "unmarked", UNMARKED);
    for (const name of ["marked", "unmarked"]) {
      assert.equal(bashSkillVerdict(cwd, `printf x >> ${path.join(root, name, "SKILL.md")}`)?.block, true);
      assert.equal(bashSkillVerdict(cwd, `sed -i 's/a/b/' ${path.join(root, name, "SKILL.md")}`)?.block, true);
    }
  });

  it("blocks cp into a skill whatever the option shape", () => {
    const { cwd, root } = project();
    writeSkill(root, "unmarked", UNMARKED);
    for (const command of [
      `cp -t ${path.join(root, "unmarked")} /tmp/SKILL.md`,
      `cp --target-directory=${path.join(root, "unmarked")} /tmp/SKILL.md`,
      `cp -rt ${path.join(root, "unmarked")} /tmp/SKILL.md`,
      `cp --target ${path.join(root, "unmarked")} /tmp/SKILL.md`,
    ]) {
      assert.equal(bashSkillVerdict(cwd, command)?.block, true, command);
    }
  });

  it("blocks copying a skill anywhere, even out of it", () => {
    const { cwd } = project();
    assert.equal(bashSkillVerdict(cwd, `cp ${globalSkill()} ./notes.md`)?.block, true);
    assert.equal(bashSkillVerdict(cwd, `mv ${globalSkill()} ./notes.md`)?.block, true);
  });

  it("blocks a pipeline whose later stage writes a skill", () => {
    const { cwd, root } = project();
    writeSkill(root, "marked", MARKED);
    const read = `cat ${path.join(root, "marked", "SKILL.md")}`;
    assert.equal(bashSkillVerdict(cwd, read), null);
    assert.equal(
      bashSkillVerdict(cwd, `${read} | uv run python3 -c 'open("${path.join(root, "unmarked", "SKILL.md")}", "w")'`)?.block,
      true,
    );
    assert.equal(
      bashSkillVerdict(cwd, `${read} && uv run python3 -c 'open("${path.join(root, "unmarked", "SKILL.md")}", "w")'`)?.block,
      true,
    );
  });

  it("allows an allowlisted read of a skill", () => {
    const { cwd } = project();
    assert.equal(bashSkillVerdict(cwd, `cat ${globalSkill()}`), null);
    assert.equal(bashSkillVerdict(cwd, `rg skill ${globalSkill()}`), null);
    assert.equal(bashSkillVerdict(cwd, "ls -la ~/.agents/skills/x"), null);
  });

  it("allows a read whose search term looks destructive", () => {
    const { cwd } = project();
    assert.equal(bashSkillVerdict(cwd, "rg 'rm' ~/.agents/skills/x/SKILL.md"), null);
  });

  it("allows a glob pattern that merely names SKILL.md", () => {
    const { cwd } = project();
    assert.equal(bashSkillVerdict(cwd, "rg --glob=SKILL.md TODO ."), null);
  });

  it("blocks a command that touches a skill with a verb it cannot vouch for", () => {
    const { cwd } = project();
    assert.equal(bashSkillVerdict(cwd, `python3 -c 'open("${globalSkill()}", "w")'`)?.block, true);
  });

  it("blocks a command substitution anywhere in the command", () => {
    const { cwd, root } = project();
    writeSkill(root, "marked", MARKED);
    const read = `cat ${path.join(root, "marked", "SKILL.md")}`;
    assert.equal(
      bashSkillVerdict(cwd, `${read} $(python3 -c 'open("${path.join(root, "marked", "SKILL.md")}", "w")')`)?.block,
      true,
    );
    assert.equal(bashSkillVerdict(cwd, "`printf x` >> ~/.agents/skills/x/SKILL.md")?.block, true);
  });

  it("blocks a read verb whose option runs a program", () => {
    const { cwd } = project();
    assert.equal(bashSkillVerdict(cwd, "rg --pre=./rewrite.sh pattern ~/.agents/skills/x/SKILL.md")?.block, true);
  });

  it("blocks mkdir through a symlinked parent", () => {
    const { cwd, root } = project();
    const outside = tempDir("skill-maint-outside-");
    fs.symlinkSync(outside, path.join(root, "linked"));
    assert.equal(bashSkillVerdict(cwd, `mkdir -p ${path.join(root, "linked", "new")}`)?.block, true);
  });

  it("blocks mkdir with an operand outside the skills tree", () => {
    const { cwd, root } = project();
    assert.equal(bashSkillVerdict(cwd, `mkdir -p ${path.join(root, "ok")} /tmp/elsewhere`)?.block, true);
  });

  it("blocks a command substitution anywhere in the command", () => {
    const { cwd, root } = project();
    writeSkill(root, "marked", MARKED);
    const read = `cat ${path.join(root, "marked", "SKILL.md")}`;
    const nested = `${read} $(python3 -c 'open("${path.join(root, "marked", "SKILL.md")}", "w")')`;
    assert.equal(bashSkillVerdict(cwd, nested)?.block, true);
    assert.equal(bashSkillVerdict(cwd, "printf x $(date) >> ~/.agents/skills/x/SKILL.md")?.block, true);
  });

  it("blocks process substitution, which also runs a nested command", () => {
    const { cwd, root } = project();
    writeSkill(root, "marked", MARKED);
    const read = `cat ${path.join(root, "marked", "SKILL.md")}`;
    const nested = `${read} <(python3 -c 'open("${path.join(root, "unmarked", "SKILL.md")}", "w")')`;
    assert.equal(bashSkillVerdict(cwd, nested)?.block, true);
  });

  it("blocks a read verb whose option runs a program", () => {
    const { cwd } = project();
    assert.equal(bashSkillVerdict(cwd, "rg --pre=./rewrite.sh pattern ~/.agents/skills/x/SKILL.md")?.block, true);
  });

  it("blocks mkdir through a symlinked parent", () => {
    const { cwd, root } = project();
    const outside = tempDir("skill-maint-outside-");
    fs.symlinkSync(outside, path.join(root, "linked"));
    assert.equal(bashSkillVerdict(cwd, `mkdir -p ${path.join(root, "linked", "new")}`)?.block, true);
  });

  it("blocks mkdir with an operand outside the skills tree", () => {
    const { cwd, root } = project();
    assert.equal(bashSkillVerdict(cwd, `mkdir -p ${path.join(root, "ok")} /tmp/elsewhere`)?.block, true);
  });

  it("allows mkdir inside the owned skills tree", () => {
    const { cwd, root } = project();
    assert.equal(bashSkillVerdict(cwd, `mkdir -p ${path.join(root, "brand-new")}`), null);
  });

  it("allows an ordinary write that mentions no skills area", () => {
    const { cwd } = project();
    assert.equal(bashSkillVerdict(cwd, "echo hi > notes.txt"), null);
    assert.equal(bashSkillVerdict(cwd, "git commit -m 'fix skill guard'"), null);
  });
});

describe("skill helper script execution (#1103)", () => {
  it("allows uv run --script on a user-global skill python helper with stderr muted", () => {
    const { cwd } = project();
    assert.equal(bashSkillVerdict(cwd, "uv run --script ~/.pi/agent/skills/gh-issues/gh-issues.py 2>/dev/null"), null);
  });

  it("allows rtk-wrapped uv run --script on a user-global skill python helper", () => {
    const { cwd } = project();
    assert.equal(
      bashSkillVerdict(cwd, "rtk uv run --script ~/.pi/agent/skills/gh-issues/gh-issues.py 2>/dev/null"),
      null,
    );
  });

  it("allows direct execution of a project skill shell helper", () => {
    const { cwd } = project();
    assert.equal(bashSkillVerdict(cwd, ".pi/skills/verify-all/run-suites.sh --fast"), null);
  });

  it("allows bash execution of a project skill shell helper", () => {
    const { cwd } = project();
    assert.equal(
      bashSkillVerdict(cwd, "bash .pi/skills/release-publish/publish-release.sh prepare --package pi-orchestrator-config"),
      null,
    );
  });

  it("allows packaged skill helper execution with env prefix", () => {
    const { cwd } = project();
    assert.equal(
      bashSkillVerdict(
        cwd,
        "FOO=bar ~/.pi/agent/npm/node_modules/pi-orchestrator-config/skills/demo/helper.sh --check",
      ),
      null,
    );
  });

  it("allows single-quoted skill prose with backticks in gh issue create", () => {
    const { cwd } = project();
    assert.equal(
      bashSkillVerdict(cwd, "gh issue create --title \"t\" --body 'mentions `.pi/skills/foo/SKILL.md` in single quotes'"),
      null,
    );
  });

  it("blocks double-quoted substitution touching a skill in gh issue create", () => {
    const { cwd } = project();
    assert.equal(
      bashSkillVerdict(cwd, 'gh issue create --title "t" --body "mentions $(cat .pi/skills/foo/SKILL.md)"')?.block,
      true,
    );
  });

  it("blocks output redirection into a project skill script", () => {
    const { cwd } = project();
    assert.equal(bashSkillVerdict(cwd, "echo hi > .pi/skills/verify-all/run-suites.sh")?.block, true);
  });

  it("blocks in-place sed on a user-global skill script", () => {
    const { cwd } = project();
    assert.equal(bashSkillVerdict(cwd, "sed -i 's/a/b/' ~/.pi/agent/skills/gh-issues/gh-issues.py")?.block, true);
  });

  it("blocks cp into a project skill file", () => {
    const { cwd } = project();
    assert.equal(bashSkillVerdict(cwd, "cp /tmp/x .pi/skills/foo/SKILL.md")?.block, true);
  });

  it("blocks inline python writing a project skill file", () => {
    const { cwd } = project();
    assert.equal(bashSkillVerdict(cwd, "python3 -c \"open('.pi/skills/foo/SKILL.md','w')\"")?.block, true);
  });

  it("blocks inline node writing a project skill file", () => {
    const { cwd } = project();
    assert.equal(bashSkillVerdict(cwd, "node -e \"fs.writeFileSync('.pi/skills/foo/SKILL.md','x')\"")?.block, true);
  });

  it("blocks bash -c mentioning a project skill file", () => {
    const { cwd } = project();
    assert.equal(bashSkillVerdict(cwd, "bash -c \"echo hi > .pi/skills/foo/SKILL.md\"")?.block, true);
  });

  it("blocks piping skill-mentioning code into an interpreter", () => {
    const { cwd } = project();
    assert.equal(bashSkillVerdict(cwd, "echo \"open('.pi/skills/foo/SKILL.md','w')\" | python3")?.block, true);
  });

  it("blocks perl -i on a skill script", () => {
    const { cwd } = project();
    assert.equal(bashSkillVerdict(cwd, "perl -pi -e 's/a/b/' ~/.pi/agent/skills/gh-issues/gh-issues.py")?.block, true);
  });

  it("blocks git checkout on a skill file", () => {
    const { cwd } = project();
    assert.equal(bashSkillVerdict(cwd, "git checkout -- .pi/skills/foo/SKILL.md")?.block, true);
  });

  it("blocks chmod on a skill script", () => {
    const { cwd } = project();
    assert.equal(bashSkillVerdict(cwd, "chmod +x .pi/skills/verify-all/run-suites.sh")?.block, true);
  });

  it("blocks touch on a skill script", () => {
    const { cwd } = project();
    assert.equal(bashSkillVerdict(cwd, "touch .pi/skills/verify-all/run-suites.sh")?.block, true);
  });

  it("blocks patch on a skill file", () => {
    const { cwd } = project();
    assert.equal(bashSkillVerdict(cwd, "patch .pi/skills/foo/SKILL.md /tmp/fix.patch")?.block, true);
  });

  it("blocks executing SKILL.md as a script", () => {
    const { cwd } = project();
    assert.equal(bashSkillVerdict(cwd, "bash .pi/skills/foo/SKILL.md")?.block, true);
  });

  it("blocks executing a skill script through a symlink out of the project", () => {
    const { cwd, root } = project();
    const outside = tempDir("skill-maint-script-out-");
    fs.writeFileSync(path.join(outside, "run.sh"), "#!/bin/sh\n");
    fs.symlinkSync(outside, path.join(root, "linked"));
    assert.equal(bashSkillVerdict(cwd, `bash ${path.join(root, "linked", "run.sh")}`)?.block, true);
  });

  it("blocks heredoc interpreter writing a skill file", () => {
    const { cwd } = project();
    assert.equal(
      bashSkillVerdict(cwd, "python3 << 'EOF'\nopen('.pi/skills/foo/SKILL.md', 'w').write('x')\nEOF")?.block,
      true,
    );
  });

  it("allows a data-writer heredoc whose target is outside skills (#1125)", () => {
    const { cwd } = project();
    assert.equal(
      bashSkillVerdict(cwd, "cat > .pi/tmp/msg.txt <<'EOF'\nsee .pi/skills/verify-all/run-suites.sh for details\nEOF"),
      null,
    );
  });

  it("allows tee a non-skill file with a skill-mentioning heredoc body (#1125)", () => {
    const { cwd } = project();
    assert.equal(
      bashSkillVerdict(cwd, "tee .pi/tmp/x.txt <<'EOF'\nsee .pi/skills/verify-all/run-suites.sh\nEOF"),
      null,
    );
  });

  it("blocks a heredoc whose redirect target is a skill file (#1125)", () => {
    const { cwd, root } = project();
    const skill = path.join(root, "x", "SKILL.md");
    assert.equal(bashSkillVerdict(cwd, `cat > ${skill} <<'EOF'\nplain body\nEOF`)?.block, true);
    assert.equal(bashSkillVerdict(cwd, `tee ${skill} <<'EOF'\nplain body\nEOF`)?.block, true);
  });

  it("blocks a heredoc fed to an interpreter, whatever the shell (#1125)", () => {
    const { cwd } = project();
    const body = "rm .pi/skills/x/run-suites.sh";
    for (const cmd of [`bash <<'EOF'\n${body}\nEOF`, `sh -s <<'EOF'\n${body}\nEOF`, `node <<'EOF'\n${body}\nEOF`]) {
      assert.equal(bashSkillVerdict(cwd, cmd)?.block, true, cmd);
    }
  });

  it("blocks xargs consuming a heredoc that lists a skill file (#1125)", () => {
    const { cwd } = project();
    assert.equal(bashSkillVerdict(cwd, "xargs rm <<'EOF'\n.pi/skills/x/SKILL.md\nEOF")?.block, true);
  });

  it("blocks a heredoc piped into an interpreter (#1125)", () => {
    const { cwd } = project();
    assert.equal(
      bashSkillVerdict(cwd, "cat <<'EOF' | bash\nrm .pi/skills/x/run-suites.sh\nEOF")?.block,
      true,
    );
  });

  it("blocks an unquoted heredoc body whose substitution names a skill (#1125)", () => {
    const { cwd } = project();
    assert.equal(
      bashSkillVerdict(cwd, "cat > .pi/tmp/x.txt <<EOF\n$(rm .pi/skills/x/run-suites.sh)\nEOF")?.block,
      true,
    );
  });

  it("blocks an escaped separator hiding an interpreter behind a data writer (#1125)", () => {
    const { cwd } = project();
    assert.equal(
      bashSkillVerdict(cwd, "sh -s x\\; echo <<'EOF'\nrm .pi/skills/x/run-suites.sh\nEOF")?.block,
      true,
    );
  });

  it("ignores a heredoc opener that starts a comment (#1125)", () => {
    const { cwd } = project();
    assert.equal(
      bashSkillVerdict(cwd, "cat > .pi/tmp/out.txt <<REAL # <<FAKE\nhello\nREAL\nrm .pi/skills/x/SKILL.md\nFAKE")?.block,
      true,
    );
  });

  it("does not blank a heredoc body that a later segment runs (#1125)", () => {
    const { cwd } = project();
    assert.equal(
      bashSkillVerdict(cwd, "cat > .pi/tmp/cleanup.sh <<'EOF'\nrm -f .pi/skills/x/SKILL.md\nEOF\n; bash .pi/tmp/cleanup.sh")?.block,
      true,
    );
  });

  it("does not blank a heredoc body whose written script is run by its own path (#1125)", () => {
    const { cwd } = project();
    assert.equal(
      bashSkillVerdict(
        cwd,
        "cat > .pi/tmp/c.sh <<'EOF'\n#!/bin/sh\nrm -f .pi/skills/x/SKILL.md\nEOF\nchmod +x .pi/tmp/c.sh && .pi/tmp/c.sh",
      )?.block,
      true,
    );
  });

  it("does not blank a heredoc body whose file is run on the opener's own line (#1125)", () => {
    const { cwd } = project();
    assert.equal(
      bashSkillVerdict(cwd, "cat > .pi/tmp/x.sh <<'EOF' && bash .pi/tmp/x.sh\nrm -f .pi/skills/x/SKILL.md\nEOF")?.block,
      true,
    );
  });

  it("does not blank a heredoc body whose file is sourced by a `-c` program (#1125)", () => {
    const { cwd } = project();
    for (const run of ["bash -c 'source .pi/tmp/c.sh'", "sh -c '. .pi/tmp/c.sh'", "bash -ec '. .pi/tmp/c.sh'"]) {
      assert.equal(
        bashSkillVerdict(cwd, `cat > .pi/tmp/c.sh <<'EOF'\nrm -f .pi/skills/x/SKILL.md\nEOF\n${run}`)?.block,
        true,
        run,
      );
    }
  });

  it("allows single cat > /tmp/msg.txt <<'EOF' with skill-path prose (#1125)", () => {
    const { cwd } = project();
    assert.equal(
      bashSkillVerdict(cwd, "cat > /tmp/msg.txt <<'EOF'\nsee .pi/skills/verify-all/run-suites.sh for details\nEOF"),
      null,
    );
  });

  it("blocks heredoc write followed by exec or redirected bash (#1125)", () => {
    const { cwd } = project();
    for (const follow of ["exec .pi/tmp/x.sh", "bash < .pi/tmp/x.sh"]) {
      assert.equal(
        bashSkillVerdict(cwd, `cat > .pi/tmp/x.sh <<'EOF'\nrm -f .pi/skills/x/SKILL.md\nEOF\n${follow}`)?.block,
        true,
        follow,
      );
    }
  });

  it("blocks a heredoc write paired with a second segment such as && git commit -F (#1125)", () => {
    const { cwd } = project();
    assert.equal(
      bashSkillVerdict(
        cwd,
        "cat > /tmp/msg.txt <<'EOF' && git commit -F /tmp/msg.txt\nsee .pi/skills/verify-all/run-suites.sh\nEOF",
      )?.block,
      true,
    );
  });

  it("blocks a heredoc write wrapped in a subshell (#1125)", () => {
    const { cwd } = project();
    for (const cmd of [
      "(cat > /tmp/msg.txt <<'EOF'\nsee .pi/skills/x/SKILL.md\nEOF\n)",
      "(cat > /tmp/msg.txt <<'EOF')\nsee .pi/skills/x/SKILL.md\nEOF",
    ]) {
      assert.equal(bashSkillVerdict(cwd, cmd)?.block, true, cmd);
    }
  });

  it("reads a backslash-quoted heredoc delimiter as quoted (#1125)", () => {
    const { cwd } = project();
    assert.equal(
      bashSkillVerdict(cwd, "cat > .pi/tmp/msg.txt <<\\EOF\nsee .pi/skills/verify-all/run-suites.sh\nEOF"),
      null,
    );
  });

  it("does not read a quoted pipe as a pipeline in the heredoc opener (#1125)", () => {
    const { cwd } = project();
    assert.equal(
      bashSkillVerdict(cwd, "printf '|%s' x > .pi/tmp/msg.txt <<'EOF'\nsee .pi/skills/verify-all/run-suites.sh\nEOF"),
      null,
    );
  });

  it("allows printf writing skill-path prose to a non-skill file (#1125)", () => {
    const { cwd } = project();
    assert.equal(
      bashSkillVerdict(cwd, "printf '%s\\n' x > .pi/tmp/prose.txt <<'EOF'\nsee .pi/skills/verify-all/run-suites.sh\nEOF"),
      null,
    );
  });

  it("allows git commit -F on a file whose contents mention a skill (#1125)", () => {
    const { cwd } = project();
    assert.equal(bashSkillVerdict(cwd, "git commit -F .pi/tmp/prose.txt"), null);
  });

  it("blocks python3 consuming a heredoc that names a skill path (#1125)", () => {
    const { cwd } = project();
    assert.equal(
      bashSkillVerdict(cwd, "python3 <<'EOF'\nopen('.pi/skills/x/SKILL.md').read()\nEOF")?.block,
      true,
    );
  });

  it("does not treat a here-string <<< as a heredoc opener (#1125)", () => {
    const { cwd } = project();
    assert.equal(
      bashSkillVerdict(cwd, "cat <<<x > /tmp/a\nrm -f .pi/skills/s/SKILL.md\nx")?.block,
      true,
    );
  });

  it("does not blank a heredoc redirected into a process substitution (#1125)", () => {
    const { cwd } = project();
    assert.equal(
      bashSkillVerdict(cwd, "cat <<'EOF' > >(bash)\nrm -f .pi/skills/s/SKILL.md\nEOF")?.block,
      true,
    );
  });

  it("does not blank a heredoc redirected via command substitution (#1125)", () => {
    const { cwd } = project();
    assert.equal(
      bashSkillVerdict(cwd, "cat <<'EOF' > $(echo /tmp/out)\nrm -f .pi/skills/s/SKILL.md\nEOF")?.block,
      true,
    );
  });

  it("allows reading a skill whose name contains a write-verb prefix", () => {
    const { cwd } = project();
    assert.equal(bashSkillVerdict(cwd, "cat .pi/skills/install-tools/SKILL.md"), null);
  });

  it("blocks quoted bash -c writing a project skill file", () => {
    const { cwd } = project();
    assert.equal(bashSkillVerdict(cwd, '"bash" "-c" "echo hi > .pi/skills/foo/SKILL.md"')?.block, true);
  });

  it("blocks quoted python3 -c writing a project skill file", () => {
    const { cwd } = project();
    assert.equal(bashSkillVerdict(cwd, `'python3' '-c' 'open(".pi/skills/foo/SKILL.md", "w")'`)?.block, true);
  });

  it("blocks quoted node -e writing a project skill file", () => {
    const { cwd } = project();
    assert.equal(
      bashSkillVerdict(cwd, `"node" "-e" "fs.writeFileSync('.pi/skills/foo/SKILL.md', 'x')"`)?.block,
      true,
    );
  });

  it("blocks node --eval writing a project skill file", () => {
    const { cwd } = project();
    assert.equal(
      bashSkillVerdict(cwd, `node --eval "fs.writeFileSync('.pi/skills/foo/SKILL.md', 'x')"`)?.block,
      true,
    );
  });

  it("blocks eval writing a project skill file", () => {
    const { cwd } = project();
    assert.equal(bashSkillVerdict(cwd, 'eval "echo hi > .pi/skills/foo/SKILL.md"')?.block, true);
  });

  it("blocks executing a helper script inside a marked project skill", () => {
    const { cwd, root } = project();
    writeSkill(root, "marked", MARKED);
    const helper = path.join(root, "marked", "helper.sh");
    fs.writeFileSync(helper, "#!/bin/sh\n");
    const verdict = bashSkillVerdict(cwd, `bash ${helper}`);
    assert.equal(verdict?.block, true);
    assert.match(verdict?.reason ?? "", /skill-maintenance: auto/);
  });

  it("allows executing a helper script inside an unmarked project skill", () => {
    const { cwd, root } = project();
    writeSkill(root, "verify-all", UNMARKED);
    const helper = path.join(root, "verify-all", "run-suites.sh");
    fs.writeFileSync(helper, "#!/bin/sh\n");
    assert.equal(bashSkillVerdict(cwd, `bash ${helper}`), null);
  });

  it("allows a cd that cannot change what a relative skill path means", () => {
    const { cwd, root } = project();
    writeSkill(root, "verify-all", UNMARKED);
    fs.writeFileSync(path.join(root, "verify-all", "run-suites.sh"), "#!/bin/sh\n");
    // cd into the project itself: every relative reference resolves to the same absolute path
    // as it does without the cd, so the directory change is provably irrelevant.
    assert.equal(
      bashSkillVerdict(cwd, `cd ${cwd} && bash .pi/skills/verify-all/run-suites.sh`),
      null,
    );
  });

  it("allows a cd elsewhere when every skill path is absolute", () => {
    const { cwd, root } = project();
    writeSkill(root, "verify-all", UNMARKED);
    const helper = path.join(root, "verify-all", "run-suites.sh");
    fs.writeFileSync(helper, "#!/bin/sh\n");
    assert.equal(bashSkillVerdict(cwd, `cd /tmp && bash ${helper}`), null);
  });

  it("blocks a cd that would move a relative skill path", () => {
    const { cwd, root } = project();
    writeSkill(root, "verify-all", UNMARKED);
    fs.writeFileSync(path.join(root, "verify-all", "run-suites.sh"), "#!/bin/sh\n");
    assert.equal(
      bashSkillVerdict(cwd, "cd /tmp && bash .pi/skills/verify-all/run-suites.sh")?.block,
      true,
    );
  });

  it("blocks a relative cd target", () => {
    const { cwd, root } = project();
    writeSkill(root, "verify-all", UNMARKED);
    fs.writeFileSync(path.join(root, "verify-all", "run-suites.sh"), "#!/bin/sh\n");
    assert.equal(bashSkillVerdict(cwd, "cd sub && bash .pi/skills/verify-all/run-suites.sh")?.block, true);
  });

  it("blocks a chain of cds", () => {
    const { cwd, root } = project();
    writeSkill(root, "verify-all", UNMARKED);
    fs.writeFileSync(path.join(root, "verify-all", "run-suites.sh"), "#!/bin/sh\n");
    assert.equal(
      bashSkillVerdict(cwd, `cd ${cwd} && cd /tmp && bash .pi/skills/verify-all/run-suites.sh`)?.block,
      true,
    );
  });

  it("blocks a $PWD reference that expands after the cd", () => {
    const { cwd, root } = project();
    writeSkill(root, "verify-all", UNMARKED);
    fs.writeFileSync(path.join(root, "verify-all", "run-suites.sh"), "#!/bin/sh\n");
    assert.equal(
      bashSkillVerdict(cwd, "cd /tmp && bash $PWD/.pi/skills/verify-all/run-suites.sh")?.block,
      true,
    );
    assert.equal(
      bashSkillVerdict(cwd, "cd /tmp && bash ${PWD}/.pi/skills/verify-all/run-suites.sh")?.block,
      true,
    );
  });

  it("blocks a cd through a symlink that moves a relative skill path (#1124)", () => {
    // `link` and `proj` are siblings, so `../proj/.pi/skills/...` reads as the project's own
    // script from the link's TEXT — but `link` really points into another tree, and that is
    // where the shell resolves the relative path from.
    const base = tempDir("skill-maint-cd-link-");
    const cwd = path.join(base, "proj");
    const root = path.join(cwd, ".pi", "skills");
    fs.mkdirSync(root, { recursive: true });
    writeSkill(root, "verify-all", UNMARKED);
    fs.writeFileSync(path.join(root, "verify-all", "run-suites.sh"), "#!/bin/sh\n");
    const deep = path.join(tempDir("skill-maint-cd-deep-"), "deep");
    fs.mkdirSync(deep);
    fs.symlinkSync(deep, path.join(base, "link"));
    assert.equal(
      bashSkillVerdict(cwd, `cd ${base}/link && bash ../proj/.pi/skills/verify-all/run-suites.sh`)?.block,
      true,
    );
  });

  it("blocks a relative `..` reference after a cd (#1124)", () => {
    // The finding's shape: `link` -> this project, and the project's own `foo` -> another tree.
    // Lexically `foo/../.pi/skills/...` is this project's helper, but the shell follows `foo`
    // first and runs the attacker's file, so the reference cannot be pinned.
    const base = tempDir("skill-maint-cd-dotdot-");
    const cwd = path.join(base, "proj");
    const root = path.join(cwd, ".pi", "skills");
    fs.mkdirSync(root, { recursive: true });
    writeSkill(root, "verify-all", UNMARKED);
    fs.writeFileSync(path.join(root, "verify-all", "run-suites.sh"), "#!/bin/sh\n");
    const attacker = path.join(tempDir("skill-maint-cd-attacker-"), ".pi", "skills", "verify-all");
    fs.mkdirSync(attacker, { recursive: true });
    fs.writeFileSync(path.join(attacker, "run-suites.sh"), "#!/bin/sh\n");
    fs.mkdirSync(path.join(attacker, "..", "..", "deep"));
    fs.symlinkSync(path.join(attacker, "..", "..", "deep"), path.join(cwd, "foo"));
    fs.symlinkSync(cwd, path.join(base, "link"));
    assert.equal(
      bashSkillVerdict(cwd, `cd ${base}/link && bash foo/../.pi/skills/verify-all/run-suites.sh`)?.block,
      true,
    );
  });

  it("blocks a plain relative `..` reference after a cd (#1124)", () => {
    const base = tempDir("skill-maint-cd-dotdot-plain-");
    const cwd = path.join(base, "proj");
    const root = path.join(cwd, ".pi", "skills");
    fs.mkdirSync(root, { recursive: true });
    writeSkill(root, "verify-all", UNMARKED);
    fs.writeFileSync(path.join(root, "verify-all", "run-suites.sh"), "#!/bin/sh\n");
    // `../proj/...` collapses to this project's own skill from the TEXT alone; collapsing `..`
    // lexically is not what the shell does, so the reference is refused rather than compared.
    assert.equal(
      bashSkillVerdict(cwd, `cd ${cwd} && bash ../${path.basename(cwd)}/.pi/skills/verify-all/run-suites.sh`)
        ?.block,
      true,
    );
  });

  it("allows a cd into a symlinked project whose relative skill path is the same file", () => {
    const real = tempDir("skill-maint-real-proj-");
    const root = path.join(real, ".pi", "skills");
    fs.mkdirSync(root, { recursive: true });
    writeSkill(root, "verify-all", UNMARKED);
    fs.writeFileSync(path.join(root, "verify-all", "run-suites.sh"), "#!/bin/sh\n");
    const linkedProject = path.join(tempDir("skill-maint-linked-proj-"), "proj");
    fs.symlinkSync(real, linkedProject);
    // Both sides realpath to the same directory: the cd still changes nothing.
    assert.equal(
      bashSkillVerdict(linkedProject, `cd ${linkedProject} && bash .pi/skills/verify-all/run-suites.sh`),
      null,
    );
  });

  it("blocks a quoted or escaped cd", () => {
    const { cwd, root } = project();
    writeSkill(root, "verify-all", UNMARKED);
    fs.writeFileSync(path.join(root, "verify-all", "run-suites.sh"), "#!/bin/sh\n");
    assert.equal(
      bashSkillVerdict(cwd, "'cd' /tmp && bash .pi/skills/verify-all/run-suites.sh")?.block,
      true,
    );
    assert.equal(
      bashSkillVerdict(cwd, "c\\d /tmp && bash .pi/skills/verify-all/run-suites.sh")?.block,
      true,
    );
  });

  it("unwraps timeout so a bounded helper run is read as the helper run", () => {
    const { cwd, root } = project();
    writeSkill(root, "verify-all", UNMARKED);
    const helper = path.join(root, "verify-all", "run-suites.sh");
    fs.writeFileSync(helper, "#!/bin/sh\n");
    assert.equal(bashSkillVerdict(cwd, `timeout 3000 bash ${helper}`), null);
    assert.equal(bashSkillVerdict(cwd, `timeout -k 2 5 bash ${helper}`), null);
    // Unwrapping must expose a write, never hide it.
    assert.equal(bashSkillVerdict(cwd, `timeout 5 rm ${helper}`)?.block, true);
    assert.equal(bashSkillVerdict(cwd, `timeout -s KILL 5 sed -i 's/a/b/' ${helper}`)?.block, true);
  });

  it("unwraps timeout's value-taking long options", () => {
    const { cwd, root } = project();
    writeSkill(root, "verify-all", UNMARKED);
    assert.equal(bashSkillVerdict(cwd, "timeout --signal TERM 5 cat .pi/skills/verify-all/SKILL.md"), null);
    assert.equal(bashSkillVerdict(cwd, "timeout --kill-after=5 5 cat .pi/skills/verify-all/SKILL.md"), null);
  });

  it("unwraps env nested after timeout", () => {
    const { cwd, root } = project();
    writeSkill(root, "verify-all", UNMARKED);
    const helper = path.join(root, "verify-all", "run-suites.sh");
    fs.writeFileSync(helper, "#!/bin/sh\n");
    assert.equal(bashSkillVerdict(cwd, `timeout 5 env bash ${helper}`), null);
    assert.equal(bashSkillVerdict(cwd, `timeout 5 env rm ${helper}`)?.block, true);
  });

  it("allows reading a skill file with 2>&1 descriptor forwarding", () => {
    const { cwd } = project();
    assert.equal(bashSkillVerdict(cwd, "cat .pi/skills/foo/SKILL.md 2>&1"), null);
  });

  it("allows reading a skill file with >&2 descriptor forwarding", () => {
    const { cwd } = project();
    assert.equal(bashSkillVerdict(cwd, "cat .pi/skills/foo/SKILL.md >&2"), null);
  });

  it("allows reading a skill file with 2>&- descriptor close", () => {
    const { cwd } = project();
    assert.equal(bashSkillVerdict(cwd, "cat .pi/skills/foo/SKILL.md 2>&-"), null);
  });

  it("blocks executing a packaged skill script through a symlinked skill directory", () => {
    const { cwd } = project();
    const outside = tempDir("skill-maint-pkg-out-");
    fs.writeFileSync(path.join(outside, "run.sh"), "#!/bin/sh\n");
    const pkgSkills = path.join(cwd, "node_modules", "pkg", "skills");
    fs.mkdirSync(pkgSkills, { recursive: true });
    fs.symlinkSync(outside, path.join(pkgSkills, "linked"));
    assert.equal(bashSkillVerdict(cwd, "bash node_modules/pkg/skills/linked/run.sh")?.block, true);
  });

  it("allows executing a real packaged skill script on disk", () => {
    const { cwd } = project();
    const pkgSkill = path.join(cwd, "node_modules", "pkg", "skills", "demo");
    fs.mkdirSync(pkgSkill, { recursive: true });
    fs.writeFileSync(path.join(pkgSkill, "run.sh"), "#!/bin/sh\n");
    assert.equal(bashSkillVerdict(cwd, "bash node_modules/pkg/skills/demo/run.sh"), null);
  });

  it("records debug traces for shell parser helpers", () => {
    const { cwd } = project();
    inTempLogHome("skill-maint-shell-log-test", () => {
      assert.equal(bashSkillVerdict(cwd, "cat .pi/skills/foo/SKILL.md 2>&1"), null);
      const logPath = getPiLogPath("skill-maintenance");
      assert.ok(logPath);
      assert.match(fs.readFileSync(logPath, "utf-8"), /skill_shell_segment_parsed/);
    });
  });
});

describe("shell syntax check (#1138)", () => {
  /** A marked and an unmarked project skill, each with a `run.sh` helper. */
  function both(): { cwd: string; root: string; markedScript: string; unmarkedScript: string } {
    const { cwd, root } = project();
    writeSkill(root, "marked", MARKED);
    writeSkill(root, "verify-all", UNMARKED);
    const markedScript = path.join(root, "marked", "run.sh");
    const unmarkedScript = path.join(root, "verify-all", "run.sh");
    fs.writeFileSync(markedScript, "#!/bin/sh\necho hi\n");
    fs.writeFileSync(unmarkedScript, "#!/bin/sh\necho hi\n");
    return { cwd, root, markedScript, unmarkedScript };
  }

  it("allows bash -n on a MARKED project skill script", () => {
    const { cwd, markedScript } = both();
    assert.equal(bashSkillVerdict(cwd, `bash -n ${markedScript}`), null);
  });

  it("allows bash -n on an unmarked project skill script", () => {
    const { cwd, unmarkedScript } = both();
    assert.equal(bashSkillVerdict(cwd, `bash -n ${unmarkedScript}`), null);
  });

  it("allows sh -n on a marked project skill script", () => {
    const { cwd, markedScript } = both();
    assert.equal(bashSkillVerdict(cwd, `sh -n ${markedScript}`), null);
  });

  it("allows bash --noexec on a marked project skill script", () => {
    const { cwd, markedScript } = both();
    assert.equal(bashSkillVerdict(cwd, `bash --noexec ${markedScript}`), null);
  });

  it("allows a relative bash -n with a trailing success check", () => {
    const { cwd } = both();
    assert.equal(bashSkillVerdict(cwd, "bash -n .pi/skills/marked/run.sh && echo 'syntax OK'"), null);
  });

  it("still blocks running a MARKED project skill script", () => {
    const { cwd, markedScript } = both();
    const verdict = bashSkillVerdict(cwd, `bash ${markedScript}`);
    assert.equal(verdict?.block, true);
    assert.match(verdict?.reason ?? "", /skill-maintenance: auto/);
  });

  it("still blocks bash -nc as inline code naming a skill", () => {
    const { cwd } = both();
    assert.equal(bashSkillVerdict(cwd, "bash -nc 'rm -rf .pi/skills/marked'")?.block, true);
  });

  it("still blocks bash -c naming a skill", () => {
    const { cwd } = both();
    assert.equal(bashSkillVerdict(cwd, "bash -c 'rm -rf .pi/skills/marked'")?.block, true);
  });

  it("still blocks a bash -n that redirects into a skill file", () => {
    const { cwd, markedScript } = both();
    assert.equal(bashSkillVerdict(cwd, `bash -n ${markedScript} > ${path.join(cwd, ".pi", "skills", "marked", "SKILL.md")}`)?.block, true);
  });

  it("blocks a value-taking option, which makes -n its value and -c the real work", () => {
    const { cwd, root } = both();
    const skillMd = path.join(root, "marked", "SKILL.md");
    for (const option of ["--rcfile", "--init-file", "--debugger", "--rcfile=/dev/null", "-o", "--noprofile"]) {
      const command = `bash ${option} -n -c 'echo changed > ${skillMd}'`;
      assert.equal(bashSkillVerdict(cwd, command)?.block, true, command);
    }
    assert.equal(bashSkillVerdict(cwd, `bash --debugger -n ${path.join(root, "marked", "run.sh")}`)?.block, true);
  });

  it("blocks a renamed shell binary running on a skill script", () => {
    const { cwd, markedScript } = both();
    const fake = path.join(tempDir("skill-maint-renamed-shell-"), "bash");
    fs.writeFileSync(fake, "#!/bin/sh\n", { mode: 0o755 });
    assert.equal(bashSkillVerdict(cwd, `${fake} -n ${markedScript}`)?.block, true);
  });

  it("allows a real shell binary path", () => {
    const { cwd, markedScript } = both();
    assert.equal(bashSkillVerdict(cwd, `${fs.realpathSync("/bin/sh")} -n ${markedScript}`), null);
  });

  it("blocks +n, which re-enables execution after -n", () => {
    const { cwd, markedScript, root } = both();
    assert.equal(bashSkillVerdict(cwd, `bash -n +n ${markedScript}`)?.block, true);
    assert.equal(bashSkillVerdict(cwd, `bash -n +o noexec ${markedScript}`)?.block, true);
    assert.equal(bashSkillVerdict(cwd, `bash -n +n -c 'echo changed > ${path.join(root, "marked", "SKILL.md")}'`)?.block, true);
  });

  it("blocks inline code after -n", () => {
    const { cwd, root } = both();
    const skillMd = path.join(root, "marked", "SKILL.md");
    assert.equal(bashSkillVerdict(cwd, `bash -n -c 'echo changed > ${skillMd}'`)?.block, true);
    assert.equal(bashSkillVerdict(cwd, `sh -n -c 'echo changed > ${skillMd}'`)?.block, true);
  });

  it("logs skill_shell_syntax_check_allowed for an exempted bash -n", () => {
    const { cwd, markedScript } = both();
    inTempLogHome("skill-maint-syntax-log-test", () => {
      assert.equal(bashSkillVerdict(cwd, `bash -n ${markedScript}`), null);
      const logPath = getPiLogPath("skill-maintenance");
      assert.ok(logPath);
      assert.match(fs.readFileSync(logPath, "utf-8"), /skill_shell_syntax_check_allowed/);
    });
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
  it("refuses an unmarked project skill write", async () => {
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

  it("allows a marked project skill write", async () => {
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
  });

  it("records an allowed write in provenance once the tool succeeds", async () => {
    const { cwd, root } = project();
    const marked = writeSkill(root, "marked", MARKED);
    const h = harness(cwd);
    await h.emit("turn_start", { turnIndex: 3 });
    await h.emit("tool_call", {
      toolCallId: "c2",
      toolName: "edit",
      input: { path: marked, edits: [{ oldText: "Run the query.", newText: "Run it." }] },
    });
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

  it("auto-adopts a brand-new SKILL.md lacking the marker", async () => {
    const { cwd, root } = project();
    const h = harness(cwd);
    await h.emit("turn_start", { turnIndex: 1 });
    const target = path.join(root, "pr-workflow", "SKILL.md");
    const original = `---\nname: pr-workflow\ndescription: "Open a PR"\n---\n\n# PR Workflow\n\nRun git push.\n`;
    const input = { path: target, content: original };

    const res = await h.emit("tool_call", { toolCallId: "aa1", toolName: "write", input });
    assert.equal(res, undefined);
    assert.equal(isMarkedSkill(input.content), true);
    assert.match(input.content, /IMPORTANT — keep this skill true/);
    assert.match(input.content, /name: pr-workflow/);
    assert.match(input.content, /description: "Open a PR"/);
    assert.match(input.content, /# PR Workflow\n\nRun git push\./);
  });

  it("records provenance when a brand-new unmarked SKILL.md is written", async () => {
    const { cwd, root } = project();
    const h = harness(cwd);
    await h.emit("turn_start", { turnIndex: 1 });
    const target = path.join(root, "pr-workflow", "SKILL.md");
    const original = `---\nname: pr-workflow\ndescription: "Open a PR"\n---\n\n# PR Workflow\n\nRun git push.\n`;
    const input = { path: target, content: original };

    await h.emit("tool_call", { toolCallId: "aa1", toolName: "write", input });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, input.content);
    await h.emit("tool_result", { toolCallId: "aa1", toolName: "write", input: { path: target }, isError: false });

    const [record] = provenanceRecords(cwd);
    assert.deepEqual(
      { skill: record.skill, action: record.action, file: record.file },
      { skill: "pr-workflow", action: "written", file: "SKILL.md" },
    );
  });

  it("logs skill_creation_auto_adopted when auto-adopting a brand-new SKILL.md", async () => {
    await inTempLogHome("skill-maint-auto-adopt", async () => {
      const { cwd, root } = project();
      const h = harness(cwd);
      await h.emit("turn_start", { turnIndex: 1 });
      const target = path.join(root, "pr-workflow", "SKILL.md");
      const original = `---\nname: pr-workflow\ndescription: "Open a PR"\n---\n\n# PR Workflow\n\nRun git push.\n`;
      const input = { path: target, content: original };

      await h.emit("tool_call", { toolCallId: "aa1", toolName: "write", input });

      const logPath = getPiLogPath("skill-maintenance");
      assert.ok(logPath);
      assert.match(fs.readFileSync(logPath, "utf-8"), /skill_creation_auto_adopted/);
    });
  });

  it("auto-adopts a brand-new bare SKILL.md without frontmatter", async () => {
    const { cwd, root } = project();
    const h = harness(cwd);
    await h.emit("turn_start", { turnIndex: 1 });
    const target = path.join(root, "bare", "SKILL.md");
    const input = { path: target, content: "# Bare Skill\n\nDo the thing.\n" };

    const res = await h.emit("tool_call", { toolCallId: "aa2", toolName: "write", input });
    assert.equal(res, undefined);
    assert.ok(input.content.startsWith(`---\n${MARKER_LINE}\n---\n`));
    assert.match(input.content, /IMPORTANT — keep this skill true/);
    assert.match(input.content, /# Bare Skill\n\nDo the thing\./);
  });

  it("leaves already-marked brand-new SKILL.md content unchanged", async () => {
    const { cwd, root } = project();
    const h = harness(cwd);
    await h.emit("turn_start", { turnIndex: 1 });
    const target = path.join(root, "marked", "SKILL.md");
    const input = { path: target, content: MARKED };

    const res = await h.emit("tool_call", { toolCallId: "aa3", toolName: "write", input });
    assert.equal(res, undefined);
    assert.equal(input.content, MARKED);
  });

  it("blocks overwriting an existing unmarked SKILL.md and does not mutate content", async () => {
    const { cwd, root } = project();
    const existing = writeSkill(root, "existing", UNMARKED);
    const h = harness(cwd);
    await h.emit("turn_start", { turnIndex: 1 });
    const replacement = `---\nname: existing\ndescription: "Changed"\n---\n\n# New body\n`;
    const input = { path: existing, content: replacement };

    const blocked = await h.emit("tool_call", { toolCallId: "aa4", toolName: "write", input });
    assert.equal(blocked?.block, true);
    assert.equal(input.content, replacement);
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

  it("notices a change below the depth cap", () => {
    const { cwd, root } = project();
    writeSkill(root, "searxng", MARKED);
    const deep = path.join(root, "searxng", "references", "a", "b", "c", "d", "e", "note.md");
    fs.mkdirSync(path.dirname(deep), { recursive: true });
    const owned = ownedSkillsRoot(cwd);
    const before = snapshotSkillTree(owned);
    fs.writeFileSync(deep, "# deep note\n");
    const changes = diffSkillTree(owned, before, snapshotSkillTree(owned));
    assert.deepEqual(changes, [
      { skill: "searxng", action: "patched", file: path.join("references", "a", "b", "c", "d", "e", "note.md") },
    ]);
  });

  it("logs the depth cap when a tree goes past it", () => {
    inTempLogHome("skill-maint-depth-test", home => {
      const deepRoot = path.join(home, "skills");
      const segments = Array.from({ length: 40 }, (_, i) => `d${i}`);
      fs.mkdirSync(path.join(deepRoot, ...segments), { recursive: true });
      snapshotSkillTree(deepRoot);
      const logPath = getPiLogPath("skill-maintenance");
      assert.ok(logPath);
      assert.match(fs.readFileSync(logPath, "utf-8"), /skill_snapshot_depth_cap/);
    });
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

  it("logs the unresolved tail of a path that does not exist yet", () => {
    inTempLogHome("skill-maint-realpath-test", home => {
      const missing = path.join(home, "not", "created", "yet", "SKILL.md");
      assert.equal(realpathNearestExisting(missing), missing);

      const logPath = getPiLogPath("skill-maintenance");
      assert.ok(logPath);
      const body = fs.readFileSync(logPath, "utf-8");
      assert.match(body, /realpath_missing_tail/);
      assert.match(body, /"missing":4/);
    });
  });

  it("logs an unreadable skills tree without warning for an absent one", () => {
    inTempLogHome("skill-maint-log-test", home => {
      const unreadable = path.join(home, "locked");
      // cleanups are LIFO: this unlock runs before the temp dir is removed
      cleanups.push(() => fs.chmodSync(unreadable, 0o755));
      fs.mkdirSync(unreadable, { recursive: true });
      fs.chmodSync(unreadable, 0o000);
      const missing = path.join(home, "nope", ".pi", "skills");
      assert.equal(snapshotSkillTree(missing).size, 0);
      assert.equal(snapshotSkillTree(unreadable).size, 0);
      const logPath = getPiLogPath("skill-maintenance");
      assert.ok(logPath);
      const body = fs.readFileSync(logPath, "utf-8");
      assert.match(body, /skill_snapshot_readdir_failed/);
      assert.ok(body.includes(unreadable), "the failing directory is named");
      assert.ok(!body.includes(missing), "an absent skills tree is not a warning");
    }, "warn");
  });
});
