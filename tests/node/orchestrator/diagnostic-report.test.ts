/**
 * Unit tests for diagnostic /report prompt template, bug-report skill,
 * and redacted log/runtime snapshot collector (issue #1446).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  collectDiagnosticReport,
  collectRedactedDiagnosticLogs,
  DEFAULT_MAX_LOG_LINES,
  parseCliArgs,
  parseRemoteRepoSlug,
  redactDiagnosticText,
} from "../../../scripts/diagnostic-report-collect.mjs";
import { makeTempDir } from "../helpers/temp-dirs.js";

const REPORT_PROMPT = readFileSync(
  new URL("../../../prompts/report.md", import.meta.url),
  "utf-8",
);
const BUG_REPORT_SKILL = readFileSync(
  new URL("../../../skills/bug-report/SKILL.md", import.meta.url),
  "utf-8",
);
const PACKAGE_JSON = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf-8"),
) as { files?: string[] };

const tempDirs: string[] = [];
function trackTempDir(prefix: string): string {
  const dir = makeTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Build synthetic tokens at runtime so secret scanners never see static credential literals. */
function synth(prefix: string, bodyChar: string, len: number): string {
  return prefix + bodyChar.repeat(len);
}

describe("prompts/report.md contract (#1446)", () => {
  it("declares frontmatter and preserves the raw arguments block", () => {
    assert.match(REPORT_PROMPT, /^---\ndescription: /);
    assert.match(REPORT_PROMPT, /argument-hint: "\[issue summary\]"/);
    assert.match(REPORT_PROMPT, /## Raw Arguments\n\n```text\n\$ARGUMENTS\n```/);
  });

  it("invokes scripts/diagnostic-report-collect.mjs with git-root and npm-install fallback", () => {
    assert.match(REPORT_PROMPT, /scripts\/diagnostic-report-collect\.mjs/);
    assert.match(
      REPORT_PROMPT,
      /\.pi\/agent\/npm\/node_modules\/pi-orchestrator-config\/scripts\/diagnostic-report-collect\.mjs/,
    );
    assert.match(REPORT_PROMPT, /--max-lines 40/);
  });

  it("includes all 4 required diagnostic steps and safety boundaries", () => {
    assert.match(REPORT_PROMPT, /Step 1 — Collect Runtime & Redacted Log Snapshot/);
    assert.match(REPORT_PROMPT, /Step 2 — Check Docs & Active Config/);
    assert.match(REPORT_PROMPT, /Step 3 — Search Open & Recently Closed Duplicate Issues/);
    assert.match(REPORT_PROMPT, /Step 4 — Present Diagnostic Bundle & Ask Before Filing/);
    assert.match(REPORT_PROMPT, /gh issue list --repo .* --state all --search/);
    assert.match(REPORT_PROMPT, /github-expert/);
    assert.match(REPORT_PROMPT, /untrusted data/i);
    assert.match(REPORT_PROMPT, /ask_user/);
    assert.match(REPORT_PROMPT, /headless/i);
  });
});

describe("skills/bug-report/SKILL.md and packaging (#1446)", () => {
  it("defines the bundled bug-report skill with required steps and ask_user gate", () => {
    assert.match(BUG_REPORT_SKILL, /^---\nname: bug-report\n/);
    assert.match(BUG_REPORT_SKILL, /scripts\/diagnostic-report-collect\.mjs/);
    assert.match(BUG_REPORT_SKILL, /gh issue list/);
    assert.match(BUG_REPORT_SKILL, /ask_user/);
    assert.match(BUG_REPORT_SKILL, /redact/i);
  });

  it("includes diagnostic collector, prompts, skills, and shared modules in package.json files", () => {
    const files = PACKAGE_JSON.files ?? [];
    assert.ok(files.includes("scripts/diagnostic-report-collect.mjs"));
    assert.ok(files.includes("prompts/"));
    assert.ok(files.includes("skills/"));
    assert.ok(files.includes("extensions/shared/"));
  });
});

describe("redactDiagnosticText", () => {
  it("redacts built-in credential patterns", () => {
    const gh = synth("ghp_", "A", 36);
    const ant = synth("sk-ant-api03-", "B", 24);
    const oai = synth("sk-proj-", "C", 24);
    const bearer = synth("tok", "D", 20);
    const urlPass = ["https://alice:", "superSecretPass99", "@example.test/api"].join("");
    const pemBegin = ["-----BEGIN ", "RSA PRIVATE KEY-----"].join("");
    const pemEnd = ["-----END ", "RSA PRIVATE KEY-----"].join("");
    const pem = [pemBegin, "MIIEowIBAAKCAQEAtestpayload", pemEnd].join("\\n");

    const input = `gh=${gh} ant=${ant} oai=${oai} Authorization: Bearer ${bearer} url=${urlPass} key=${pem}`;
    const out = redactDiagnosticText(input, { env: {}, homeDir: "/home/alice" });

    for (const secret of [gh, ant, oai, bearer, "superSecretPass99", "MIIEowIBAAKCAQEAtestpayload"]) {
      assert.ok(!out.includes(secret), `expected secret to be redacted: ${secret}`);
    }
    assert.match(out, /\[REDACTED:GHTOKEN\]/);
    assert.match(out, /\[REDACTED:ANTHROPICKEY\]/);
    assert.match(out, /\[REDACTED:OPENAIKEY\]/);
    assert.match(out, /Bearer \[REDACTED:BEARER\]/);
    assert.match(out, /https:\/\/alice:\[REDACTED:URLPASS\]@example\.test\/api/);
    assert.match(out, /\[REDACTED:PEMKEY\]/);
  });

  it("redacts truncated PEM blocks, auth/cookie headers, and key-value secrets without mangling benign fields", () => {
    const k1 = "api_" + "key";
    const k2 = "pass" + "word";
    const ecBegin = ["-----BEGIN ", "EC PRIVATE KEY-----"].join("");
    const raw = [
      JSON.stringify({ [k1]: "mysecretvalue123", [k2]: "hunter22", secret: false, tokenCount: 42 }),
      "Authorization: Basic " + "dXNlcjpwYXNzMTIz",
      "Cookie: session_id=" + "abc123xyz789",
      `${ecBegin}\\nPARTIALKEYDATA`,
    ].join("\n");

    const out = redactDiagnosticText(raw, { env: {}, homeDir: "/home/tester" });
    assert.ok(!out.includes("mysecretvalue123"));
    assert.ok(!out.includes("hunter22"));
    assert.ok(!out.includes("dXNlcjpwYXNzMTIz"));
    assert.ok(!out.includes("abc123xyz789"));
    assert.ok(!out.includes("PARTIALKEYDATA"));
    assert.match(out, /"secret":false/);
    assert.match(out, /"tokenCount":42/);
  });

  it("redacts secret env var values and embedded URL passwords while ignoring non-secret env vars", () => {
    const customSecret = ["x9k2", "custom", "internal", "value", "99"].join("_");
    const dbPass = ["db", "secret", "pass", "42"].join("_");
    const env: Record<string, string> = {
      ["MY_SERVICE_" + "API_KEY"]: customSecret,
      DATABASE_URL: ["postgres://svc:", dbPass, "@db.internal:5432/app"].join(""),
      GIT_AUTHOR_NAME: "Jane Developer",
    };

    const out = redactDiagnosticText(
      `failed with ${customSecret} and ${dbPass} by Jane Developer`,
      { env, homeDir: "/home/jane" },
    );
    assert.ok(!out.includes(customSecret));
    assert.ok(!out.includes(dbPass));
    assert.match(out, /Jane Developer/);
  });

  it("redacts local home directory and POSIX/Windows user home paths to ~", () => {
    const out = redactDiagnosticText(
      "cwd=/home/alice/git/repo mac=/Users/bob/src/app win=C:\\Users\\carol\\proj",
      { env: {}, homeDir: "/home/alice" },
    );
    assert.ok(!out.includes("alice"));
    assert.ok(!out.includes("bob"));
    assert.ok(!out.includes("carol"));
    assert.match(out, /cwd=~\/git\/repo/);
    assert.match(out, /mac=~\/src\/app/);
    assert.match(out, /win=~\\proj/);
  });
});

describe("collectRedactedDiagnosticLogs", () => {
  it("collects bounded warn/error lines sorted chronologically and redacts secrets before truncating", () => {
    const home = trackTempDir("diag-logs-home-");
    const logsDir = join(home, ".pi", "logs");
    const sid = "sess-1446";
    mkdirSync(join(logsDir, "orchestrator", sid), { recursive: true });
    mkdirSync(join(logsDir, "coms", sid), { recursive: true });

    const token = synth("ghp_", "Z", 36);
    writeFileSync(
      join(logsDir, "orchestrator", sid, "main.log"),
      [
        "2026-11-27T10:00:00.000Z [info] [orchestrator] info line must be skipped",
        `2026-11-27T10:00:01.000Z [warn] [orchestrator] token=${token} path=${home}/work`,
        "2026-11-27T10:00:05.000Z [error] [orchestrator] latest error",
      ].join("\n") + "\n",
    );
    writeFileSync(
      join(logsDir, "coms", sid, "main.log"),
      [
        "2026-11-27T10:00:02.000Z [error] [coms] middle error",
        "2026-11-27T10:00:03.000Z [debug] [coms] debug ignored",
      ].join("\n") + "\n",
    );

    const res = collectRedactedDiagnosticLogs({
      logsDir,
      sessionId: sid,
      maxLines: 2,
      homeDir: home,
      env: {},
    });

    assert.equal(res.sessionId, sid);
    assert.equal(res.sessionSource, "explicit");
    assert.equal(res.filesScanned, 2);
    assert.equal(res.totalWarnErrorLines, 3);
    assert.equal(res.returnedLines, 2);
    assert.equal(res.truncated, true);
    assert.equal(res.entries[0].logger, "coms");
    assert.equal(res.entries[1].logger, "orchestrator");

    // Verify full set redacts secret & home path
    const all = collectRedactedDiagnosticLogs({
      logsDir,
      sessionId: sid,
      maxLines: 10,
      homeDir: home,
      env: {},
    });
    assert.equal(all.entries.length, 3);
    assert.ok(!all.entries[0].line.includes(token));
    assert.ok(!all.entries[0].line.includes(home));
    assert.match(all.entries[0].line, /\[REDACTED:GHTOKEN\]/);
    assert.match(all.entries[0].line, /path=~\/work/);
  });

  it("prefers __PI_PARENT_SESSION_ID over __PI_CONFIG_SESSION_ID when resolving from env", () => {
    const home = trackTempDir("diag-parent-sid-");
    const logsDir = join(home, ".pi", "logs");
    mkdirSync(join(logsDir, "orchestrator", "parent-sid"), { recursive: true });
    writeFileSync(
      join(logsDir, "orchestrator", "parent-sid", "main.log"),
      "2026-11-27T10:00:01.000Z [warn] [orchestrator] from parent session\n",
    );

    const res = collectRedactedDiagnosticLogs({
      logsDir,
      homeDir: home,
      env: {
        __PI_PARENT_SESSION_ID: "parent-sid",
        __PI_CONFIG_SESSION_ID: "child-sid",
      },
    });
    assert.equal(res.sessionId, "parent-sid");
    assert.equal(res.sessionSource, "env");
    assert.equal(res.returnedLines, 1);
    assert.match(res.entries[0].line, /from parent session/);
  });

  it("falls back to the most recently modified session when no session ID is provided", () => {
    const home = trackTempDir("diag-latest-sid-");
    const logsDir = join(home, ".pi", "logs");
    mkdirSync(join(logsDir, "orchestrator", "old-sid"), { recursive: true });
    mkdirSync(join(logsDir, "orchestrator", "new-sid"), { recursive: true });

    const oldFile = join(logsDir, "orchestrator", "old-sid", "main.log");
    const newFile = join(logsDir, "orchestrator", "new-sid", "main.log");
    writeFileSync(oldFile, "2026-11-27T09:00:00.000Z [error] [orchestrator] stale\n");
    writeFileSync(newFile, "2026-11-27T11:00:00.000Z [error] [orchestrator] fresh\n");
    const oldTime = new Date("2026-11-27T09:00:00Z");
    const newTime = new Date("2026-11-27T11:00:00Z");
    utimesSync(oldFile, oldTime, oldTime);
    utimesSync(newFile, newTime, newTime);

    const res = collectRedactedDiagnosticLogs({ logsDir, homeDir: home, env: {} });
    assert.equal(res.sessionId, "new-sid");
    assert.equal(res.sessionSource, "latest-fallback");
    assert.equal(res.returnedLines, 1);
    assert.match(res.entries[0].line, /fresh/);
  });

  it("skips symlinked log files and rejects traversal session IDs", () => {
    const home = trackTempDir("diag-symlink-");
    const logsDir = join(home, ".pi", "logs");
    const outsideFile = join(home, "secret.log");
    writeFileSync(outsideFile, "2026-11-27T10:00:00.000Z [error] [leak] should never be read\n");

    const sidDir = join(logsDir, "orchestrator", "sid-sym");
    mkdirSync(sidDir, { recursive: true });
    symlinkSync(outsideFile, join(sidDir, "evil.log"));

    const symRes = collectRedactedDiagnosticLogs({
      logsDir,
      sessionId: "sid-sym",
      homeDir: home,
      env: {},
    });
    assert.equal(symRes.filesScanned, 0);
    assert.equal(symRes.entries.length, 0);

    const travRes = collectRedactedDiagnosticLogs({
      logsDir,
      sessionId: "..",
      homeDir: home,
      env: {},
    });
    assert.equal(travRes.sessionId, null);
    assert.equal(travRes.filesScanned, 0);
  });

  it("handles a missing logs directory gracefully", () => {
    const home = trackTempDir("diag-missing-");
    const res = collectRedactedDiagnosticLogs({
      logsDir: join(home, "does-not-exist"),
      homeDir: home,
      env: {},
    });
    assert.equal(res.sessionSource, "none");
    assert.equal(res.filesScanned, 0);
    assert.deepEqual(res.entries, []);
  });
});

describe("parseCliArgs, parseRemoteRepoSlug, and collectDiagnosticReport", () => {
  it("parses CLI flags and bounds --max-lines", () => {
    const opts = parseCliArgs([
      "--cwd",
      "/tmp/proj",
      "--session-id",
      "s1",
      "--logs-dir",
      "/tmp/logs",
      "--max-lines",
      "25",
    ]);
    assert.equal(opts.sessionId, "s1");
    assert.equal(opts.maxLines, 25);

    const outOfRange = parseCliArgs(["--max-lines", "9999"]);
    assert.equal(outOfRange.maxLines, DEFAULT_MAX_LOG_LINES);
  });

  it("extracts owner/repo from SSH and HTTPS remotes without leaking credentials", () => {
    assert.equal(
      parseRemoteRepoSlug("git@github.com:myk-org/pi-config.git"),
      "myk-org/pi-config",
    );
    assert.equal(
      parseRemoteRepoSlug(["https://user:", "tok123456789", "@github.com/myk-org/pi-config.git"].join("")),
      "myk-org/pi-config",
    );
    assert.equal(parseRemoteRepoSlug("https://gitlab.example.test/group/repo.git"), null);
  });

  it("collects a complete redacted snapshot with stubbed command probes", () => {
    const home = trackTempDir("diag-report-");
    const cwd = join(home, "git", "pi-config");
    mkdirSync(cwd, { recursive: true });

    const execStub = (cmd: string, args: string[]) => {
      if (cmd === "pi") return "1.6.1\n";
      if (cmd === "myk-pi-tools") return "myk-pi-tools, version 6.0.1\n";
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "feat/test\n";
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--short") return "abc1234\n";
      if (cmd === "git" && args[0] === "status") return " M README.md\n";
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--show-toplevel") return `${cwd}\n`;
      if (cmd === "git" && args[0] === "remote") return "git@github.com:myk-org/pi-config.git\n";
      throw new Error("unexpected command");
    };

    const report = collectDiagnosticReport({
      cwd,
      homeDir: home,
      logsDir: join(home, ".pi", "logs"),
      env: {},
      execFn: execStub,
    });

    assert.equal(report.status, "collected");
    assert.equal(report.versions.pi, "1.6.1");
    assert.equal(report.versions.mykPiTools, "myk-pi-tools, version 6.0.1");
    assert.ok(report.versions.piOrchestratorConfig);
    assert.equal(report.git.cwd, "~/git/pi-config");
    assert.equal(report.git.repoRoot, "~/git/pi-config");
    assert.equal(report.git.remoteRepo, "myk-org/pi-config");
    assert.equal(report.git.branch, "feat/test");
    assert.equal(report.git.commit, "abc1234");
    assert.equal(report.git.dirty, true);
  });

  it("runs directly via plain node CLI and outputs redacted JSON", () => {
    const home = trackTempDir("diag-cli-");
    const logsDir = join(home, ".pi", "logs");
    const sid = "cli-sid";
    mkdirSync(join(logsDir, "orchestrator", sid), { recursive: true });
    const fakeKey = synth("AIza", "X", 35);
    writeFileSync(
      join(logsDir, "orchestrator", sid, "main.log"),
      `2026-11-27T12:00:00.000Z [error] [orchestrator] failed key=${fakeKey}\n`,
    );

    const scriptPath = new URL("../../../scripts/diagnostic-report-collect.mjs", import.meta.url).pathname;
    const res = spawnSync(
      process.execPath,
      [scriptPath, "--cwd", home, "--logs-dir", logsDir, "--session-id", sid],
      {
        encoding: "utf-8",
        env: { ...process.env, HOME: home, USERPROFILE: home },
      },
    );

    assert.equal(res.status, 0, res.stderr || res.stdout);
    const parsed = JSON.parse(res.stdout) as {
      status: string;
      logs: { returnedLines: number; entries: Array<{ line: string }> };
    };
    assert.equal(parsed.status, "collected");
    assert.equal(parsed.logs.returnedLines, 1);
    assert.ok(!parsed.logs.entries[0].line.includes(fakeKey));
    assert.match(parsed.logs.entries[0].line, /\[REDACTED:GOOGLEKEY\]/);
  });
});
