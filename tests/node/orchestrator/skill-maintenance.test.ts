/**
 * Skill maintenance (issues #1074, #1147, #1155).
 *
 * Non-blocking skill maintenance: `/adopt-skill` marks any non-package loaded skill
 * (`skill-maintenance: auto`), brand-new `.pi/skills/<name>/SKILL.md` writes auto-adopt,
 * adopted skills steer mid-turn on failure, and edits record provenance + a one-line
 * turn summary. No `write`/`edit` or `bash` tool call is ever blocked.
 */

import { describe, it, afterEach } from "node:test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  adoptSkill,
  appendProvenance,
  completeUnmarkedSkills,
  diffSkillTree,
  formatSkillReviewNotice,
  isAdoptableSkill,
  isMarkedSkill,
  isPackageSkillPath,
  isRegisteredPackageTarget,
  listUnmarkedSkills,
  MAINTAINER_INSTRUCTION,
  MARKER_LINE,
  markedSkillsInText,
  provenancePath,
  registerSkillMaintenance,
  skillsFromCommands,
  snapshotSkillTree,
  stampSkill,
  type RegisteredSkillInfo,
} from "../../../extensions/orchestrator/skill-maintenance.js";
import { getPiLogPath, setLogLevelPin } from "../../../extensions/shared/file-logger.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

const cleanups: Array<() => void> = [];

const MARKED = `---\nname: searxng\ndescription: "Search with the local instance"\n${MARKER_LINE}\n---\n\n# SearXNG\n\nRun the query.\n`;
const UNMARKED = `---\nname: searxng\ndescription: "Search with the local instance"\n---\n\n# SearXNG\n\nRun the query.\n`;

function tempDir(prefix: string): string {
  const dir = makeTempDir(prefix);
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function project(): { cwd: string; root: string } {
  const cwd = tempDir("skill-maint-");
  const root = path.join(cwd, ".pi", "skills");
  fs.mkdirSync(root, { recursive: true });
  return { cwd, root };
}

function writeSkill(root: string, name: string, content = MARKED): string {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, "references"), { recursive: true });
  const file = path.join(dir, "SKILL.md");
  fs.writeFileSync(file, content);
  return file;
}

function makeSkillInfo(
  name: string,
  filePath: string,
  scope: RegisteredSkillInfo["scope"] = "project",
  origin: RegisteredSkillInfo["origin"] = "top-level",
): RegisteredSkillInfo {
  const abs = path.resolve(filePath);
  return { name, filePath: abs, baseDir: path.dirname(abs), scope, origin };
}

function toCommands(skills: readonly RegisteredSkillInfo[]): Array<Record<string, unknown>> {
  return skills.map((s) => ({
    name: `skill:${s.name}`,
    source: "skill",
    sourceInfo: {
      path: s.filePath,
      // Mimic Pi setting baseDir to the scope root rather than the skill directory
      baseDir: path.dirname(s.baseDir),
      scope: s.scope,
      origin: s.origin,
    },
  }));
}

function createMockPi(getCommandsImpl?: () => unknown[]) {
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const commands = new Map<string, any>();
  const messages: Array<{ msg: any; opts: any }> = [];
  const pi: any = {
    on(event: string, fn: (...args: any[]) => any) {
      const list = handlers.get(event) ?? [];
      list.push(fn);
      handlers.set(event, list);
    },
    registerCommand(name: string, def: any) {
      commands.set(name, def);
    },
    sendMessage(msg: any, opts: any) {
      messages.push({ msg, opts });
    },
  };
  if (getCommandsImpl !== undefined) {
    pi.getCommands = getCommandsImpl;
  }
  const emit = (event: string, payload: any, ctx: any) => {
    let last: any;
    for (const fn of handlers.get(event) ?? []) {
      last = fn(payload, ctx);
    }
    return last;
  };
  return { pi, handlers, commands, messages, emit };
}

function makeCtx(cwd: string, sessionId = "sess-1") {
  const notifications: Array<{ text: string; level: string }> = [];
  return {
    cwd,
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      notify: (text: string, level = "info") => notifications.push({ text, level }),
    },
    notifications,
  };
}

