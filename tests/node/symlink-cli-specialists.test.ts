/**
 * Tests for scripts/symlink-cli-specialists.sh
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  writeFileSync,
  existsSync,
  lstatSync,
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
});
