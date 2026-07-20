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

describe("symlink-cli-specialists.sh", () => {
  const root = mkdtempSync(join(tmpdir(), "symlink-cli-spec-"));
  const agents = join(root, "agents");
  const project = join(root, "project");
  after(() => rmSync(root, { recursive: true, force: true }));

  it("creates file symlinks in all three CLI dirs and overwrites with ln -sfn", () => {
    mkdirSync(agents, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(agents, "github-expert.md"), "---\nname: github-expert\n---\nbody\n");
    writeFileSync(join(agents, "git-expert.md"), "---\nname: git-expert\n---\nbody\n");

    run(agents, project);

    for (const dest of [".cursor/agents", ".claude/agents", ".gemini/agents"]) {
      const link = join(project, dest, "github-expert.md");
      assert.ok(existsSync(link));
      assert.ok(lstatSync(link).isSymbolicLink());
      assert.equal(readlinkSync(link), join(agents, "github-expert.md"));
    }

    // Concurrent / second run: change target file content path by rewriting via new agents dir copy
    const agents2 = join(root, "agents2");
    mkdirSync(agents2, { recursive: true });
    writeFileSync(join(agents2, "github-expert.md"), "---\nname: github-expert\n---\nv2\n");
    writeFileSync(join(agents2, "git-expert.md"), "---\nname: git-expert\n---\nv2\n");
    run(agents2, project);

    assert.equal(
      readlinkSync(join(project, ".cursor/agents", "github-expert.md")),
      join(agents2, "github-expert.md"),
    );
    // Unknown extra file left alone
    writeFileSync(join(project, ".cursor/agents", "user-local.md"), "keep\n");
    run(agents2, project);
    assert.ok(existsSync(join(project, ".cursor/agents", "user-local.md")));
    assert.ok(!lstatSync(join(project, ".cursor/agents", "user-local.md")).isSymbolicLink());
  });
});