function inTempLogHome(sid: string, body: (home: string) => void): void {
  const realLog = path.join(os.homedir(), ".pi", "logs", "skill-maintenance", sid, "main.log");
  const stamp = () => (fs.existsSync(realLog) ? `${fs.statSync(realLog).size}:${fs.statSync(realLog).mtimeMs}` : "absent");
  const before = stamp();
  const home = tempDir(`skill-maint-log-${sid}-`);
  const savedHome = process.env.HOME;
  const savedSid = (globalThis as any).__piConfigSessionId;
  process.env.HOME = home;
  (globalThis as any).__piConfigSessionId = sid;
  setLogLevelPin("skill-maintenance", "debug");
  try {
    body(home);
  } finally {
    setLogLevelPin("skill-maintenance", null);
    if (savedSid === undefined) delete (globalThis as any).__piConfigSessionId;
    else (globalThis as any).__piConfigSessionId = savedSid;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    assert.equal(stamp(), before, `test wrote to real home log: ${realLog}`);
  }
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

// ── skillsFromCommands ──────────────────────────────────────────────────────

describe("skillsFromCommands", () => {
  it("extracts skill:* commands and derives baseDir from path.dirname(filePath)", () => {
    const skills = skillsFromCommands([
      {
        name: "skill:searxng",
        source: "skill",
        sourceInfo: {
          path: "/repo/.pi/skills/searxng/SKILL.md",
          baseDir: "/repo/.pi",
          scope: "project",
          origin: "top-level",
        },
      },
      {
        name: "skill:pkg-skill",
        source: "skill",
        sourceInfo: {
          path: "/home/u/.pi/agent/git/pkg/skills/pkg-skill/SKILL.md",
          baseDir: "/home/u/.pi/agent/git/pkg",
          scope: "user",
          origin: "package",
        },
      },
      { name: "adopt-skill", source: "extension" },
      { name: "implement", source: "prompt" },
    ]);

    assert.equal(skills.length, 2);
    assert.deepEqual(skills[0], {
      name: "searxng",
      filePath: path.resolve("/repo/.pi/skills/searxng/SKILL.md"),
      baseDir: path.resolve("/repo/.pi/skills/searxng"),
      scope: "project",
      origin: "top-level",
    });
    assert.deepEqual(skills[1], {
      name: "pkg-skill",
      filePath: path.resolve("/home/u/.pi/agent/git/pkg/skills/pkg-skill/SKILL.md"),
      baseDir: path.resolve("/home/u/.pi/agent/git/pkg/skills/pkg-skill"),
      scope: "user",
      origin: "package",
    });
  });

  it("logs and skips malformed skill entries", () => {
    inTempLogHome("malformed-cmd", () => {
      const skills = skillsFromCommands([
        { name: "not-prefixed", source: "skill", sourceInfo: { path: "/a/SKILL.md" } },
        { name: "skill:", source: "skill", sourceInfo: { path: "/b/SKILL.md" } },
        { name: "skill:missing-path", source: "skill", sourceInfo: {} },
        { name: "skill:blank-path", source: "skill", sourceInfo: { path: "   " } },
        { name: "skill:valid", source: "skill", sourceInfo: { path: "/ok/valid/SKILL.md", scope: "unknown" } },
      ]);

      assert.equal(skills.length, 1);
      assert.equal(skills[0].name, "valid");
      assert.equal(skills[0].scope, "temporary");
      assert.equal(skills[0].origin, "top-level");

      const logFile = getPiLogPath("skill-maintenance");
      assert.ok(logFile);
      const logText = fs.readFileSync(logFile, "utf-8");
      assert.match(logText, /skill_command_malformed/);
    });
  });
});

// ── isMarkedSkill & stampSkill ──────────────────────────────────────────────

describe("isMarkedSkill & stampSkill", () => {
  it("detects skill-maintenance: auto only inside frontmatter", () => {
    assert.equal(isMarkedSkill(MARKED), true);
    assert.equal(isMarkedSkill(UNMARKED), false);
    assert.equal(isMarkedSkill(`# No frontmatter\n\n${MARKER_LINE}\n`), false);
    assert.equal(isMarkedSkill(`---\nname: x\n  skill-maintenance : auto  \n---\nbody`), true);
    assert.equal(isMarkedSkill(`---\nname: x\nskill-maintenance: manual\n---\nbody`), false);
  });

  it("stamps existing frontmatter, preserves body, and is idempotent", () => {
    const first = stampSkill(UNMARKED);
    assert.equal(first.changed, true);
    assert.equal(isMarkedSkill(first.content), true);
    assert.ok(first.content.includes(MAINTAINER_INSTRUCTION));
    assert.ok(first.content.includes("# SearXNG"));
    assert.ok(first.content.includes("Run the query."));

    const second = stampSkill(first.content);
    assert.equal(second.changed, false);
    assert.equal(second.content, first.content);
  });

  it("creates frontmatter when absent", () => {
    const raw = "# Plain Skill\n\nDo the thing.\n";
    const stamped = stampSkill(raw);
    assert.equal(stamped.changed, true);
    assert.equal(isMarkedSkill(stamped.content), true);
    assert.ok(stamped.content.includes(MAINTAINER_INSTRUCTION));
    assert.ok(stamped.content.includes("# Plain Skill"));
    assert.equal(stampSkill(stamped.content).changed, false);
  });
});

// ── package exclusion, listUnmarkedSkills & completeUnmarkedSkills ──────────

describe("listUnmarkedSkills & completeUnmarkedSkills", () => {
  it("lists unmarked project, user-global, .agents/skills, and symlinked shared skills while excluding marked and package skills", () => {
    const { cwd, root } = project();
    const sharedDir = tempDir("shared-skills-");
    const globalDir = tempDir("global-skills-");
    const agentsDir = path.join(cwd, ".agents", "skills");
    const pkgGitDir = tempDir("git-pkg-skills-");
    const nmDir = path.join(tempDir("nm-pkg-"), "node_modules", "some-pkg", "skills");

    const projUnmarked = writeSkill(root, "proj-unmarked", UNMARKED);
    const projMarked = writeSkill(root, "proj-marked", MARKED);
    const globalUnmarked = writeSkill(globalDir, "global-tool", UNMARKED);
    const agentsUnmarked = writeSkill(agentsDir, "agents-tool", UNMARKED);
    const sharedTarget = writeSkill(sharedDir, "shared-tool", UNMARKED);
    fs.symlinkSync(path.dirname(sharedTarget), path.join(root, "shared-tool"));

    const pkgGitFile = writeSkill(pkgGitDir, "shipped-git", UNMARKED);
    const pkgNmFile = writeSkill(nmDir, "shipped-nm", UNMARKED);
    // Alias symlink pointing to a non-node_modules git package skill (Qodo 33de3c92)
    fs.symlinkSync(path.dirname(pkgGitFile), path.join(root, "pkg-alias"));
    // Brand-new .pi/skills dir not yet in pi.getCommands()
    writeSkill(root, "fresh-mid-session", UNMARKED);

    const skills: RegisteredSkillInfo[] = [
      makeSkillInfo("proj-unmarked", projUnmarked, "project", "top-level"),
      makeSkillInfo("proj-marked", projMarked, "project", "top-level"),
      makeSkillInfo("global-tool", globalUnmarked, "user", "top-level"),
      makeSkillInfo("agents-tool", agentsUnmarked, "project", "top-level"),
      makeSkillInfo("shared-tool", path.join(root, "shared-tool", "SKILL.md"), "project", "top-level"),
      makeSkillInfo("shipped-git", pkgGitFile, "user", "package"),
      makeSkillInfo("shipped-nm", pkgNmFile, "user", "top-level"),
      makeSkillInfo("pkg-alias", path.join(root, "pkg-alias", "SKILL.md"), "project", "top-level"),
    ];

    assert.equal(isPackageSkillPath(pkgNmFile), true);
    assert.equal(isRegisteredPackageTarget(path.join(root, "pkg-alias", "SKILL.md"), skills), true);
    assert.equal(isAdoptableSkill(skills.find((s) => s.name === "pkg-alias")!, skills), false);

    assert.deepEqual(listUnmarkedSkills(cwd, skills), [
      "agents-tool",
      "fresh-mid-session",
      "global-tool",
      "proj-unmarked",
      "shared-tool",
    ]);

    const completions = completeUnmarkedSkills(cwd, "tool", skills);
    assert.deepEqual(completions, [
      { value: "agents-tool", label: "agents-tool", description: "project — mark for maintenance" },
      { value: "global-tool", label: "global-tool", description: "user — mark for maintenance" },
      { value: "shared-tool", label: "shared-tool", description: "project — mark for maintenance" },
    ]);
  });
});

// ── adoptSkill ──────────────────────────────────────────────────────────────

describe("adoptSkill", () => {
  it("stamps project, user-global, and symlinked shared skills and is idempotent", () => {
    const { cwd, root } = project();
    const globalDir = tempDir("adopt-global-");
    const sharedDir = tempDir("adopt-shared-");

    const projFile = writeSkill(root, "local-s", UNMARKED);
    const globalFile = writeSkill(globalDir, "global-s", UNMARKED);
    const sharedFile = writeSkill(sharedDir, "shared-s", UNMARKED);
    fs.symlinkSync(path.dirname(sharedFile), path.join(root, "shared-s"));

    const skills: RegisteredSkillInfo[] = [
      makeSkillInfo("local-s", projFile, "project"),
      makeSkillInfo("global-s", globalFile, "user"),
      makeSkillInfo("shared-s", path.join(root, "shared-s", "SKILL.md"), "project"),
    ];

    for (const [name, file] of [
      ["local-s", projFile],
      ["global-s", globalFile],
      ["shared-s", sharedFile],
    ] as const) {
      const first = adoptSkill(cwd, name, skills);
      assert.equal(first.ok, true, first.message);
      const written = fs.readFileSync(file, "utf-8");
      assert.equal(isMarkedSkill(written), true);
      assert.ok(written.includes(MAINTAINER_INSTRUCTION));

      const second = adoptSkill(cwd, name, skills);
      assert.equal(second.ok, true);
      assert.match(second.message, /already maintained/i);
    }
  });

  it("refuses shipped package skills, alias symlinks to git package skills, path traversal, and missing skills", () => {
    const { cwd, root } = project();
    const pkgGitDir = tempDir("adopt-git-pkg-");
    const nmDir = path.join(tempDir("adopt-nm-pkg-"), "node_modules", "pkg", "skills");

    const pkgGitFile = writeSkill(pkgGitDir, "git-pkg-skill", UNMARKED);
    const pkgNmFile = writeSkill(nmDir, "nm-pkg-skill", UNMARKED);
    fs.symlinkSync(path.dirname(pkgGitFile), path.join(root, "git-pkg-alias"));
    fs.symlinkSync(path.dirname(pkgNmFile), path.join(root, "nm-pkg-alias"));

    const skills: RegisteredSkillInfo[] = [
      makeSkillInfo("git-pkg-skill", pkgGitFile, "user", "package"),
      makeSkillInfo("nm-pkg-skill", pkgNmFile, "user", "top-level"),
      makeSkillInfo("git-pkg-alias", path.join(root, "git-pkg-alias", "SKILL.md"), "project", "top-level"),
    ];

    assert.equal(adoptSkill(cwd, "git-pkg-skill", skills).ok, false);
    assert.equal(adoptSkill(cwd, "nm-pkg-skill", skills).ok, false);
    assert.equal(adoptSkill(cwd, "git-pkg-alias", skills).ok, false);
    // Fallback alias (not in `skills`, resolved via .pi/skills/) also refused
    assert.equal(adoptSkill(cwd, "nm-pkg-alias", skills).ok, false);
    assert.equal(adoptSkill(cwd, "../escape", skills).ok, false);
    assert.equal(adoptSkill(cwd, "a/b", skills).ok, false);
    assert.equal(adoptSkill(cwd, "", skills).ok, false);
    assert.equal(adoptSkill(cwd, "does-not-exist", skills).ok, false);

    // None of the package files were modified
    assert.equal(isMarkedSkill(fs.readFileSync(pkgGitFile, "utf-8")), false);
    assert.equal(isMarkedSkill(fs.readFileSync(pkgNmFile, "utf-8")), false);
  });
});

// ── markedSkillsInText ──────────────────────────────────────────────────────

describe("markedSkillsInText", () => {
  it("recognizes /skill:<name> only for adopted non-package skills", () => {
    const { cwd, root } = project();
    const markedFile = writeSkill(root, "adopted-s", MARKED);
    const unmarkedFile = writeSkill(root, "plain-s", UNMARKED);
    const pkgDir = tempDir("marked-pkg-");
    const pkgFile = writeSkill(pkgDir, "pkg-s", MARKED);

    const skills = [
      makeSkillInfo("adopted-s", markedFile, "project", "top-level"),
      makeSkillInfo("plain-s", unmarkedFile, "project", "top-level"),
      makeSkillInfo("pkg-s", pkgFile, "user", "package"),
    ];

    assert.deepEqual(
      markedSkillsInText(cwd, "Run /skill:adopted-s and /skill:plain-s and /skill:pkg-s", skills),
      ["adopted-s"],
    );
  });
});

// ── registerSkillMaintenance (non-blocking) ─────────────────────────────────

describe("registerSkillMaintenance", () => {
  it("never blocks write/edit on unmarked skills across project, global, .agents, and symlinked shared scopes", () => {
    const { cwd, root } = project();
    const globalDir = tempDir("nb-global-");
    const sharedDir = tempDir("nb-shared-");
    const agentsDir = path.join(cwd, ".agents", "skills");

    const projFile = writeSkill(root, "proj-u", UNMARKED);
    const globalFile = writeSkill(globalDir, "global-u", UNMARKED);
    const agentsFile = writeSkill(agentsDir, "agents-u", UNMARKED);
    const sharedFile = writeSkill(sharedDir, "shared-u", UNMARKED);
    fs.symlinkSync(path.dirname(sharedFile), path.join(root, "shared-u"));

    const skills = [
      makeSkillInfo("proj-u", projFile, "project"),
      makeSkillInfo("global-u", globalFile, "user"),
      makeSkillInfo("agents-u", agentsFile, "project"),
      makeSkillInfo("shared-u", path.join(root, "shared-u", "SKILL.md"), "project"),
    ];

    const { pi, emit } = createMockPi(() => toCommands(skills));
    registerSkillMaintenance(pi);
    const ctx = makeCtx(cwd);

    for (const filePath of [projFile, globalFile, agentsFile, path.join(root, "shared-u", "SKILL.md"), sharedFile]) {
      assert.equal(
        emit("tool_call", { toolName: "write", toolCallId: `w-${filePath}`, input: { path: filePath, content: UNMARKED } }, ctx),
        undefined,
      );
      assert.equal(
        emit("tool_call", { toolName: "edit", toolCallId: `e-${filePath}`, input: { path: filePath, oldText: "Run", newText: "Exec" } }, ctx),
        undefined,
      );
    }
  });

  it("never blocks bash commands touching skills (scripts, writes, cd, heredocs)", () => {
    const { cwd, root } = project();
    const file = writeSkill(root, "unmarked-s", UNMARKED);
    const skills = [makeSkillInfo("unmarked-s", file, "project")];

    const { pi, emit } = createMockPi(() => toCommands(skills));
    registerSkillMaintenance(pi);
    const ctx = makeCtx(cwd);

    const commands = [
      `echo "hi" >> ${file}`,
      `sed -i 's/a/b/' .pi/skills/unmarked-s/SKILL.md`,
      `cd .pi/skills/unmarked-s && cat SKILL.md > out.txt`,
      `cat <<'EOF' > .pi/skills/unmarked-s/SKILL.md\nhello\nEOF`,
      `bash .pi/skills/unmarked-s/scripts/run.sh`,
    ];
    for (const command of commands) {
      assert.equal(
        emit("tool_call", { toolName: "bash", toolCallId: "b1", input: { command } }, ctx),
        undefined,
      );
    }
  });

  it("auto-stamps brand-new .pi/skills/<name>/SKILL.md in main checkout and linked worktree, leaving already-marked untouched", () => {
    const mainRepo = tempDir("wt-main-");
    execFileSync("git", ["init", "-q"], { cwd: mainRepo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: mainRepo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: mainRepo });
    fs.writeFileSync(path.join(mainRepo, "README.md"), "# repo\n");
    execFileSync("git", ["add", "README.md"], { cwd: mainRepo });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: mainRepo });

    const wtDir = path.join(tempDir("wt-linked-parent-"), "wt");
    execFileSync("git", ["worktree", "add", "-q", "-b", "feat", wtDir], { cwd: mainRepo });

    const { pi, emit } = createMockPi(() => []);
    registerSkillMaintenance(pi);

    // 1. Main checkout brand-new unmarked write -> auto-stamped
    const mainInput = { path: ".pi/skills/new-main/SKILL.md", content: UNMARKED };
    assert.equal(emit("tool_call", { toolName: "write", toolCallId: "c1", input: mainInput }, makeCtx(mainRepo)), undefined);
    assert.equal(isMarkedSkill(mainInput.content), true);
    assert.ok(mainInput.content.includes(MAINTAINER_INSTRUCTION));

    // 2. Linked worktree brand-new unmarked write -> auto-stamped
    const wtInput = { path: ".pi/skills/new-wt/SKILL.md", content: UNMARKED };
    assert.equal(emit("tool_call", { toolName: "write", toolCallId: "c2", input: wtInput }, makeCtx(wtDir)), undefined);
    assert.equal(isMarkedSkill(wtInput.content), true);
    assert.ok(wtInput.content.includes(MAINTAINER_INSTRUCTION));

    // 3. Brand-new ALREADY-marked write -> left untouched
    const markedInput = { path: ".pi/skills/already-marked/SKILL.md", content: MARKED };
    assert.equal(emit("tool_call", { toolName: "write", toolCallId: "c3", input: markedInput }, makeCtx(wtDir)), undefined);
    assert.equal(markedInput.content, MARKED);
  });

  it("fires mid-turn steer nudge on error when an adopted skill was used (via /skill: or read) and never for unmarked skills", () => {
    const { cwd, root } = project();
    const globalDir = tempDir("nudge-global-");
    const sharedDir = tempDir("nudge-shared-");

    const projAdopted = writeSkill(root, "proj-adopted", MARKED);
    const projUnmarked = writeSkill(root, "proj-unmarked", UNMARKED);
    const globalAdopted = writeSkill(globalDir, "global-adopted", MARKED);
    const sharedAdopted = writeSkill(sharedDir, "shared-adopted", MARKED);
    fs.symlinkSync(path.dirname(sharedAdopted), path.join(root, "shared-adopted"));

    const skills = [
      makeSkillInfo("proj-adopted", projAdopted, "project"),
      makeSkillInfo("proj-unmarked", projUnmarked, "project"),
      makeSkillInfo("global-adopted", globalAdopted, "user"),
      makeSkillInfo("shared-adopted", path.join(root, "shared-adopted", "SKILL.md"), "project"),
    ];

    const { pi, messages, emit } = createMockPi(() => toCommands(skills));
    registerSkillMaintenance(pi);
    const ctx = makeCtx(cwd);

    // Turn 1: /skill:proj-adopted invoked before turn_start -> error triggers exactly one steer nudge
    emit("input", { text: "Please run /skill:proj-adopted" }, ctx);
    emit("turn_start", { turnIndex: 1 }, ctx);
    emit("tool_result", { toolCallId: "r1", input: { command: "false" }, isError: true }, ctx);
    emit("tool_result", { toolCallId: "r2", input: { command: "false" }, isError: true }, ctx);
    const nudges1 = messages.filter((m) => m.msg.customType === "skill-maintenance-nudge");
    assert.equal(nudges1.length, 1);
    assert.match(nudges1[0].msg.content, /proj-adopted/);
    assert.equal(nudges1[0].opts.deliverAs, "steer");
    emit("turn_end", {}, ctx);

    // Turn 2: reading user-global adopted skill + symlinked shared adopted skill -> both nudged on error
    messages.length = 0;
    emit("turn_start", { turnIndex: 2 }, ctx);
    emit("tool_result", { toolCallId: "r3", input: { path: globalAdopted }, isError: false }, ctx);
    emit("tool_result", { toolCallId: "r4", input: { path: path.join(root, "shared-adopted", "SKILL.md") }, isError: false }, ctx);
    emit("tool_result", { toolCallId: "r5", input: { command: "exit 1" }, isError: true }, ctx);
    const nudges2 = messages.filter((m) => m.msg.customType === "skill-maintenance-nudge");
    assert.equal(nudges2.length, 2);
    assert.ok(nudges2.some((m) => m.msg.content.includes("global-adopted")));
    assert.ok(nudges2.some((m) => m.msg.content.includes("shared-adopted")));
    emit("turn_end", {}, ctx);

    // Turn 3: unmarked skill used (via /skill: AND read) -> NEVER nudges on error
    messages.length = 0;
    emit("input", { text: "Run /skill:proj-unmarked" }, ctx);
    emit("turn_start", { turnIndex: 3 }, ctx);
    emit("tool_result", { toolCallId: "r6", input: { path: projUnmarked }, isError: false }, ctx);
    emit("tool_result", { toolCallId: "r7", input: { command: "exit 1" }, isError: true }, ctx);
    assert.equal(messages.filter((m) => m.msg.customType === "skill-maintenance-nudge").length, 0);
    emit("turn_end", {}, ctx);
  });

  it("records provenance and emits turn-end and turn-start notices across project, global, and symlinked scopes", () => {
    const { cwd, root } = project();
    const globalDir = tempDir("prov-global-");
    const sharedDir = tempDir("prov-shared-");

    const projFile = writeSkill(root, "proj-s", MARKED);
    const globalFile = writeSkill(globalDir, "global-s", MARKED);
    const sharedFile = writeSkill(sharedDir, "shared-s", MARKED);
    fs.symlinkSync(path.dirname(sharedFile), path.join(root, "shared-s"));

    const skills = [
      makeSkillInfo("proj-s", projFile, "project"),
      makeSkillInfo("global-s", globalFile, "user"),
      makeSkillInfo("shared-s", path.join(root, "shared-s", "SKILL.md"), "project"),
    ];

    const { pi, messages, emit } = createMockPi(() => toCommands(skills));
    registerSkillMaintenance(pi);
    const ctx = makeCtx(cwd, "sess-prov");

    emit("session_start", {}, ctx);
    emit("turn_start", { turnIndex: 1 }, ctx);

    // Edit project + global skills
    emit("tool_call", { toolName: "edit", toolCallId: "t1", input: { path: projFile } }, ctx);
    emit("tool_result", { toolCallId: "t1", input: { path: projFile }, isError: false }, ctx);
    emit("tool_call", { toolName: "edit", toolCallId: "t2", input: { path: globalFile } }, ctx);
    emit("tool_result", { toolCallId: "t2", input: { path: globalFile }, isError: false }, ctx);

    // Failed edit must NOT be recorded
    emit("tool_call", { toolName: "edit", toolCallId: "t-fail", input: { path: sharedFile } }, ctx);
    emit("tool_result", { toolCallId: "t-fail", input: { path: sharedFile }, isError: true }, ctx);

    emit("turn_end", {}, ctx);

    const review1 = messages.filter((m) => m.msg.customType === "skill-maintenance");
    assert.equal(review1.length, 1);
    assert.match(review1[0].msg.content, /📙 Self-improvement review:/);
    assert.match(review1[0].msg.content, /Skill 'global-s' patched/);
    assert.match(review1[0].msg.content, /Skill 'proj-s' patched/);
    assert.doesNotMatch(review1[0].msg.content, /shared-s/);

    // Verify provenance JSONL
    const provFile = provenancePath(cwd);
    const records = fs.readFileSync(provFile, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(records.length, 2);
    assert.equal(records[0].skill, "proj-s");
    assert.equal(records[0].action, "patched");
    assert.equal(records[0].sessionId, "sess-prov");
    assert.equal(records[1].skill, "global-s");

    // Aborted turn (no turn_end): edit symlinked shared skill -> reconciled at next turn_start!
    messages.length = 0;
    emit("turn_start", { turnIndex: 2 }, ctx);
    const newRef = path.join(root, "shared-s", "references", "guide.md");
    emit("tool_call", { toolName: "write", toolCallId: "t3", input: { path: newRef, content: "# Guide\n" } }, ctx);
    emit("tool_result", { toolCallId: "t3", input: { path: newRef }, isError: false }, ctx);
    // Simulate abort: jump straight to turn_start 3
    emit("turn_start", { turnIndex: 3 }, ctx);

    const review2 = messages.filter((m) => m.msg.customType === "skill-maintenance");
    assert.equal(review2.length, 1);
    assert.match(review2[0].msg.content, /Skill 'shared-s' written \(references\/guide\.md\)/);
  });

  it("fails open cleanly when pi.getCommands() throws or is absent", async () => {
    const { cwd, root } = project();
    writeSkill(root, "fallback-s", UNMARKED);
    const ctx = makeCtx(cwd);

    for (const impl of [undefined, () => { throw new Error("boom"); }]) {
      const { pi, commands, emit } = createMockPi(impl);
      registerSkillMaintenance(pi);

      assert.doesNotThrow(() => emit("session_start", {}, ctx));
      assert.doesNotThrow(() => emit("turn_start", { turnIndex: 1 }, ctx));
      assert.doesNotThrow(() => emit("input", { text: "/skill:fallback-s" }, ctx));
      assert.equal(
        emit("tool_call", { toolName: "write", toolCallId: "w1", input: { path: ".pi/skills/fallback-s/SKILL.md", content: UNMARKED } }, ctx),
        undefined,
      );
      assert.doesNotThrow(() =>
        emit("tool_result", { toolCallId: "w1", input: { path: ".pi/skills/fallback-s/SKILL.md" }, isError: false }, ctx),
      );
      assert.doesNotThrow(() => emit("turn_end", {}, ctx));

      // /adopt-skill autocomplete still finds fallback .pi/skills/
      const adoptCmd = commands.get("adopt-skill");
      assert.ok(adoptCmd);
      const items = adoptCmd.getArgumentCompletions("fall");
      assert.equal(items.length, 1);
      assert.equal(items[0].value, "fallback-s");
    }
  });
});

