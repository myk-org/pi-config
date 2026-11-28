import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  buildPodmanRunArgs,
  prepareSandboxAgentDir,
  prepareSandboxWorkspace,
  resolveHostPackageInstallPath,
  resolveProjectPiSourceRoots,
  syncHostTreeDereferenced,
  syncProjectPiResources,
} from "../../../scripts/podman-peer-image.mjs";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeSilentLogger() {
  const events: Array<{ level: string; event: unknown; meta: unknown }> = [];
  return {
    events,
    logger: {
      debug: (event: unknown, meta?: unknown) => events.push({ level: "debug", event, meta }),
      info: (event: unknown, meta?: unknown) => events.push({ level: "info", event, meta }),
      warn: (event: unknown, meta?: unknown) => events.push({ level: "warn", event, meta }),
      error: (event: unknown, meta?: unknown) => events.push({ level: "error", event, meta }),
      isDebugEnabled: () => true,
    },
  };
}

function initTempGitRepo(dir: string, filename = "README.md", content = "init\n"): string {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, filename), content);
  execFileSync("git", ["add", filename], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("syncHostTreeDereferenced", () => {
  it("copies nested files with symlinks dereferenced into regular files", () => {
    const externalDir = makeTempDir("pi-ext-skill-");
    fs.writeFileSync(path.join(externalDir, "SKILL.md"), "# External Skill\n");
    const srcDir = makeTempDir("pi-src-skills-");
    fs.symlinkSync(externalDir, path.join(srcDir, "pr-workflow"));
    const dstDir = path.join(makeTempDir("pi-dst-skills-"), "snapshot");
    const { logger } = makeSilentLogger();

    const res = syncHostTreeDereferenced(srcDir, dstDir, { logger });

    assert.equal(res.synced, true);
    assert.equal(res.copiedFiles, 1);
    const copiedSkill = path.join(dstDir, "pr-workflow", "SKILL.md");
    assert.equal(fs.lstatSync(path.join(dstDir, "pr-workflow")).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(copiedSkill, "utf8"), "# External Skill\n");
  });

  it("skips .git metadata directories during copy", () => {
    const srcDir = makeTempDir("pi-src-git-");
    fs.mkdirSync(path.join(srcDir, ".git", "objects"), { recursive: true });
    fs.writeFileSync(path.join(srcDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(srcDir, "index.ts"), "export const ok = true;\n");
    const dstDir = path.join(makeTempDir("pi-dst-git-"), "snapshot");
    const { logger } = makeSilentLogger();

    syncHostTreeDereferenced(srcDir, dstDir, { logger });

    assert.equal(fs.existsSync(path.join(dstDir, ".git")), false);
    assert.equal(fs.existsSync(path.join(dstDir, "index.ts")), true);
  });

  it("survives broken symlinks while copying valid siblings", () => {
    const srcDir = makeTempDir("pi-src-broken-");
    fs.symlinkSync("/nonexistent/missing-skill-target", path.join(srcDir, "broken-link"));
    fs.writeFileSync(path.join(srcDir, "good.md"), "ok\n");
    const dstDir = path.join(makeTempDir("pi-dst-broken-"), "snapshot");
    const { logger, events } = makeSilentLogger();

    const res = syncHostTreeDereferenced(srcDir, dstDir, { logger });

    assert.equal(res.synced, true);
    assert.equal(res.copiedFiles, 1);
    assert.equal(res.skipped, 1);
    assert.equal(fs.readFileSync(path.join(dstDir, "good.md"), "utf8"), "ok\n");
    assert.equal(fs.existsSync(path.join(dstDir, "broken-link")), false);
    assert.ok(events.some((e) => e.level === "warn" && e.event === "sandbox_host_tree_entry_skipped"));
  });

  it("terminates safely on direct symlink loops", () => {
    const srcDir = makeTempDir("pi-src-loop-");
    fs.writeFileSync(path.join(srcDir, "SKILL.md"), "loop-test\n");
    fs.symlinkSync(srcDir, path.join(srcDir, "self-loop"));
    const dstDir = path.join(makeTempDir("pi-dst-loop-"), "snapshot");
    const { logger, events } = makeSilentLogger();

    const res = syncHostTreeDereferenced(srcDir, dstDir, { logger });

    assert.equal(res.synced, true);
    assert.equal(res.copiedFiles, 1);
    assert.equal(res.skipped, 1);
    assert.ok(events.some((e) => e.level === "warn" && e.event === "sandbox_host_tree_symlink_loop"));
  });

  it("terminates safely on mutual directory symlink cycles", () => {
    const srcDir = makeTempDir("pi-src-mutual-");
    fs.mkdirSync(path.join(srcDir, "dir-a"));
    fs.mkdirSync(path.join(srcDir, "dir-b"));
    fs.writeFileSync(path.join(srcDir, "dir-a", "a.txt"), "a");
    fs.writeFileSync(path.join(srcDir, "dir-b", "b.txt"), "b");
    fs.symlinkSync(path.join(srcDir, "dir-b"), path.join(srcDir, "dir-a", "to-b"));
    fs.symlinkSync(path.join(srcDir, "dir-a"), path.join(srcDir, "dir-b", "to-a"));
    const dstDir = path.join(makeTempDir("pi-dst-mutual-"), "snapshot");
    const { logger, events } = makeSilentLogger();

    const res = syncHostTreeDereferenced(srcDir, dstDir, { logger });

    assert.equal(res.synced, true);
    assert.ok(res.skipped >= 2);
    assert.ok(events.some((e) => e.level === "warn" && e.event === "sandbox_host_tree_symlink_loop"));
  });

  it("copies shared non-cyclic symlink targets into multiple siblings", () => {
    const sharedDir = makeTempDir("pi-shared-ref-");
    fs.writeFileSync(path.join(sharedDir, "ref.txt"), "shared-data");
    const srcDir = makeTempDir("pi-src-dag-");
    fs.mkdirSync(path.join(srcDir, "skill-one"));
    fs.mkdirSync(path.join(srcDir, "skill-two"));
    fs.symlinkSync(sharedDir, path.join(srcDir, "skill-one", "refs"));
    fs.symlinkSync(sharedDir, path.join(srcDir, "skill-two", "refs"));
    const dstDir = path.join(makeTempDir("pi-dst-dag-"), "snapshot");
    const { logger } = makeSilentLogger();

    const res = syncHostTreeDereferenced(srcDir, dstDir, { logger });

    assert.equal(res.synced, true);
    assert.equal(res.copiedFiles, 2);
    assert.equal(fs.readFileSync(path.join(dstDir, "skill-one", "refs", "ref.txt"), "utf8"), "shared-data");
    assert.equal(fs.readFileSync(path.join(dstDir, "skill-two", "refs", "ref.txt"), "utf8"), "shared-data");
  });

  it("returns synced false without throwing when optional host directory is absent", () => {
    const missing = path.join(makeTempDir("pi-missing-"), "does-not-exist");
    const dstDir = path.join(makeTempDir("pi-dst-missing-"), "stale-snapshot");
    fs.mkdirSync(dstDir, { recursive: true });
    fs.writeFileSync(path.join(dstDir, "old.md"), "stale");
    const { logger } = makeSilentLogger();

    const res = syncHostTreeDereferenced(missing, dstDir, { logger });

    assert.equal(res.synced, false);
    assert.equal(fs.existsSync(dstDir), false);
  });
});

describe("Project .pi/{skills,agents,prompts} staging", () => {
  it("resolves main repository root before linked worktree root", () => {
    const mainRepo = makeTempDir("pi-main-repo-");
    const wtRoot = path.join(makeTempDir("pi-wt-parent-"), "feature-wt");
    initTempGitRepo(mainRepo);
    execFileSync("git", ["worktree", "add", "-b", "feat-wt", wtRoot], { cwd: mainRepo, stdio: "ignore" });

    const roots = resolveProjectPiSourceRoots(wtRoot);

    assert.equal(roots.length, 2);
    assert.equal(fs.realpathSync(roots[0]), fs.realpathSync(mainRepo));
    assert.equal(fs.realpathSync(roots[1]), fs.realpathSync(wtRoot));
  });

  it("dereferences symlinked project .pi/{skills,agents,prompts} into sandbox workspace", () => {
    const repo = makeTempDir("pi-proj-repo-");
    const externalSkill = makeTempDir("pi-ext-proj-skill-");
    const externalPromptDir = makeTempDir("pi-ext-proj-prompt-");
    fs.writeFileSync(path.join(externalSkill, "SKILL.md"), "# Symlinked Project Skill\n");
    fs.writeFileSync(path.join(externalPromptDir, "deploy.md"), "Deploy steps\n");
    initTempGitRepo(repo);

    fs.mkdirSync(path.join(repo, ".pi", "skills", "local-skill"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".pi", "skills", "local-skill", "SKILL.md"), "# Local Skill\n");
    fs.symlinkSync(externalSkill, path.join(repo, ".pi", "skills", "pr-workflow"));

    fs.mkdirSync(path.join(repo, ".pi", "agents"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".pi", "agents", "custom-agent.md"), "---\nname: custom-agent\n---\n");

    fs.mkdirSync(path.join(repo, ".pi", "prompts"), { recursive: true });
    fs.symlinkSync(path.join(externalPromptDir, "deploy.md"), path.join(repo, ".pi", "prompts", "deploy.md"));

    const sandboxDir = makeTempDir("pi-sb-proj-");
    const { logger } = makeSilentLogger();
    const { workspaceDir } = prepareSandboxWorkspace({
      sandboxDir,
      sourceCwd: repo,
      project: "proj",
      cname: "w1",
      logger,
    });

    assert.equal(
      fs.readFileSync(path.join(workspaceDir, ".pi", "skills", "local-skill", "SKILL.md"), "utf8"),
      "# Local Skill\n",
    );
    assert.equal(
      fs.lstatSync(path.join(workspaceDir, ".pi", "skills", "pr-workflow")).isSymbolicLink(),
      false,
    );
    assert.equal(
      fs.readFileSync(path.join(workspaceDir, ".pi", "skills", "pr-workflow", "SKILL.md"), "utf8"),
      "# Symlinked Project Skill\n",
    );
    assert.equal(
      fs.readFileSync(path.join(workspaceDir, ".pi", "agents", "custom-agent.md"), "utf8"),
      "---\nname: custom-agent\n---\n",
    );
    assert.equal(
      fs.readFileSync(path.join(workspaceDir, ".pi", "prompts", "deploy.md"), "utf8"),
      "Deploy steps\n",
    );
  });

  it("keeps git status clean after staging untracked project .pi resources", () => {
    const repo = makeTempDir("pi-proj-clean-");
    initTempGitRepo(repo);
    fs.mkdirSync(path.join(repo, ".pi", "skills", "verify"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".pi", "skills", "verify", "SKILL.md"), "# Verify\n");
    fs.mkdirSync(path.join(repo, ".pi", "prompts"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".pi", "prompts", "check.md"), "Check\n");

    const sandboxDir = makeTempDir("pi-sb-clean-");
    const { logger } = makeSilentLogger();
    const { workspaceDir } = prepareSandboxWorkspace({
      sandboxDir,
      sourceCwd: repo,
      project: "proj",
      cname: "w1",
      logger,
    });

    const porcelain = execFileSync("git", ["status", "--porcelain"], {
      cwd: workspaceDir,
      encoding: "utf8",
    }).trim();
    assert.equal(porcelain, "");
  });

  it("overlays linked worktree .pi resources over main repository root resources", () => {
    const mainRepo = makeTempDir("pi-main-overlay-");
    const wtRoot = path.join(makeTempDir("pi-wt-overlay-"), "wt-branch");
    initTempGitRepo(mainRepo);
    execFileSync("git", ["worktree", "add", "-b", "wt-branch", wtRoot], { cwd: mainRepo, stdio: "ignore" });

    fs.mkdirSync(path.join(mainRepo, ".pi", "skills", "main-only"), { recursive: true });
    fs.writeFileSync(path.join(mainRepo, ".pi", "skills", "main-only", "SKILL.md"), "from-main");
    fs.mkdirSync(path.join(mainRepo, ".pi", "skills", "shared"), { recursive: true });
    fs.writeFileSync(path.join(mainRepo, ".pi", "skills", "shared", "SKILL.md"), "main-version");
    fs.mkdirSync(path.join(mainRepo, ".pi", "agents"), { recursive: true });
    fs.writeFileSync(path.join(mainRepo, ".pi", "agents", "main-agent.md"), "main-agent");
    fs.mkdirSync(path.join(mainRepo, ".pi", "prompts"), { recursive: true });
    fs.writeFileSync(path.join(mainRepo, ".pi", "prompts", "shared-cmd.md"), "main-prompt");

    fs.mkdirSync(path.join(wtRoot, ".pi", "skills", "shared"), { recursive: true });
    fs.writeFileSync(path.join(wtRoot, ".pi", "skills", "shared", "SKILL.md"), "worktree-override");
    fs.mkdirSync(path.join(wtRoot, ".pi", "prompts"), { recursive: true });
    fs.writeFileSync(path.join(wtRoot, ".pi", "prompts", "shared-cmd.md"), "worktree-prompt");

    const sandboxDir = makeTempDir("pi-sb-wt-");
    const { logger } = makeSilentLogger();
    const { workspaceDir } = prepareSandboxWorkspace({
      sandboxDir,
      sourceCwd: wtRoot,
      project: "proj",
      cname: "w1",
      logger,
    });

    assert.equal(fs.readFileSync(path.join(workspaceDir, ".pi", "skills", "main-only", "SKILL.md"), "utf8"), "from-main");
    assert.equal(fs.readFileSync(path.join(workspaceDir, ".pi", "skills", "shared", "SKILL.md"), "utf8"), "worktree-override");
    assert.equal(fs.readFileSync(path.join(workspaceDir, ".pi", "agents", "main-agent.md"), "utf8"), "main-agent");
    assert.equal(fs.readFileSync(path.join(workspaceDir, ".pi", "prompts", "shared-cmd.md"), "utf8"), "worktree-prompt");
  });

  it("refreshes project .pi skills when reusing an existing sandbox workspace", () => {
    const repo = makeTempDir("pi-proj-refresh-");
    initTempGitRepo(repo);
    fs.mkdirSync(path.join(repo, ".pi", "skills", "s1"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".pi", "skills", "s1", "SKILL.md"), "v1");

    const sandboxDir = makeTempDir("pi-sb-refresh-");
    const { logger } = makeSilentLogger();
    const first = prepareSandboxWorkspace({ sandboxDir, sourceCwd: repo, project: "proj", cname: "w1", logger });
    assert.equal(fs.readFileSync(path.join(first.workspaceDir, ".pi", "skills", "s1", "SKILL.md"), "utf8"), "v1");

    fs.writeFileSync(path.join(repo, ".pi", "skills", "s1", "SKILL.md"), "v2");
    fs.mkdirSync(path.join(repo, ".pi", "skills", "s2"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".pi", "skills", "s2", "SKILL.md"), "new-skill");

    const second = prepareSandboxWorkspace({ sandboxDir, sourceCwd: repo, project: "proj", cname: "w1", logger });
    assert.equal(second.cloned, false);
    assert.equal(fs.readFileSync(path.join(second.workspaceDir, ".pi", "skills", "s1", "SKILL.md"), "utf8"), "v2");
    assert.equal(fs.readFileSync(path.join(second.workspaceDir, ".pi", "skills", "s2", "SKILL.md"), "utf8"), "new-skill");
  });

  it("avoids spurious workspace backups on HEAD advance when only staged .pi resources exist", () => {
    const repo = makeTempDir("pi-proj-nobak-");
    initTempGitRepo(repo, "file.txt", "v1\n");
    fs.mkdirSync(path.join(repo, ".pi", "skills", "s1"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".pi", "skills", "s1", "SKILL.md"), "v1");

    const sandboxDir = makeTempDir("pi-sb-nobak-");
    const { logger } = makeSilentLogger();
    prepareSandboxWorkspace({ sandboxDir, sourceCwd: repo, project: "proj", cname: "w1", logger });

    fs.writeFileSync(path.join(repo, "file.txt"), "v2\n");
    execFileSync("git", ["add", "file.txt"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "v2"], { cwd: repo, stdio: "ignore" });

    const second = prepareSandboxWorkspace({ sandboxDir, sourceCwd: repo, project: "proj", cname: "w1", logger });
    assert.equal(second.cloned, true);
    assert.equal(second.backupPath, null);
  });

  it("removes stale untracked project .pi/prompts when deleted on host", () => {
    const repo = makeTempDir("pi-proj-del-");
    initTempGitRepo(repo);
    fs.mkdirSync(path.join(repo, ".pi", "prompts"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".pi", "prompts", "old.md"), "old");

    const sandboxDir = makeTempDir("pi-sb-del-");
    const { logger } = makeSilentLogger();
    const { workspaceDir } = prepareSandboxWorkspace({ sandboxDir, sourceCwd: repo, project: "proj", cname: "w1", logger });
    assert.equal(fs.existsSync(path.join(workspaceDir, ".pi", "prompts", "old.md")), true);

    fs.rmSync(path.join(repo, ".pi", "prompts"), { recursive: true, force: true });
    syncProjectPiResources({ sandboxDir, workspaceDir, sourceCwd: repo, logger });
    assert.equal(fs.existsSync(path.join(workspaceDir, ".pi", "prompts")), false);
  });
});

describe("Host settings.json package resolution", () => {
  it("resolves git package specs to hostAgentDir/git/<host>/<owner>/<repo>", () => {
    const res = resolveHostPackageInstallPath("git:github.com/DietrichGebert/ponytail@main", {
      hostAgentDir: "/host/.pi/agent",
      homeDir: "/host",
    });
    assert.equal(res?.kind, "git");
    assert.equal(res?.bundled, false);
    assert.equal(res?.hostPath, path.resolve("/host/.pi/agent/git/github.com/DietrichGebert/ponytail"));
  });

  it("resolves scoped npm package specs to hostAgentDir/npm/node_modules", () => {
    const res = resolveHostPackageInstallPath("npm:@acme/my-ext@1.2.3", {
      hostAgentDir: "/host/.pi/agent",
      homeDir: "/host",
    });
    assert.equal(res?.kind, "npm");
    assert.equal(res?.bundled, false);
    assert.equal(res?.hostPath, path.resolve("/host/.pi/agent/npm/node_modules/@acme/my-ext"));
  });

  it("marks bundled pi-config packages as bundled", () => {
    for (const spec of [
      "npm:pi-orchestrator-config",
      "npm:pi-orchestrator-config@6.2.0",
      "npm:@myk-org/pi-vertex-claude@1.0.0",
      "npm:pi-web-access",
    ]) {
      const res = resolveHostPackageInstallPath(spec, { hostAgentDir: "/host/.pi/agent", homeDir: "/host" });
      assert.equal(res?.bundled, true, `expected ${spec} to be marked bundled`);
    }
  });

  it("rejects path traversal segments in git package specs", () => {
    const res = resolveHostPackageInstallPath("git:github.com/../../etc/passwd", {
      hostAgentDir: "/host/.pi/agent",
      homeDir: "/host",
    });
    assert.equal(res, null);
  });
});

describe("Host user resources with settings.json mirroring", () => {
  it("stages dereferenced snapshots of host user skills, agents, prompts, ~/.agents/skills", () => {
    const fakeHome = makeTempDir("pi-home-");
    const hostAgentDir = path.join(fakeHome, ".pi", "agent");
    const extSkill = makeTempDir("pi-user-ext-skill-");
    fs.writeFileSync(path.join(extSkill, "SKILL.md"), "# User Symlink Skill\n");

    fs.mkdirSync(path.join(hostAgentDir, "skills"), { recursive: true });
    fs.symlinkSync(extSkill, path.join(hostAgentDir, "skills", "qodo-review"));
    fs.mkdirSync(path.join(fakeHome, ".agents", "skills", "unslop"), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, ".agents", "skills", "unslop", "SKILL.md"), "# Unslop\n");
    fs.mkdirSync(path.join(hostAgentDir, "agents"), { recursive: true });
    fs.writeFileSync(path.join(hostAgentDir, "agents", "my-reviewer.md"), "---\nname: my-reviewer\n---\n");
    fs.mkdirSync(path.join(hostAgentDir, "prompts"), { recursive: true });
    fs.writeFileSync(path.join(hostAgentDir, "prompts", "retro.md"), "Run retro\n");

    const sandboxDir = makeTempDir("pi-sb-user-");
    const { logger } = makeSilentLogger();
    const res = prepareSandboxAgentDir({ sandboxDir, hostAgentDir, homeDir: fakeHome, logger });

    assert.equal(res.hostSkillsDir, path.join(sandboxDir, "host-skills"));
    assert.equal(res.hostAgentsSkillsDir, path.join(sandboxDir, "host-agents-skills"));
    assert.equal(res.hostAgentsDir, path.join(sandboxDir, "host-agents"));
    assert.equal(res.hostPromptsDir, path.join(sandboxDir, "host-prompts"));
    assert.equal(fs.lstatSync(path.join(res.hostSkillsDir!, "qodo-review")).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(res.hostSkillsDir!, "qodo-review", "SKILL.md"), "utf8"), "# User Symlink Skill\n");
    assert.equal(fs.readFileSync(path.join(res.hostAgentsSkillsDir!, "unslop", "SKILL.md"), "utf8"), "# Unslop\n");
    assert.equal(fs.readFileSync(path.join(res.hostAgentsDir!, "my-reviewer.md"), "utf8"), "---\nname: my-reviewer\n---\n");
    assert.equal(fs.readFileSync(path.join(res.hostPromptsDir!, "retro.md"), "utf8"), "Run retro\n");
  });

  it("mirrors non-builtin host settings.json packages while skipping bundled packages", () => {
    const fakeHome = makeTempDir("pi-home-pkgs-");
    const hostAgentDir = path.join(fakeHome, ".pi", "agent");
    const fakePiConfigDir = makeTempDir("pi-local-piconfig-");
    fs.writeFileSync(path.join(fakePiConfigDir, "package.json"), JSON.stringify({ name: "pi-orchestrator-config" }));

    // git: package (ponytail) with .git metadata that must be stripped
    const ponytailDir = path.join(hostAgentDir, "git", "github.com", "DietrichGebert", "ponytail");
    fs.mkdirSync(path.join(ponytailDir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(ponytailDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.mkdirSync(path.join(ponytailDir, "extensions"), { recursive: true });
    fs.writeFileSync(path.join(ponytailDir, "extensions", "index.ts"), "export default () => {};\n");
    fs.mkdirSync(path.join(ponytailDir, "skills", "ponytail-mode"), { recursive: true });
    fs.writeFileSync(path.join(ponytailDir, "skills", "ponytail-mode", "SKILL.md"), "# Ponytail\n");

    // npm: package
    const npmPkgDir = path.join(hostAgentDir, "npm", "node_modules", "custom-helper");
    fs.mkdirSync(npmPkgDir, { recursive: true });
    fs.writeFileSync(path.join(npmPkgDir, "package.json"), JSON.stringify({ name: "custom-helper" }));

    // local path package with object filter
    const localPkgDir = path.join(fakeHome, "my-local-pkg");
    fs.mkdirSync(localPkgDir, { recursive: true });
    fs.writeFileSync(path.join(localPkgDir, "package.json"), JSON.stringify({ name: "my-local-pkg" }));

    // local single-file extension & prompt
    const customExtFile = path.join(fakeHome, "standalone-ext.ts");
    fs.writeFileSync(customExtFile, "export default () => {};\n");
    const customPromptFile = path.join(fakeHome, "quick-cmd.md");
    fs.writeFileSync(customPromptFile, "Quick command\n");

    fs.mkdirSync(hostAgentDir, { recursive: true });
    fs.writeFileSync(
      path.join(hostAgentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: "google",
        defaultModel: "gemini-4-neon",
        packages: [
          "npm:pi-orchestrator-config",
          "npm:@myk-org/pi-vertex-claude",
          "npm:pi-web-access",
          fakePiConfigDir,
          "git:github.com/DietrichGebert/ponytail",
          "npm:custom-helper@1.0.0",
          { source: "~/my-local-pkg", skills: [] },
          "git:github.com/uninstalled/missing-pkg",
        ],
        extensions: ["builtin:mcp", "~/standalone-ext.ts"],
        prompts: ["~/quick-cmd.md"],
      }),
    );

    const sandboxDir = makeTempDir("pi-sb-pkgs-");
    const { logger } = makeSilentLogger();
    const res = prepareSandboxAgentDir({
      sandboxDir,
      hostAgentDir,
      homeDir: fakeHome,
      piConfigDir: fakePiConfigDir,
      logger,
    });

    const containerSettings = JSON.parse(fs.readFileSync(path.join(res.agentDir, "settings.json"), "utf8"));
    assert.equal(containerSettings.packages[0], "/opt/pi-config");
    assert.equal(containerSettings.packages[1], "/opt/node_modules/@myk-org/pi-vertex-claude");
    assert.equal(containerSettings.packages[2], "/opt/node_modules/pi-web-access");
    assert.equal(containerSettings.packages.length, 6);

    const ponytailContainerPath = containerSettings.packages[3];
    assert.match(ponytailContainerPath, /^\/opt\/host-packages\/ponytail-[a-f0-9]{8}$/);
    const ponytailMount = res.hostPackageMounts.find((m) => m.containerPath === ponytailContainerPath);
    assert.ok(ponytailMount);
    assert.equal(fs.existsSync(path.join(ponytailMount.hostPath, ".git")), false);
    assert.equal(fs.existsSync(path.join(ponytailMount.hostPath, "extensions", "index.ts")), true);
    assert.equal(fs.existsSync(path.join(ponytailMount.hostPath, "skills", "ponytail-mode", "SKILL.md")), true);

    assert.match(containerSettings.packages[4], /^\/opt\/host-packages\/custom-helper-[a-f0-9]{8}$/);
    assert.equal(typeof containerSettings.packages[5], "object");
    assert.match(containerSettings.packages[5].source, /^\/opt\/host-packages\/my-local-pkg-[a-f0-9]{8}$/);
    assert.deepEqual(containerSettings.packages[5].skills, []);

    assert.equal(containerSettings.extensions[0], "builtin:mcp");
    assert.match(containerSettings.extensions[1], /^\/opt\/host-packages\/extensions-standalone-ext\.ts-[a-f0-9]{8}\/standalone-ext\.ts$/);
    assert.match(containerSettings.prompts[0], /^\/opt\/host-packages\/prompts-quick-cmd\.md-[a-f0-9]{8}\/quick-cmd\.md$/);

    // Uninstalled remote git spec must never leak into container settings.json
    assert.equal(JSON.stringify(containerSettings).includes("missing-pkg"), false);
  });

  it("refreshes staged skills on respawn", () => {
    const fakeHome = makeTempDir("pi-home-respawn-skills-");
    const hostAgentDir = path.join(fakeHome, ".pi", "agent");
    fs.mkdirSync(path.join(hostAgentDir, "skills", "s1"), { recursive: true });
    fs.writeFileSync(path.join(hostAgentDir, "skills", "s1", "SKILL.md"), "v1");

    const sandboxDir = makeTempDir("pi-sb-respawn-skills-");
    const { logger } = makeSilentLogger();
    prepareSandboxAgentDir({ sandboxDir, hostAgentDir, homeDir: fakeHome, logger });

    fs.writeFileSync(path.join(hostAgentDir, "skills", "s1", "SKILL.md"), "v2");
    const second = prepareSandboxAgentDir({ sandboxDir, hostAgentDir, homeDir: fakeHome, logger });
    assert.equal(fs.readFileSync(path.join(second.hostSkillsDir!, "s1", "SKILL.md"), "utf8"), "v2");
  });

  it("removes stale staged host packages on respawn", () => {
    const fakeHome = makeTempDir("pi-home-respawn-");
    const hostAgentDir = path.join(fakeHome, ".pi", "agent");
    const pkgADir = path.join(hostAgentDir, "git", "github.com", "org", "pkg-a");
    const pkgBDir = path.join(hostAgentDir, "git", "github.com", "org", "pkg-b");
    fs.mkdirSync(pkgADir, { recursive: true });
    fs.writeFileSync(path.join(pkgADir, "a.ts"), "export const a = 1;");
    fs.mkdirSync(pkgBDir, { recursive: true });
    fs.writeFileSync(path.join(pkgBDir, "b.ts"), "export const b = 2;");
    fs.writeFileSync(
      path.join(hostAgentDir, "settings.json"),
      JSON.stringify({ packages: ["git:github.com/org/pkg-a"] }),
    );

    const sandboxDir = makeTempDir("pi-sb-respawn-");
    const { logger } = makeSilentLogger();
    const first = prepareSandboxAgentDir({ sandboxDir, hostAgentDir, homeDir: fakeHome, logger });
    assert.equal(first.hostPackageMounts.length, 1);
    const oldPkgHostDir = first.hostPackageMounts[0].hostPath;
    assert.equal(fs.existsSync(oldPkgHostDir), true);

    fs.writeFileSync(
      path.join(hostAgentDir, "settings.json"),
      JSON.stringify({ packages: ["git:github.com/org/pkg-b"] }),
    );

    const second = prepareSandboxAgentDir({ sandboxDir, hostAgentDir, homeDir: fakeHome, logger });
    assert.equal(fs.existsSync(oldPkgHostDir), false);
    assert.equal(second.hostPackageMounts.length, 1);
    assert.match(second.hostPackageMounts[0].containerPath, /^\/opt\/host-packages\/pkg-b-[a-f0-9]{8}$/);
  });

  it("seeds sandbox workspace trust in agent-dir/trust.json", () => {
    const fakeHome = makeTempDir("pi-home-trust-");
    const hostAgentDir = path.join(fakeHome, ".pi", "agent");
    fs.mkdirSync(hostAgentDir, { recursive: true });
    const sandboxDir = makeTempDir("pi-sb-trust-");
    const workspacePath = path.join(sandboxDir, "workspace");
    fs.mkdirSync(workspacePath, { recursive: true });
    const { logger } = makeSilentLogger();

    const res = prepareSandboxAgentDir({ sandboxDir, hostAgentDir, homeDir: fakeHome, workspacePath, logger });
    const trust = JSON.parse(fs.readFileSync(path.join(res.agentDir, "trust.json"), "utf8"));
    assert.equal(trust[path.resolve(workspacePath)], true);
  });
});

describe("buildPodmanRunArgs read-only host resource mounts", () => {
  const baseRunOpts = {
    imageTag: "localhost/pi-peer:abcdef012345",
    uid: 12345,
    gid: 12345,
    selinuxEnforcing: true,
    cpus: 4,
    memory: "4g",
    piConfigDir: "/opt/host/pi-orchestrator-config",
    agentDir: "/tmp/sandbox/agent-dir",
    hostAuthJsonPath: "/tmp/host-agent/auth.json",
    hostModelsJsonPath: "/tmp/host-agent/models.json",
    hostSkillsDir: "/tmp/sandbox/host-skills",
    hostAgentsSkillsDir: "/tmp/sandbox/host-agents-skills",
    hostAgentsDir: "/tmp/sandbox/host-agents",
    hostPromptsDir: "/tmp/sandbox/host-prompts",
    hostPackageMounts: [
      { hostPath: "/tmp/sandbox/host-packages/ponytail-12345678", containerPath: "/opt/host-packages/ponytail-12345678" },
    ],
    entrypointPath: "/opt/host/scripts/podman-peer-entrypoint.sh",
    gitconfigSeedPath: "/tmp/sandbox/gitconfig.seed",
    workspacePath: "/tmp/sandbox/workspace",
    comsDir: "/tmp/host-coms",
    cname: "worker-1",
    project: "my-project",
    env: {},
  };

  it("mounts host skills, agents, prompts, ~/.agents/skills, packages strictly read-only", () => {
    const argv = buildPodmanRunArgs(baseRunOpts);
    assert.ok(argv.includes("/tmp/sandbox/host-skills:/home/peer/.pi/agent/skills:ro"));
    assert.ok(argv.includes("/tmp/sandbox/host-agents-skills:/home/peer/.agents/skills:ro"));
    assert.ok(argv.includes("/tmp/sandbox/host-agents:/home/peer/.pi/agent/agents:ro"));
    assert.ok(argv.includes("/tmp/sandbox/host-prompts:/home/peer/.pi/agent/prompts:ro"));
    assert.ok(argv.includes("/tmp/sandbox/host-packages/ponytail-12345678:/opt/host-packages/ponytail-12345678:ro"));
  });

  it("never applies :Z or :z relabel suffixes on any mount", () => {
    const argv = buildPodmanRunArgs(baseRunOpts);
    for (const arg of argv) {
      assert.doesNotMatch(arg, /:[zZ](?:,|$)/);
    }
  });

  it("never mounts host skills, agents, prompts, or packages as read-write", () => {
    const argv = buildPodmanRunArgs(baseRunOpts);
    const volumeArgs: string[] = [];
    for (let i = 0; i < argv.length - 1; i++) {
      if (argv[i] === "-v") volumeArgs.push(argv[i + 1]);
    }
    for (const vol of volumeArgs) {
      if (
        vol.includes("/host-skills") ||
        vol.includes("/host-agents") ||
        vol.includes("/host-prompts") ||
        vol.includes("/host-packages") ||
        vol.includes("/.agents/skills")
      ) {
        assert.ok(vol.endsWith(":ro"), `expected read-only mount, got: ${vol}`);
      }
    }
  });

  it("ignores unsafe hostPackageMounts targeting paths outside /opt/host-packages/", () => {
    const argv = buildPodmanRunArgs({
      ...baseRunOpts,
      hostPackageMounts: [
        { hostPath: "/tmp/evil", containerPath: "/etc/evil" },
        { hostPath: "/tmp/trav", containerPath: "/opt/host-packages/../etc/passwd" },
      ],
    });
    assert.equal(argv.some((a) => a.includes("/tmp/evil") || a.includes("/tmp/trav")), false);
  });
});
