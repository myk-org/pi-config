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
  it("declares YAML frontmatter with description and argument-hint", () => {
    assert.match(REPORT_PROMPT, /^---\ndescription: /);
    assert.match(REPORT_PROMPT, /argument-hint: "\[issue summary\]"/);
  });

  it("preserves the raw arguments block", () => {
    assert.match(REPORT_PROMPT, /## Raw Arguments\n\n```text\n\$ARGUMENTS\n```/);
  });

  it("resolves the packaged collector independently of the current git checkout", () => {
    assert.match(
      REPORT_PROMPT,
      /COLLECTOR="\$HOME\/\.pi\/agent\/npm\/node_modules\/pi-orchestrator-config\/scripts\/diagnostic-report-collect\.mjs"/,
    );
    assert.doesNotMatch(REPORT_PROMPT, /GIT_ROOT\/scripts\/diagnostic-report-collect\.mjs/);
    assert.match(REPORT_PROMPT, /ask_user.*checkout-local|checkout-local.*ask_user/s);
    assert.match(REPORT_PROMPT, /--max-lines 40/);
  });

  it("defines the 4-step diagnostic workflow with docs check, duplicate search, and ask_user gate", () => {
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

describe("skills/bug-report/SKILL.md contract (#1446)", () => {
  it("defines the bug-report skill frontmatter", () => {
    assert.match(BUG_REPORT_SKILL, /^---\nname: bug-report\n/);
  });

  it("uses the packaged collector by default and requires ask_user before checkout-local execution", () => {
    assert.match(
      BUG_REPORT_SKILL,
      /COLLECTOR="\$HOME\/\.pi\/agent\/npm\/node_modules\/pi-orchestrator-config\/scripts\/diagnostic-report-collect\.mjs"/,
    );
    assert.doesNotMatch(BUG_REPORT_SKILL, /GIT_ROOT\/scripts\/diagnostic-report-collect\.mjs/);
    assert.match(BUG_REPORT_SKILL, /ask_user.*checkout-local/s);
    assert.match(BUG_REPORT_SKILL, /gh issue list/);
  });

  it("includes diagnostic collector and supporting directories in package.json files", () => {
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

  it("redacts truncated PEM private key blocks", () => {
    const ecBegin = ["-----BEGIN ", "EC PRIVATE KEY-----"].join("");
    const out = redactDiagnosticText(`${ecBegin}\\nPARTIALKEYDATA`, { env: {}, homeDir: "/home/tester" });
    assert.ok(!out.includes("PARTIALKEYDATA"));
    assert.match(out, /\[REDACTED:PEMKEY\]/);
  });

  it("redacts quoted secrets containing escaped quotes without leaking trailing text", () => {
    const key = "pass" + "word";
    const line = JSON.stringify({ [key]: 'abc"trailing_secret_tail', status: "ok" });
    const out = redactDiagnosticText(line, { env: {}, homeDir: "/home/tester" });

    assert.ok(!out.includes("abc"));
    assert.ok(!out.includes("trailing_secret_tail"));
    assert.match(out, /"status":"ok"/);
  });

  it("redacts structured JSON authorization and cookie fields", () => {
    const payload = JSON.stringify({
      authorization: "Basic " + "dXNlcjpwYXNzMTIz",
      "proxy-authorization": "Basic " + "cHJveHk6c2VjcmV0",
      cookie: "session_id=" + "abc123xyz789",
      "set-cookie": "sid=" + "def456uvw012; HttpOnly",
      ok: true,
    });
    const out = redactDiagnosticText(payload, { env: {}, homeDir: "/home/tester" });

    for (const leaked of ["dXNlcjpwYXNzMTIz", "cHJveHk6c2VjcmV0", "abc123xyz789", "def456uvw012"]) {
      assert.ok(!out.includes(leaked), `expected header value redacted: ${leaked}`);
    }
    assert.match(out, /"ok":true/);
  });

  it("redacts raw Authorization and Cookie header lines", () => {
    const raw = [
      "2026-11-27T10:00:00.000Z [warn] [http] Authorization: Basic " + "dXNlcjpwYXNzMTIz",
      "2026-11-27T10:00:01.000Z [warn] [http] Cookie: session_id=" + "abc123xyz789",
    ].join("\n");
    const out = redactDiagnosticText(raw, { env: {}, homeDir: "/home/tester" });

    assert.ok(!out.includes("dXNlcjpwYXNzMTIz"));
    assert.ok(!out.includes("abc123xyz789"));
    assert.match(out, /Authorization: Basic \[REDACTED:AUTH\]/);
    assert.match(out, /Cookie: \[REDACTED:COOKIE\]/);
  });

  it("redacts bare secret values containing closing brackets and braces", () => {
    const kPass = "pass" + "word";
    const out = redactDiagnosticText(
      `${kPass}=abc]SECRET_TAIL1 ${kPass}=abc}SECRET_TAIL2 {"api_key":123456}`,
      { env: {}, homeDir: "/home/tester" },
    );

    assert.ok(!out.includes("SECRET_TAIL1"));
    assert.ok(!out.includes("SECRET_TAIL2"));
    assert.ok(!out.includes("123456"));
    assert.equal(out, `${kPass}=[REDACTED] ${kPass}=[REDACTED] {"api_key":[REDACTED]}`);
  });

  it("redacts short passwords and numeric secret codes while preserving benign booleans and counts", () => {
    const kPass = "pass" + "word";
    const kKey = "api_" + "key";
    const raw = JSON.stringify({
      [kPass]: "ab",
      pwd: "123",
      [kKey]: 987654,
      secret: false,
      tokenCount: 42,
    });
    const out = redactDiagnosticText(raw, { env: {}, homeDir: "/home/tester" });

    assert.ok(!out.includes('"ab"'));
    assert.ok(!out.includes('"123"'));
    assert.ok(!out.includes("987654"));
    assert.match(out, /"secret":false/);
    assert.match(out, /"tokenCount":42/);
  });

  it("redacts config-sourced credential fields absent from process.env", () => {
    const kCred = "service_" + "credentials";
    const kBot = "discord_bot_" + "token";
    const kPhrase = "pass" + "phrase";
    const payload = JSON.stringify({
      [kCred]: "cfg_cred_not_in_env_999",
      [kBot]: "cfg_bot_val_888",
      [kPhrase]: "cfg_phrase_777",
      memory_token_budget: 1700,
    });
    const out = redactDiagnosticText(payload, { env: {}, homeDir: "/home/tester" });

    assert.ok(!out.includes("cfg_cred_not_in_env_999"));
    assert.ok(!out.includes("cfg_bot_val_888"));
    assert.ok(!out.includes("cfg_phrase_777"));
    assert.match(out, /"memory_token_budget":1700/);
  });

  it("redacts secret environment variable values and embedded URL passwords", () => {
    const customSecret = ["x9k2", "custom", "internal", "value", "99"].join("_");
    const dbPass = ["db", "secret", "pass", "42"].join("_");
    const env: Record<string, string> = {
      ["MY_SERVICE_" + "API_KEY"]: customSecret,
      DATABASE_URL: ["postgres://svc:", dbPass, "@db.internal:5432/app"].join(""),
    };

    const out = redactDiagnosticText(`failed with ${customSecret} and ${dbPass}`, {
      env,
      homeDir: "/home/jane",
    });
    assert.ok(!out.includes(customSecret));
    assert.ok(!out.includes(dbPass));
  });

  it("preserves ignored non-secret environment variables such as GIT_AUTHOR_NAME", () => {
    const out = redactDiagnosticText("author=Jane Developer", {
      env: { GIT_AUTHOR_NAME: "Jane Developer" },
      homeDir: "/home/jane",
    });
    assert.match(out, /Jane Developer/);
  });

  it("replaces local, POSIX, and Windows home paths with tilde", () => {
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
  it("collects bounded warn and error lines sorted chronologically across loggers", () => {
    const home = trackTempDir("diag-logs-home-");
    const logsDir = join(home, ".pi", "logs");
    const sid = "sess-1446";
    mkdirSync(join(logsDir, "orchestrator", sid), { recursive: true });
    mkdirSync(join(logsDir, "coms", sid), { recursive: true });

    writeFileSync(
      join(logsDir, "orchestrator", sid, "main.log"),
      [
        "2026-11-27T10:00:00.000Z [info] [orchestrator] info line must be skipped",
        "2026-11-27T10:00:01.000Z [warn] [orchestrator] first warning",
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
      fallbackLogsDirs: [],
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
    assert.equal(res.entries[0].scope, "session");
    assert.equal(res.entries[1].logger, "orchestrator");
  });

  it("truncates long warn lines to maxLineChars after redacting secrets spanning the cut point", () => {
    const home = trackTempDir("diag-truncate-");
    const logsDir = join(home, ".pi", "logs");
    const sid = "sess-trunc";
    mkdirSync(join(logsDir, "orchestrator", sid), { recursive: true });

    // Place a 40-char secret straddling the 75-char cut point (index 51..91) so redaction must run BEFORE slicing.
    const spanningSecret = synth("ghp_", "Q", 36);
    writeFileSync(
      join(logsDir, "orchestrator", sid, "main.log"),
      `2026-11-27T10:00:01.000Z [warn] [orchestrator] tok=${spanningSecret} ${"x".repeat(80)}\n`,
    );

    const res = collectRedactedDiagnosticLogs({
      logsDir,
      fallbackLogsDirs: [],
      sessionId: sid,
      maxLineChars: 90,
      homeDir: home,
      env: {},
    });

    assert.equal(res.entries.length, 1);
    const line = res.entries[0].line;
    assert.equal(line.length, 90);
    assert.ok(line.endsWith("... [truncated]"));
    assert.ok(!line.includes("ghp_"));
    assert.ok(!line.includes("QQQQ"));
    assert.match(line, /\[REDACTED:GHTOKEN\]/);
  });

  it("does not misclassify canonical info lines containing error text as errors", () => {
    const home = trackTempDir("diag-info-noise-");
    const logsDir = join(home, ".pi", "logs");
    const sid = "sess-info";
    mkdirSync(join(logsDir, "orchestrator", sid), { recursive: true });

    writeFileSync(
      join(logsDir, "orchestrator", sid, "main.log"),
      [
        '2026-11-27T10:00:00.000Z [info] [orchestrator] handled [error] payload {"level":"error"}',
        "2026-11-27T10:00:01.000Z info vertex handled [error] text",
        "2026-11-27T10:00:02.000Z [warn] [orchestrator] actual warning",
      ].join("\n") + "\n",
    );

    const res = collectRedactedDiagnosticLogs({
      logsDir,
      fallbackLogsDirs: [],
      sessionId: sid,
      homeDir: home,
      env: {},
    });

    assert.equal(res.entries.length, 1);
    assert.equal(res.entries[0].level, "warn");
    assert.match(res.entries[0].line, /actual warning/);
  });

  it("redacts credential-like values in emitted sessionId, logger, and file metadata", () => {
    const home = trackTempDir("diag-meta-redact-");
    const logsDir = join(home, ".pi", "logs");
    const secretSid = synth("ghp_", "S", 36);
    const secretLogger = synth("npm_", "L", 36);
    const secretFile = `${synth("AIza", "F", 35)}.log`;
    mkdirSync(join(logsDir, secretLogger, secretSid), { recursive: true });
    writeFileSync(
      join(logsDir, secretLogger, secretSid, secretFile),
      "2026-11-27T10:00:00.000Z [error] [mod] boom\n",
    );

    const res = collectRedactedDiagnosticLogs({
      logsDir,
      fallbackLogsDirs: [],
      sessionId: secretSid,
      homeDir: home,
      env: {},
    });

    assert.equal(res.entries.length, 1);
    assert.ok(!String(res.sessionId).includes(secretSid));
    assert.ok(!res.entries[0].logger.includes(secretLogger));
    assert.ok(!res.entries[0].file.includes(secretLogger));
    assert.ok(!res.entries[0].file.includes(secretFile.slice(0, -4)));
    assert.match(String(res.sessionId), /\[REDACTED:GHTOKEN\]/);
    assert.match(res.entries[0].logger, /\[REDACTED:NPMTOKEN\]/);
    assert.match(res.entries[0].file, /\[REDACTED:GOOGLEKEY\]/);
  });

  it("discovers flat Vertex session logs and parses unbracketed warn and error lines", () => {
    const home = trackTempDir("diag-vertex-");
    const logsDir = join(home, ".pi", "logs");
    const sid = "vertex-sid-1";
    mkdirSync(join(logsDir, "pi-vertex-claude"), { recursive: true });
    writeFileSync(
      join(logsDir, "pi-vertex-claude", `${sid}.log`),
      [
        "2026-11-27T10:00:00.000Z info request started",
        "2026-11-27T10:00:01.000Z warn vertex quota approaching limit",
        "2026-11-27T10:00:02.000Z error vertex stream aborted",
      ].join("\n") + "\n",
    );

    const res = collectRedactedDiagnosticLogs({
      logsDir,
      fallbackLogsDirs: [],
      sessionId: sid,
      homeDir: home,
      env: {},
    });

    assert.equal(res.filesScanned, 1);
    assert.equal(res.entries.length, 2);
    assert.equal(res.entries[0].logger, "pi-vertex-claude");
    assert.equal(res.entries[0].level, "warn");
    assert.equal(res.entries[1].level, "error");
    assert.match(res.entries[1].line, /vertex stream aborted/);
  });

  it("selects a flat Vertex session log during latest-session fallback", () => {
    const home = trackTempDir("diag-vertex-latest-");
    const logsDir = join(home, ".pi", "logs");
    mkdirSync(join(logsDir, "orchestrator", "older-sid"), { recursive: true });
    mkdirSync(join(logsDir, "pi-vertex-claude"), { recursive: true });

    const olderFile = join(logsDir, "orchestrator", "older-sid", "main.log");
    const vertexFile = join(logsDir, "pi-vertex-claude", "newer-vertex-sid.log");
    writeFileSync(olderFile, "2026-11-27T09:00:00.000Z [error] [orchestrator] old\n");
    writeFileSync(vertexFile, "2026-11-27T11:00:00.000Z error latest vertex failure\n");
    const oldTime = new Date("2026-11-27T09:00:00Z");
    const newTime = new Date("2026-11-27T11:00:00Z");
    utimesSync(olderFile, oldTime, oldTime);
    utimesSync(vertexFile, newTime, newTime);

    const res = collectRedactedDiagnosticLogs({
      logsDir,
      fallbackLogsDirs: [],
      homeDir: home,
      env: {},
    });
    assert.equal(res.sessionId, "newer-vertex-sid");
    assert.equal(res.sessionSource, "latest-fallback");
    assert.equal(res.entries.length, 1);
    assert.match(res.entries[0].line, /latest vertex failure/);
  });

  it("rejects non-date JSON timestamps containing secrets and home paths", () => {
    const home = trackTempDir("diag-json-ts-");
    const logsDir = join(home, ".pi", "logs");
    const sid = "sess-json-ts";
    const secretTok = synth("ghp_", "T", 36);
    mkdirSync(join(logsDir, "orchestrator", sid), { recursive: true });
    writeFileSync(
      join(logsDir, "orchestrator", sid, "main.log"),
      `${JSON.stringify({ level: "warn", timestamp: `${home}/secret ${secretTok}`, msg: "oops" })}\n`,
    );

    const res = collectRedactedDiagnosticLogs({
      logsDir,
      fallbackLogsDirs: [],
      sessionId: sid,
      homeDir: home,
      env: {},
    });

    assert.equal(res.entries.length, 1);
    assert.equal(res.entries[0].timestamp, null);
    assert.ok(!res.entries[0].line.includes(secretTok));
    assert.ok(!res.entries[0].line.includes(home));
    assert.match(res.entries[0].line, /\[REDACTED:GHTOKEN\]/);
  });

  it("sorts JSON log timestamps with timezone offsets by numeric instant", () => {
    const home = trackTempDir("diag-tz-sort-");
    const logsDir = join(home, ".pi", "logs");
    const sid = "sess-tz";
    mkdirSync(join(logsDir, "orchestrator", sid), { recursive: true });
    writeFileSync(
      join(logsDir, "orchestrator", sid, "main.log"),
      [
        JSON.stringify({ level: "warn", timestamp: "2026-11-27T15:00:00-05:00", msg: "actually later (20:00Z)" }),
        JSON.stringify({ level: "warn", timestamp: "2026-11-27T16:00:00Z", msg: "actually earlier (16:00Z)" }),
      ].join("\n") + "\n",
    );

    const res = collectRedactedDiagnosticLogs({
      logsDir,
      fallbackLogsDirs: [],
      sessionId: sid,
      maxLines: 1,
      homeDir: home,
      env: {},
    });

    assert.equal(res.entries.length, 1);
    assert.equal(res.entries[0].timestamp, "2026-11-27T15:00:00-05:00");
    assert.match(res.entries[0].line, /actually later/);
  });

  it("selects only the resolved session from real file-logger fallback output", async () => {
    const home = trackTempDir("diag-fallback-real-home-");
    const projectDir = trackTempDir("diag-fallback-real-proj-");
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const prevCwd = process.cwd();
    const prevSid = process.env.__PI_CONFIG_SESSION_ID;
    const prevParentSid = process.env.__PI_PARENT_SESSION_ID;
    const prevGlobalSid = (globalThis as { __piConfigSessionId?: string }).__piConfigSessionId;

    try {
      // Force file-logger onto its project fallback path by blocking ~/.pi/logs with a file.
      mkdirSync(join(home, ".pi"), { recursive: true });
      writeFileSync(join(home, ".pi", "logs"), "not-a-dir");
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      delete process.env.__PI_PARENT_SESSION_ID;
      process.chdir(projectDir);

      const fileLogger = await import(`../../../extensions/shared/file-logger.ts?diag=${Date.now()}`);
      fileLogger.setGlobalSessionId("sess-current");
      assert.equal(fileLogger.fileLog("orchestrator", "warn", "orchestrator", "primary log dir blocked"), true);

      fileLogger.setGlobalSessionId("sess-current-2");
      assert.equal(fileLogger.fileLog("orchestrator", "error", "orchestrator", "unrelated sibling session"), true);

      const res = collectRedactedDiagnosticLogs({
        cwd: projectDir,
        logsDir: join(home, ".pi", "logs"),
        sessionId: "sess-current",
        homeDir: home,
        env: {},
      });

      assert.equal(res.entries.length, 1);
      assert.equal(res.entries[0].scope, "fallback-project");
      assert.equal(res.entries[0].level, "warn");
      assert.match(res.entries[0].line, /primary log dir blocked/);
      assert.ok(!res.entries[0].line.includes("unrelated sibling session"));
    } finally {
      process.chdir(prevCwd);
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevUserProfile;
      if (prevSid === undefined) delete process.env.__PI_CONFIG_SESSION_ID;
      else process.env.__PI_CONFIG_SESSION_ID = prevSid;
      if (prevParentSid === undefined) delete process.env.__PI_PARENT_SESSION_ID;
      else process.env.__PI_PARENT_SESSION_ID = prevParentSid;
      if (prevGlobalSid === undefined) delete (globalThis as { __piConfigSessionId?: string }).__piConfigSessionId;
      else (globalThis as { __piConfigSessionId?: string }).__piConfigSessionId = prevGlobalSid;
    }
  });

  it("collects unscoped entries from project and home fallback log directories", () => {
    const home = trackTempDir("diag-fallback-home-");
    const projectDir = trackTempDir("diag-fallback-proj-");
    const projFallback = join(projectDir, ".pi", "tmp", "pi-logs");
    const homeFallback = join(home, ".pi", "tmp", "pi-logs");
    mkdirSync(projFallback, { recursive: true });
    mkdirSync(homeFallback, { recursive: true });

    writeFileSync(
      join(projFallback, "orchestrator.log"),
      "2026-11-27T10:00:01.000Z [warn] [orchestrator] project fallback warn\n",
    );
    writeFileSync(
      join(homeFallback, "providers.log"),
      "2026-11-27T10:00:02.000Z [error] [providers] home fallback error\n",
    );

    const res = collectRedactedDiagnosticLogs({
      cwd: projectDir,
      logsDir: join(home, ".pi", "missing-logs"),
      homeDir: home,
      env: {},
    });

    assert.equal(res.fallbackFilesScanned, 2);
    assert.equal(res.entries.length, 2);
    assert.equal(res.entries[0].scope, "fallback-project");
    assert.match(res.entries[0].line, /project fallback warn/);
    assert.equal(res.entries[1].scope, "fallback-home");
    assert.match(res.entries[1].line, /home fallback error/);
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
      fallbackLogsDirs: [],
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

  it("does not read symlinked log files", () => {
    const home = trackTempDir("diag-symlink-");
    const logsDir = join(home, ".pi", "logs");
    const outsideFile = join(home, "secret.log");
    writeFileSync(outsideFile, "2026-11-27T10:00:00.000Z [error] [leak] should never be read\n");

    const sidDir = join(logsDir, "orchestrator", "sid-sym");
    mkdirSync(sidDir, { recursive: true });
    symlinkSync(outsideFile, join(sidDir, "evil.log"));

    const res = collectRedactedDiagnosticLogs({
      logsDir,
      fallbackLogsDirs: [],
      sessionId: "sid-sym",
      homeDir: home,
      env: {},
    });
    assert.equal(res.filesScanned, 0);
    assert.equal(res.entries.length, 0);
  });

  it("rejects traversal session IDs", () => {
    const home = trackTempDir("diag-traversal-");
    const logsDir = join(home, ".pi", "logs");
    mkdirSync(join(logsDir, "orchestrator"), { recursive: true });

    const res = collectRedactedDiagnosticLogs({
      logsDir,
      fallbackLogsDirs: [],
      sessionId: "..",
      homeDir: home,
      env: {},
    });
    assert.equal(res.sessionId, null);
    assert.equal(res.filesScanned, 0);
  });

  it("returns an empty collection when the logs directory does not exist", () => {
    const home = trackTempDir("diag-missing-");
    const res = collectRedactedDiagnosticLogs({
      logsDir: join(home, "does-not-exist"),
      fallbackLogsDirs: [],
      homeDir: home,
      env: {},
    });
    assert.equal(res.sessionSource, "none");
    assert.equal(res.filesScanned, 0);
    assert.deepEqual(res.entries, []);
  });
});

describe("parseCliArgs", () => {
  it("parses valid CLI flags", () => {
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
  });

  it("falls back to default maxLines when --max-lines is out of range", () => {
    const outOfRange = parseCliArgs(["--max-lines", "9999"]);
    assert.equal(outOfRange.maxLines, DEFAULT_MAX_LOG_LINES);
  });
});

describe("parseRemoteRepoSlug", () => {
  it("extracts owner/repo from SSH remotes", () => {
    assert.equal(
      parseRemoteRepoSlug("git@github.com:myk-org/pi-config.git"),
      "myk-org/pi-config",
    );
  });

  it("strips credentials from HTTPS remotes before extracting owner/repo", () => {
    assert.equal(
      parseRemoteRepoSlug(["https://user:", "tok123456789", "@github.com/myk-org/pi-config.git"].join("")),
      "myk-org/pi-config",
    );
  });

  it("returns null for non-GitHub remotes", () => {
    assert.equal(parseRemoteRepoSlug("https://gitlab.example.test/group/repo.git"), null);
  });
});

describe("collectDiagnosticReport", () => {
  it("collects a redacted runtime snapshot from stubbed command probes", () => {
    const home = trackTempDir("diag-report-");
    const cwd = join(home, "git", "pi-config");
    mkdirSync(cwd, { recursive: true });

    const execStub = (cmd: string, args: string[]) => {
      if (cmd === "pi") return "1.7.0\n";
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
      fallbackLogsDirs: [],
      env: {},
      execFn: execStub,
    });

    assert.equal(report.status, "collected");
    assert.equal(report.versions.pi, "1.7.0");
    assert.equal(report.versions.mykPiTools, "myk-pi-tools, version 6.0.1");
    assert.ok(report.versions.piOrchestratorConfig);
    assert.equal(report.git.cwd, "~/git/pi-config");
    assert.equal(report.git.repoRoot, "~/git/pi-config");
    assert.equal(report.git.remoteRepo, "myk-org/pi-config");
    assert.equal(report.git.branch, "feat/test");
    assert.equal(report.git.commit, "abc1234");
    assert.equal(report.git.dirty, true);
  });

  it("emits redacted JSON when executed directly via node CLI", () => {
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