// ── snapshot / diff / format / provenance helpers ───────────────────────────

describe("snapshotSkillTree, diffSkillTree, formatSkillReviewNotice & appendProvenance", () => {
  it("diffs added and modified files and formats one-line notices", () => {
    const { cwd, root } = project();
    const existing = writeSkill(root, "alpha", MARKED);
    const before = snapshotSkillTree(root);

    fs.writeFileSync(existing, `${MARKED}\nextra line\n`);
    writeSkill(root, "beta", MARKED);
    const after = snapshotSkillTree(root);

    const changes = diffSkillTree(root, before, after);
    assert.deepEqual(changes, [
      { skill: "alpha", action: "patched", file: "SKILL.md" },
      { skill: "beta", action: "written", file: "SKILL.md" },
    ]);

    assert.equal(formatSkillReviewNotice([]), "");
    assert.equal(
      formatSkillReviewNotice(changes),
      "📙 Self-improvement review: Skill 'alpha' patched · Skill 'beta' written (SKILL.md)",
    );
    assert.match(formatSkillReviewNotice(changes, true), /provenance write failed/);

    assert.equal(
      appendProvenance(cwd, [
        { skill: "alpha", action: "patched", file: "SKILL.md", sessionId: "s1", turnId: "s1:1", at: "2026-01-01T00:00:00.000Z" },
      ]),
      true,
    );
    assert.ok(fs.existsSync(provenancePath(cwd)));
  });
});
