/**
 * Tests for scripts/symlink-cli-specialists.sh
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
  existsSync,
  lstatSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, after } from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = join(repoRoot, "scripts", "symlink-cli-specialists.sh");

function run(agentsDir: string, projectRoot: string) {
  const r = spawnSync("bash", [script, agentsDir, projectRoot], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
}

function seedAgents(dir: string, body = "body") {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "github-expert.md"),
    `---\nname: github-expert\n---\n${body}\n`,
  );
  writeFileSync(
    join(dir, "git-expert.md"),
    `---\nname: git-expert\n---\n${body}\n`,
  );
}

describe("symlink-cli-specialists.sh", () => {
  const root = mkdtempSync(join(tmpdir(), "symlink-cli-spec-"));
  const agents = join(root, "agents");
  const project = join(root, "project");
  after(() => rmSync(root, { recursive: true, force: true }));

  it("creates file symlinks in cursor, claude, gemini agent dirs", () => {
    seedAgents(agents);
    mkdirSync(project, { recursive: true });
    run(agents, project);

    for (const dest of [".cursor/agents", ".claude/agents", ".gemini/agents"]) {
      const link = join(project, dest, "github-expert.md");
      assert.ok(existsSync(link));
      assert.ok(lstatSync(link).isSymbolicLink());
      assert.equal(readlinkSync(link), join(agents, "github-expert.md"));
    }
  });

  it("overwrites existing agent symlinks with ln -sfn", () => {
    seedAgents(agents);
    mkdirSync(project, { recursive: true });
    run(agents, project);

    const agents2 = join(root, "agents2");
    seedAgents(agents2, "v2");
    run(agents2, project);

    assert.equal(
      readlinkSync(join(project, ".cursor/agents", "github-expert.md")),
      join(agents2, "github-expert.md"),
    );
  });

  it("leaves unknown files in agent dirs untouched", () => {
    seedAgents(agents);
    mkdirSync(project, { recursive: true });
    run(agents, project);

    writeFileSync(join(project, ".cursor/agents", "user-local.md"), "keep\n");
    run(agents, project);

    assert.ok(existsSync(join(project, ".cursor/agents", "user-local.md")));
    assert.ok(
      !lstatSync(join(project, ".cursor/agents", "user-local.md")).isSymbolicLink(),
    );
  });

  it("skips packaged agent name when destination is a regular file", () => {
    const isolated = join(root, "project-regular-file");
    seedAgents(agents);
    mkdirSync(join(isolated, ".cursor/agents"), { recursive: true });
    const dest = join(isolated, ".cursor/agents", "github-expert.md");
    writeFileSync(dest, "user-owned\n");
    run(agents, isolated);
    assert.ok(!lstatSync(dest).isSymbolicLink());
    assert.equal(readFileSync(dest, "utf8"), "user-owned\n");
  });

  it("skips when .cursor is a symlink (no write outside project)", () => {
    const isolated = join(root, "project-cursor-link");
    const outside = join(root, "outside-cursor");
    seedAgents(agents);
    mkdirSync(isolated, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(isolated, ".cursor"));

    const r = spawnSync("bash", [script, agents, isolated], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stderr, /skip \.cursor\/agents \(symlinked \.cursor\)/);
    assert.ok(!existsSync(join(outside, "agents", "github-expert.md")));
  });

  it("skips when .cursor/agents is a symlink", () => {
    const isolated = join(root, "project-agents-link");
    const outside = join(root, "outside-agents");
    seedAgents(agents);
    mkdirSync(join(isolated, ".cursor"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(isolated, ".cursor", "agents"));

    const r = spawnSync("bash", [script, agents, isolated], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stderr, /skip \.cursor\/agents \(symlinked agents dir\)/);
    assert.ok(!existsSync(join(outside, "github-expert.md")));
  });

  it("continues other CLIs when .cursor is a regular file", () => {
    const isolated = join(root, "project-cursor-file");
    seedAgents(agents);
    mkdirSync(isolated, { recursive: true });
    writeFileSync(join(isolated, ".cursor"), "not-a-dir\n");

    const r = spawnSync("bash", [script, agents, isolated], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stderr, /skip \.cursor\/agents \(\.cursor is not a directory\)/);
    assert.ok(
      lstatSync(join(isolated, ".claude/agents", "github-expert.md")).isSymbolicLink(),
    );
    assert.ok(
      lstatSync(join(isolated, ".gemini/agents", "github-expert.md")).isSymbolicLink(),
    );
  });
});
