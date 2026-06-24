/**
 * Tests for enforcement dangerous-command helpers.
 * Run with: npx tsx --test tests/node/orchestrator/enforcement.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DANGEROUS } from "../../../extensions/orchestrator/git-helpers.js";
import {
  READ_ONLY_COMMANDS,
  extractSubshells,
  isReadOnlyStatement,
  isRmInProjectTmp,
} from "../../../extensions/orchestrator/enforcement-helpers.js";

// ── extractSubshells ──

describe("extractSubshells", () => {
  it("extracts $() command substitution", () => {
    const result = extractSubshells('grep $(rm -rf /) file');
    assert.deepStrictEqual(result, ["rm -rf /"]);
  });

  it("extracts backtick command substitution", () => {
    const result = extractSubshells("grep `rm -rf /` file");
    assert.deepStrictEqual(result, ["rm -rf /"]);
  });

  it("extracts <() process substitution", () => {
    const result = extractSubshells("cat <(rm -rf /)");
    assert.deepStrictEqual(result, ["rm -rf /"]);
  });

  it("extracts >() process substitution", () => {
    const result = extractSubshells("tee >(rm -rf /)");
    assert.deepStrictEqual(result, ["rm -rf /"]);
  });

  it("ignores subshells inside single quotes", () => {
    const result = extractSubshells("echo '$(rm -rf /)'");
    assert.deepStrictEqual(result, []);
  });

  it("handles nested $() by counting parens", () => {
    const result = extractSubshells("echo $(echo $(rm -rf /))");
    assert.deepStrictEqual(result, ["echo $(rm -rf /)"]);
  });

  it("returns empty for plain commands", () => {
    const result = extractSubshells("grep -r foo bar");
    assert.deepStrictEqual(result, []);
  });

  it("extracts multiple subshells", () => {
    const result = extractSubshells("echo $(cmd1) $(cmd2)");
    assert.deepStrictEqual(result, ["cmd1", "cmd2"]);
  });
});

// ── isReadOnlyStatement ──

describe("isReadOnlyStatement", () => {
  it("returns true for grep with quoted rm -rf", () => {
    assert.ok(isReadOnlyStatement('grep "rm -rf" file'));
  });

  it("returns true for cat with harmless args", () => {
    assert.ok(isReadOnlyStatement("cat somefile.txt"));
  });

  it("returns true for rg search", () => {
    assert.ok(isReadOnlyStatement("rg --type ts 'sudo' src/"));
  });

  it("returns true for echo with harmless text", () => {
    assert.ok(isReadOnlyStatement('echo "hello world"'));
  });

  it("returns false for rm -rf (not read-only)", () => {
    assert.ok(!isReadOnlyStatement("rm -rf /tmp/foo"));
  });

  it("returns false for sudo (not read-only)", () => {
    assert.ok(!isReadOnlyStatement("sudo apt install foo"));
  });

  it("returns false for grep with dangerous $() subshell", () => {
    assert.ok(!isReadOnlyStatement("grep $(rm -rf /) file"));
  });

  it("returns false for cat with dangerous <() process substitution", () => {
    assert.ok(!isReadOnlyStatement("cat <(sudo rm -rf /)"));
  });

  it("returns true for grep with safe subshell", () => {
    assert.ok(isReadOnlyStatement("grep $(echo foo) file"));
  });

  it("returns true for grep with dangerous pattern inside single quotes subshell", () => {
    // Single quotes suppress expansion, so '$(rm -rf /)' is a literal string
    assert.ok(isReadOnlyStatement("echo '$(rm -rf /)'"));
  });

  it("handles full path to read-only command", () => {
    assert.ok(isReadOnlyStatement('/usr/bin/grep "rm -rf" file'));
  });

  it("handles env var prefix", () => {
    assert.ok(isReadOnlyStatement('LANG=C grep "sudo" file'));
  });

  it("returns false for unknown commands", () => {
    assert.ok(!isReadOnlyStatement("sort file"));
  });
});

// ── isRmInProjectTmp ──

describe("isRmInProjectTmp", () => {
  let testDir: string;
  let tmpPath: string;

  // Create a real temp dir structure for realpathSync to work
  before(() => {
    testDir = mkdtempSync(join(tmpdir(), "enforcement-test-"));
    tmpPath = join(testDir, ".pi", "tmp");
    mkdirSync(tmpPath, { recursive: true });
    mkdirSync(join(tmpPath, "worker-123"), { recursive: true });
    writeFileSync(join(tmpPath, "worker-123", "output.log"), "test");
  });

  after(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("allows rm -rf targeting .pi/tmp/ subdirectory", () => {
    assert.ok(isRmInProjectTmp(`rm -rf ${join(tmpPath, "worker-123")}`, testDir));
  });

  it("allows rm -rf with relative path to .pi/tmp/", () => {
    assert.ok(isRmInProjectTmp("rm -rf .pi/tmp/worker-123", testDir));
  });

  it("allows rm -rf .pi/tmp itself", () => {
    // Removing the tmp root is allowed (getProjectTmpDir recreates it)
    assert.ok(isRmInProjectTmp("rm -rf .pi/tmp", testDir));
  });

  it("blocks rm -rf with path traversal", () => {
    assert.ok(!isRmInProjectTmp("rm -rf .pi/tmp/../../etc/passwd", testDir));
  });

  it("blocks rm -rf targeting paths outside project", () => {
    assert.ok(!isRmInProjectTmp("rm -rf /tmp/something", testDir));
  });

  it("blocks rm -rf on non-existent paths (can't verify safety)", () => {
    assert.ok(!isRmInProjectTmp("rm -rf .pi/tmp/nonexistent-dir", testDir));
  });

  it("blocks when no path arguments (vacuous truth guard)", () => {
    assert.ok(!isRmInProjectTmp("rm -rf", testDir));
  });

  it("handles -- separator", () => {
    assert.ok(isRmInProjectTmp(`rm -rf -- ${join(tmpPath, "worker-123")}`, testDir));
  });

  it("returns false for find -delete (not direct rm)", () => {
    assert.ok(!isRmInProjectTmp("find .pi/tmp -delete", testDir));
  });

  it("returns false for xargs rm (not direct rm)", () => {
    assert.ok(!isRmInProjectTmp("xargs rm -rf .pi/tmp/foo", testDir));
  });

  it("blocks symlink traversal", () => {
    const symlinkPath = join(tmpPath, "evil-link");
    try {
      symlinkSync("/etc", symlinkPath);
      // rm -rf .pi/tmp/evil-link/passwd — realpathSync resolves through symlink
      assert.ok(!isRmInProjectTmp(`rm -rf ${join(symlinkPath, "passwd")}`, testDir));
    } finally {
      try { rmSync(symlinkPath); } catch {}
    }
  });

  it("handles PROJECT_TMP_DIR env var substitution", () => {
    assert.ok(isRmInProjectTmp("rm -rf ${PROJECT_TMP_DIR}/worker-123", testDir));
  });

  it("blocks sudo rm -rf even when targeting .pi/tmp/", () => {
    assert.ok(!isRmInProjectTmp(`sudo rm -rf ${join(tmpPath, "worker-123")}`, testDir));
  });

  it("allows rm -rf with quoted path in .pi/tmp/", () => {
    assert.ok(isRmInProjectTmp(`rm -rf "${join(tmpPath, "worker-123")}"`, testDir));
  });

});

// ── Integration: pipe splitting + read-only detection ──

describe("pipe splitting integration", () => {
  // Simulates what enforcement.ts does: split → filter read-only → check DANGEROUS
  function wouldTriggerDangerous(command: string): boolean {
    const normalized = command.replace(/\\\r?\n/g, " ");
    const statements = normalized.split(/\n|;|&&|\|\||\|/).map(s => s.trim()).filter(Boolean);
    return statements.some((stmt) => {
      if (isReadOnlyStatement(stmt)) return false;
      return DANGEROUS.some((p) => p.test(stmt));
    });
  }

  it("grep with rm -rf in quotes does NOT trigger", () => {
    assert.ok(!wouldTriggerDangerous('grep "rm -rf" somefile'));
  });

  it("echo | sudo rm -rf / DOES trigger", () => {
    assert.ok(wouldTriggerDangerous("echo harmless | sudo rm -rf /"));
  });

  it("grep foo | rm -rf / DOES trigger", () => {
    assert.ok(wouldTriggerDangerous("grep foo | rm -rf /"));
  });

  it("grep $(rm -rf /) file DOES trigger", () => {
    assert.ok(wouldTriggerDangerous("grep $(rm -rf /) file"));
  });

  it("grep $(echo foo) file does NOT trigger", () => {
    assert.ok(!wouldTriggerDangerous("grep $(echo foo) file"));
  });

  it("plain rm -rf /foo DOES trigger", () => {
    assert.ok(wouldTriggerDangerous("rm -rf /foo"));
  });

  it("rg 'sudo' src/ does NOT trigger", () => {
    assert.ok(!wouldTriggerDangerous("rg 'sudo' src/"));
  });

  it("cat file; rm -rf / DOES trigger (semicolon split)", () => {
    assert.ok(wouldTriggerDangerous("cat file; rm -rf /"));
  });

  it("echo 'safe' && git reset --hard DOES trigger", () => {
    assert.ok(wouldTriggerDangerous("echo 'safe' && git reset --hard"));
  });
});
