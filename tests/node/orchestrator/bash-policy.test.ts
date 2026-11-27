/**
 * Pure in-process tests targeting the deep bash-policy evaluation interface
 * (`evaluateBashPolicy`, `evaluateFileWritePolicy`, and unified `DANGEROUS_RULES`).
 * Run with: npx tsx --test tests/node/orchestrator/bash-policy.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  clearAllDangerousSessionApprovals,
  clearBranchCache,
  clearTrackedSettingsCache,
  DANGEROUS,
  DANGEROUS_EXPLANATIONS,
  DANGEROUS_LABELS,
  DANGEROUS_RULES,
  dangerousPatternExplanation,
  dangerousPatternLabel,
  evaluateBashPolicy,
  evaluateFileWritePolicy,
  executableText,
  resolveCommentSignatureModelId,
  resolveCommitTrailerModelId,
  segmentRunsGit,
  skipToCommandWord,
  type BashPolicyUi,
} from "../../../extensions/orchestrator/bash-policy.js";
import { clearSettingsCache } from "../../../extensions/orchestrator/project-settings.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test User",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test User",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function initRepo(dir: string, branch = "main"): void {
  execFileSync("git", ["init", "-b", branch], { cwd: dir, env: GIT_ENV, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "hello\n");
  execFileSync("git", ["add", "README.md"], { cwd: dir, env: GIT_ENV, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, env: GIT_ENV, stdio: "ignore" });
}

function writeProjectSettings(dir: string, settings: Record<string, unknown>): void {
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "pi-config-settings.json"), JSON.stringify(settings));
  clearSettingsCache();
}

afterEach(() => {
  clearAllDangerousSessionApprovals();
  clearBranchCache();
  clearTrackedSettingsCache();
  clearSettingsCache();
});

describe("DANGEROUS_RULES unified registry", () => {
  it("derives DANGEROUS arrays with exact positional alignment", () => {
    assert.equal(DANGEROUS.length, DANGEROUS_RULES.length);
    assert.equal(DANGEROUS_LABELS.length, DANGEROUS_RULES.length);
    assert.equal(DANGEROUS_EXPLANATIONS.length, DANGEROUS_RULES.length);
    for (let i = 0; i < DANGEROUS_RULES.length; i++) {
      const rule = DANGEROUS_RULES[i]!;
      assert.equal(DANGEROUS[i], rule.pattern);
      assert.equal(DANGEROUS_LABELS[i], rule.label);
      assert.equal(DANGEROUS_EXPLANATIONS[i], rule.explanation);
      assert.equal(dangerousPatternLabel(rule.pattern), rule.label);
      assert.equal(dangerousPatternExplanation(rule.pattern), rule.explanation);
    }
  });
});

describe("evaluateFileWritePolicy", () => {
  it("blocks direct writes to project pi-config-settings.json", () => {
    const dir = makeTempDir("pi-bash-policy-fw-");
    const result = evaluateFileWritePolicy(".pi/pi-config-settings.json", dir);
    assert.ok(result?.block);
    assert.match(result.reason, /pi-config-settings/);
  });

  it("blocks direct writes to repository git config", () => {
    const dir = makeTempDir("pi-bash-policy-fw-");
    const result = evaluateFileWritePolicy(".git/config", dir);
    assert.ok(result?.block);
    assert.match(result.reason, /Git identity config/);
  });

  it("allows writing ordinary source files", () => {
    const dir = makeTempDir("pi-bash-policy-fw-");
    const result = evaluateFileWritePolicy("src/index.ts", dir);
    assert.equal(result, undefined);
  });
});

describe("evaluateBashPolicy shell quoting and heredoc parsing", () => {
  it("ignores git commit text inside a heredoc body", async () => {
    const dir = makeTempDir("pi-bash-policy-shell-");
    const cmd = "cat <<'EOF'\nrun git commit -m 'example'\nEOF";
    const decision = await evaluateBashPolicy({ command: cmd, cwd: dir, agentName: "worker" });
    assert.equal(decision.action, "allow");
  });

  it("blocks real git commit outside heredoc for non-git-expert agents", async () => {
    const dir = makeTempDir("pi-bash-policy-shell-");
    const cmd = "cat <<'EOF'\nnotes\nEOF\ngit commit -m 'real'";
    const decision = await evaluateBashPolicy({ command: cmd, cwd: dir, agentName: "worker" });
    assert.equal(decision.action, "block");
    assert.match(decision.reason, /git-expert/);
  });

  it("allows read-only grep searching for single-quoted dangerous text", async () => {
    const dir = makeTempDir("pi-bash-policy-shell-");
    const decision = await evaluateBashPolicy({
      command: "grep -rn 'sudo rm -rf /' src/",
      cwd: dir,
      ui: null,
    });
    assert.equal(decision.action, "allow");
  });

  it("blocks dangerous command substitution hidden inside double-quoted read-only arguments", async () => {
    const dir = makeTempDir("pi-bash-policy-shell-");
    const decision = await evaluateBashPolicy({
      command: 'echo "checking $(rm -rf /var/tmp/x)"',
      cwd: dir,
      ui: null,
    });
    assert.equal(decision.action, "block");
    assert.match(decision.reason, /Dangerous command blocked/);
  });

  it("exempts bash -n noexec syntax checks without prompting", async () => {
    const dir = makeTempDir("pi-bash-policy-shell-");
    const decision = await evaluateBashPolicy({
      command: "bash -n scripts/deploy.sh",
      cwd: dir,
      ui: null,
    });
    assert.equal(decision.action, "allow");
  });
});

describe("evaluateBashPolicy dangerous command matching", () => {
  it("blocks unapproved dangerous commands in headless mode", async () => {
    const dir = makeTempDir("pi-bash-policy-danger-");
    const decision = await evaluateBashPolicy({
      command: "sudo systemctl restart nginx",
      cwd: dir,
      ui: null,
    });
    assert.equal(decision.action, "block");
    assert.match(decision.reason, /no UI for confirmation/);
  });

  it("blocks recursive rm with a relative path before prompting", async () => {
    const dir = makeTempDir("pi-bash-policy-danger-");
    let prompted = false;
    const ui: BashPolicyUi = {
      select: async () => {
        prompted = true;
        return "Yes — run once";
      },
      notify: () => {},
    };
    const decision = await evaluateBashPolicy({
      command: "rm -rf build/output",
      cwd: dir,
      ui,
    });
    assert.equal(decision.action, "block");
    assert.match(decision.reason, /ABSOLUTE paths/);
    assert.equal(prompted, false);
  });

  it("exempts recursive rm targeting project .pi/tmp scratch directory", async () => {
    const dir = makeTempDir("pi-bash-policy-danger-");
    mkdirSync(join(dir, ".pi", "tmp", "run1"), { recursive: true });
    const decision = await evaluateBashPolicy({
      command: `rm -rf ${join(dir, ".pi", "tmp", "run1")}`,
      cwd: dir,
      ui: null,
    });
    assert.equal(decision.action, "allow");
  });

  it("honors session approval on subsequent identical dangerous runs", async () => {
    const dir = makeTempDir("pi-bash-policy-danger-");
    let selectCalls = 0;
    const ui: BashPolicyUi = {
      select: async (_title, options) => {
        selectCalls++;
        return options.find((opt) => opt.startsWith("Allow for this session:"));
      },
      notify: () => {},
    };
    const first = await evaluateBashPolicy({
      command: "sudo systemctl status nginx",
      cwd: dir,
      sessionId: "sess-policy-1",
      ui,
    });
    assert.equal(first.action, "allow");
    assert.equal(selectCalls, 1);

    const second = await evaluateBashPolicy({
      command: "sudo systemctl status nginx",
      cwd: dir,
      sessionId: "sess-policy-1",
      ui,
    });
    assert.equal(second.action, "allow");
    assert.equal(selectCalls, 1);
  });

  it("blocks stdin-fed bare shell when user declines confirmation", async () => {
    const dir = makeTempDir("pi-bash-policy-danger-");
    const ui: BashPolicyUi = {
      select: async (_title, options) => {
        assert.equal(
          options.some((o) => o.startsWith("Allow for this session:") || o.startsWith("Always allow")),
          false,
        );
        return "No";
      },
      notify: () => {},
    };
    const decision = await evaluateBashPolicy({
      command: "echo hi | bash",
      cwd: dir,
      sessionId: "sess-policy-2",
      ui,
    });
    assert.equal(decision.action, "block");
    assert.match(decision.reason, /Blocked by user/);
  });
});

describe("evaluateBashPolicy git protection and workflow guards", () => {
  it("blocks git add bulk staging inside a git repository", async () => {
    const dir = makeTempDir("pi-bash-policy-git-");
    initRepo(dir, "feat/test");
    const decision = await evaluateBashPolicy({
      command: "git add .",
      cwd: dir,
      agentName: "git-expert",
    });
    assert.equal(decision.action, "block");
    assert.match(decision.reason, /git add \./);
  });

  it("blocks git add --force inside a git repository", async () => {
    const dir = makeTempDir("pi-bash-policy-git-");
    initRepo(dir, "feat/test");
    const decision = await evaluateBashPolicy({
      command: "git add -f ignored.log",
      cwd: dir,
      agentName: "git-expert",
    });
    assert.equal(decision.action, "block");
    assert.match(decision.reason, /--force/);
  });

  it("blocks git commit --no-verify for git-expert", async () => {
    const dir = makeTempDir("pi-bash-policy-git-");
    initRepo(dir, "feat/test");
    const decision = await evaluateBashPolicy({
      command: "git commit --no-verify -m 'skip hooks'",
      cwd: dir,
      agentName: "git-expert",
    });
    assert.equal(decision.action, "block");
    assert.match(decision.reason, /--no-verify/);
  });

  it("blocks committing directly on protected main branch", async () => {
    const dir = makeTempDir("pi-bash-policy-git-");
    initRepo(dir, "main");
    const decision = await evaluateBashPolicy({
      command: "git commit -m 'direct commit'",
      cwd: dir,
      agentName: "git-expert",
    });
    assert.equal(decision.action, "block");
    assert.match(decision.reason, /Cannot commit to 'main'/);
  });

  it("blocks pushing directly to protected main branch", async () => {
    const dir = makeTempDir("pi-bash-policy-git-");
    initRepo(dir, "feat/test");
    const decision = await evaluateBashPolicy({
      command: "git push origin HEAD:main",
      cwd: dir,
      agentName: "git-expert",
    });
    assert.equal(decision.action, "block");
    assert.match(decision.reason, /Cannot push to 'main'/);
  });

  it("invokes checkReviewLoopCommit gate for git-expert commits", async () => {
    const dir = makeTempDir("pi-bash-policy-git-");
    initRepo(dir, "feat/test");
    const decision = await evaluateBashPolicy({
      command: "git commit -m 'unreviewed'",
      cwd: dir,
      agentName: "git-expert",
      checkReviewLoopCommit: () => ({
        block: true,
        reason: "Review loop incomplete",
      }),
    });
    assert.equal(decision.action, "block");
    assert.equal(decision.reason, "Review loop incomplete");
  });

  it("strips timeout on myk-pi-tools reviews poll commands", async () => {
    const dir = makeTempDir("pi-bash-policy-misc-");
    const decision = await evaluateBashPolicy({
      command: "uvx myk-pi-tools@latest reviews poll 123",
      cwd: dir,
      hasTimeout: true,
    });
    assert.equal(decision.action, "allow");
    assert.equal(decision.stripTimeout, true);
  });

  it("allows repeated identical bash commands without blocking (e.g. edit-retest loops)", async () => {
    const dir = makeTempDir("pi-bash-policy-misc-");
    for (let i = 0; i < 5; i++) {
      const decision = await evaluateBashPolicy({ command: "git status", cwd: dir });
      assert.equal(decision.action, "allow", `run #${i + 1} should be allowed`);
    }
  });

  it("still blocks polling loops with sleep exceeding enforcement_loop_sleep_threshold_s", async () => {
    const dir = makeTempDir("pi-bash-policy-misc-");
    const decision = await evaluateBashPolicy({
      command: "while true; do sleep 65; echo polling; done",
      cwd: dir,
    });
    assert.equal(decision.action, "block");
    assert.match(decision.reason, /Polling loop with sleep 65s blocked/);
  });

  it("blocks git identity environment overrides", async () => {
    const dir = makeTempDir("pi-bash-policy-misc-");
    const decision = await evaluateBashPolicy({
      command: "GIT_AUTHOR_NAME=Bot git commit -m 'forged'",
      cwd: dir,
      agentName: "git-expert",
    });
    assert.equal(decision.action, "block");
    assert.match(decision.reason, /Git identity override blocked/);
  });

  it("blocks direct docker CLI inside a container", async () => {
    const dir = makeTempDir("pi-bash-policy-misc-");
    const decision = await evaluateBashPolicy({
      command: "docker ps",
      cwd: dir,
      inContainer: true,
    });
    assert.equal(decision.action, "block");
    assert.match(decision.reason, /docker-safe/);
  });

  it("allows docker-safe CLI inside a container", async () => {
    const dir = makeTempDir("pi-bash-policy-misc-");
    const decision = await evaluateBashPolicy({
      command: "docker-safe ps",
      cwd: dir,
      inContainer: true,
    });
    assert.equal(decision.action, "allow");
  });
});

describe("evaluateBashPolicy commit trailer and DCO checks", () => {
  it("injects configured commit_trailer into git commit -m", async () => {
    const dir = makeTempDir("pi-bash-policy-trailer-");
    initRepo(dir, "feat/trailer");
    writeProjectSettings(dir, { commit_trailer: "Assisted-by", dco: false });
    const decision = await evaluateBashPolicy({
      command: 'git commit -m "feat: add policy"',
      cwd: dir,
      agentName: "git-expert",
      ctxModelId: "test-model-1",
    });
    assert.equal(decision.action, "allow");
    assert.ok(decision.modifiedCommand);
    assert.match(decision.modifiedCommand, /Assisted-by: PI \(/);
  });

  it("injects --signoff when dco setting is enabled", async () => {
    const dir = makeTempDir("pi-bash-policy-trailer-");
    initRepo(dir, "feat/dco");
    writeProjectSettings(dir, { commit_trailer: false, dco: true });
    const decision = await evaluateBashPolicy({
      command: 'git commit -m "feat: signed"',
      cwd: dir,
      agentName: "git-expert",
    });
    assert.equal(decision.action, "allow");
    assert.ok(decision.modifiedCommand);
    assert.match(decision.modifiedCommand, /git commit --signoff /);
  });

  it("refuses unresolved placeholder trailers", async () => {
    const dir = makeTempDir("pi-bash-policy-trailer-");
    initRepo(dir, "feat/placeholder");
    writeProjectSettings(dir, { commit_trailer: "Assisted-by", dco: false });
    const decision = await evaluateBashPolicy({
      command: 'git commit -m "feat: x\n\nAssisted-by: PI (MODEL)"',
      cwd: dir,
      agentName: "git-expert",
      ctxModelId: "real-model",
    });
    assert.equal(decision.action, "block");
    assert.match(decision.reason, /unresolved placeholder/);
  });

  it("accepts commit -F when the message file already carries the trailer", async () => {
    const dir = makeTempDir("pi-bash-policy-trailer-");
    initRepo(dir, "feat/msgfile");
    writeProjectSettings(dir, { commit_trailer: "Assisted-by", dco: false });
    const msgFile = join(dir, "commit-msg.txt");
    writeFileSync(msgFile, "feat: clean\n\nAssisted-by: PI (test-model)\n");
    const decision = await evaluateBashPolicy({
      command: `git commit -F ${msgFile}`,
      cwd: dir,
      agentName: "git-expert",
      ctxModelId: "test-model",
    });
    assert.equal(decision.action, "allow");
  });

  it("refuses commit -F when the same command writes the message file", async () => {
    const dir = makeTempDir("pi-bash-policy-trailer-");
    initRepo(dir, "feat/msgwrite");
    writeProjectSettings(dir, { commit_trailer: "Assisted-by", dco: false });
    const msgFile = join(dir, "commit-msg.txt");
    writeFileSync(msgFile, "feat: stale\n\nAssisted-by: PI (test-model)\n");
    const decision = await evaluateBashPolicy({
      command: `printf 'no trailer\\n' > ${msgFile} && git commit -F ${msgFile}`,
      cwd: dir,
      agentName: "git-expert",
      ctxModelId: "test-model",
    });
    assert.equal(decision.action, "block");
    assert.match(decision.reason, /writes .* and commits it in the same call/);
  });

  it("caches interactive trailer selection across commits", async () => {
    const dir = makeTempDir("pi-bash-policy-trailer-");
    initRepo(dir, "feat/multiselect");
    writeProjectSettings(dir, { commit_trailer: "Assisted-by,Co-authored-by", dco: false });
    let cached: string | null = null;
    let promptCount = 0;
    const ui: BashPolicyUi = {
      select: async () => {
        promptCount++;
        return "Co-authored-by";
      },
      notify: () => {},
    };
    const trailerSelection = {
      get: () => cached,
      set: (v: string) => {
        cached = v;
      },
    };
    const first = await evaluateBashPolicy({
      command: 'git commit -m "first"',
      cwd: dir,
      agentName: "git-expert",
      ctxModelId: "test-model",
      ui,
      trailerSelection,
    });
    assert.equal(first.action, "allow");
    assert.match(first.modifiedCommand ?? "", /Co-authored-by: PI \(/);
    assert.equal(promptCount, 1);

    const second = await evaluateBashPolicy({
      command: 'git commit -m "second"',
      cwd: dir,
      agentName: "git-expert",
      ctxModelId: "test-model",
      ui,
      trailerSelection,
    });
    assert.equal(second.action, "allow");
    assert.match(second.modifiedCommand ?? "", /Co-authored-by: PI \(/);
    assert.equal(promptCount, 1);
  });
});

describe("executableText direct helper", () => {
  it("strips inert single-quoted text to a placeholder", () => {
    const scanned = executableText("echo 'git add conflicted.txt'");
    assert.equal(scanned.includes("git add"), false);
  });

  it("strips quoted heredoc bodies without losing trailing commands", () => {
    const scanned = executableText("cat <<'EOF'\ngit add secret.txt\nEOF\ngit status");
    assert.equal(scanned.includes("git add"), false);
    assert.match(scanned, /git status/);
  });

  it("descends into command substitutions inside double quotes", () => {
    const scanned = executableText('echo "prefix $(git add file.txt)"');
    assert.match(scanned, /git add file\.txt/);
  });

  it("descends into bash -c script arguments", () => {
    const scanned = executableText("bash -c 'git reset --hard'");
    assert.match(scanned, /git reset --hard/);
  });

  it("emits the unscanned sentinel past the recursion depth ceiling", () => {
    const scanned = executableText("git status", 7);
    assert.match(scanned, /unscanned-nesting/);
  });
});

describe("skipToCommandWord direct helper", () => {
  it("skips control keywords before the executable word", () => {
    assert.equal(skipToCommandWord(["if", "then", "git", "status"]), 2);
  });

  it("skips leading environment variable assignments", () => {
    assert.equal(skipToCommandWord(["FOO=1", "BAR=2", "rg", "needle"]), 2);
  });

  it("skips function keyword with its declared name", () => {
    assert.equal(skipToCommandWord(["function", "helper", "{", "git", "diff"]), 3);
  });

  it("skips rtk wrapper along with its value-taking flags", () => {
    assert.equal(skipToCommandWord(["rtk", "-u", "root", "-v", "git", "add", "a.ts"]), 4);
  });
});

describe("segmentRunsGit direct helper", () => {
  it("returns true for direct git commands", () => {
    assert.equal(segmentRunsGit("git status --short"), true);
  });

  it("returns true for git behind an executor wrapper", () => {
    assert.equal(segmentRunsGit("sudo -u dev git add a.ts"), true);
  });

  it("returns false when git appears only inside a directory path", () => {
    assert.equal(segmentRunsGit("cd /home/user/git/project"), false);
  });

  it("returns false when git is printed by a non-executor command", () => {
    assert.equal(segmentRunsGit("echo git commit -m msg"), false);
  });
});

describe("model id resolvers", () => {
  const savedPrimary = process.env.PI_PRIMARY_MODEL;
  const savedModel = process.env.PI_MODEL;

  afterEach(() => {
    if (savedPrimary === undefined) delete process.env.PI_PRIMARY_MODEL;
    else process.env.PI_PRIMARY_MODEL = savedPrimary;
    if (savedModel === undefined) delete process.env.PI_MODEL;
    else process.env.PI_MODEL = savedModel;
  });

  it("resolveCommitTrailerModelId prefers PI_PRIMARY_MODEL over PI_MODEL", () => {
    process.env.PI_PRIMARY_MODEL = "primary-model";
    process.env.PI_MODEL = "secondary-model";
    assert.equal(resolveCommitTrailerModelId("ctx-model"), "primary-model");
  });

  it("resolveCommitTrailerModelId skips placeholder values to use context model", () => {
    process.env.PI_PRIMARY_MODEL = "MODEL";
    process.env.PI_MODEL = "$PI_MODEL";
    assert.equal(resolveCommitTrailerModelId("real-ctx-model"), "real-ctx-model");
  });

  it("resolveCommitTrailerModelId falls back to unknown when only placeholders exist", () => {
    process.env.PI_PRIMARY_MODEL = "unknown";
    process.env.PI_MODEL = "${PI_MODEL}";
    assert.equal(resolveCommitTrailerModelId("   "), "unknown");
  });

  it("resolveCommitTrailerModelId sanitizes unsafe characters from the model id", () => {
    delete process.env.PI_PRIMARY_MODEL;
    delete process.env.PI_MODEL;
    assert.equal(resolveCommitTrailerModelId("claude;rm -rf /"), "clauderm -rf /");
  });

  it("resolveCommentSignatureModelId prefers context model id over env vars", () => {
    process.env.PI_PRIMARY_MODEL = "primary-model";
    process.env.PI_MODEL = "env-model";
    assert.equal(resolveCommentSignatureModelId("live-ctx-model"), "live-ctx-model");
  });

  it("resolveCommentSignatureModelId falls back to PI_MODEL when context is absent", () => {
    process.env.PI_PRIMARY_MODEL = "primary-model";
    process.env.PI_MODEL = "env-model";
    assert.equal(resolveCommentSignatureModelId(undefined), "env-model");
  });

  it("resolveCommentSignatureModelId falls back to unknown when all sources are empty", () => {
    delete process.env.PI_PRIMARY_MODEL;
    delete process.env.PI_MODEL;
    assert.equal(resolveCommentSignatureModelId(""), "unknown");
  });
});
