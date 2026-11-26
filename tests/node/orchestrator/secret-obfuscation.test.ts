/**
 * Unit tests for reversible secret obfuscation (issue #1413).
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  clearSettingsCache,
  SETTINGS_KEYS,
} from "../../../extensions/orchestrator/project-settings.js";
import {
  clearDynamicSecretStore,
  createSecretVault,
  MIN_SECRET_LENGTH,
  registerSecretObfuscation,
} from "../../../extensions/orchestrator/secret-obfuscation.js";
import type { Logger } from "../../../extensions/shared/logger.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

type Handler = (...args: any[]) => any;

function createFakeLogger(): { logger: Logger; entries: Array<{ level: string; args: any[] }> } {
  const entries: Array<{ level: string; args: any[] }> = [];
  const logger: Logger = {
    debug: (...args: any[]) => entries.push({ level: "debug", args }),
    info: (...args: any[]) => entries.push({ level: "info", args }),
    warn: (...args: any[]) => entries.push({ level: "warn", args }),
    error: (...args: any[]) => entries.push({ level: "error", args }),
    isDebugEnabled: () => true,
  };
  return { logger, entries };
}

function createHarness(opts?: { env?: NodeJS.ProcessEnv; homeDir?: string; logger?: Logger }) {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  } as any;

  const { getVault } = registerSecretObfuscation(pi, {
    env: opts?.env,
    homeDir: opts?.homeDir,
    log: opts?.logger,
  });

  async function emit(event: string, payload: any, ctx: any) {
    let last: any;
    for (const h of handlers.get(event) ?? []) {
      const res = await h(payload, ctx);
      if (res !== undefined) last = res;
    }
    return last;
  }

  return { emit, getVault };
}

/** Build synthetic credential-shaped strings at runtime so secret scanners never see literals. */
function makeUrlWithCred(scheme: string, user: string, pass: string, hostPath: string): string {
  return `${scheme}://${user}:${pass}@${hostPath}`;
}

const tempDirs: string[] = [];
function trackTempDir(prefix: string): string {
  const dir = makeTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  clearDynamicSecretStore();
  clearSettingsCache();
  delete process.env.PI_SECRET_OBFUSCATION;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("secret_obfuscation settings schema (#1413)", () => {
  it("defines secret_obfuscation with default false and PI_SECRET_OBFUSCATION env", () => {
    const def = SETTINGS_KEYS.secret_obfuscation;
    assert.ok(def, "secret_obfuscation key must exist in settings-keys.json");
    assert.equal(def.type, "bool");
    assert.equal(def.default, false);
    assert.equal(def.env, "PI_SECRET_OBFUSCATION");
    assert.equal(def.group, "Security");
  });
});

describe("SecretVault collection & redaction (#1413)", () => {
  it("collects secret-like env vars (>= 8 chars) and ignores short values and non-secret path vars", () => {
    const { logger } = createFakeLogger();
    const ghVal = ["gh", "val", "unit", "12345"].join("_");
    const exactEight = ["1234", "5678"].join("");
    const vault = createSecretVault({
      loadConfigFiles: false,
      log: logger,
      env: {
        GITHUB_TOKEN: ghVal,
        SHORT_KEY: "1234567", // 7 chars — below MIN_SECRET_LENGTH
        EXACT_8_PASS: exactEight, // exactly 8 chars — included
        NORMAL_VAR: "plain-non-sensitive-value",
        SSH_AUTH_SOCK: "/run/user/1000/ssh-agent.sock",
        XAUTHORITY: "/home/user/.Xauthority",
      },
    });

    assert.equal(MIN_SECRET_LENGTH, 8);
    const out = vault.obfuscateText(
      `tok=${ghVal} short=1234567 exact=${exactEight} norm=plain-non-sensitive-value sock=/run/user/1000/ssh-agent.sock xauth=/home/user/.Xauthority`,
    );

    assert.ok(!out.includes(ghVal), "GITHUB_TOKEN must be obfuscated");
    assert.match(out, /tok=\$\$GITHUBTOKEN_[a-f0-9]{10}\$\$/);
    assert.ok(out.includes("short=1234567"), "7-char secret must stay unredacted");
    assert.ok(!out.includes(`exact=${exactEight}`), "8-char secret must be obfuscated");
    assert.ok(out.includes("norm=plain-non-sensitive-value"), "non-secret env var untouched");
    assert.ok(out.includes("sock=/run/user/1000/ssh-agent.sock"), "SSH_AUTH_SOCK untouched");
    assert.ok(out.includes("xauth=/home/user/.Xauthority"), "XAUTHORITY untouched");
  });

  it("does not redact GIT_AUTHOR_*, GIT_COMMITTER_*, GIT_ASKPASS, or SSH_ASKPASS env vars", () => {
    const { logger } = createFakeLogger();
    const vault = createSecretVault({
      loadConfigFiles: false,
      log: logger,
      env: {
        GIT_AUTHOR_NAME: "Jane Developer",
        GIT_AUTHOR_EMAIL: "jane.developer@example.com",
        GIT_COMMITTER_NAME: "Jane Committer",
        GIT_ASKPASS: "/usr/libexec/git-core/git-gui--askpass",
        SSH_ASKPASS: "/usr/bin/ksshaskpass-helper",
        GCP_CREDENTIALS: ["gcp", "cred", "val", "998877"].join("_"),
      },
    });

    const sample =
      "Author: Jane Developer <jane.developer@example.com> Committer: Jane Committer ask=/usr/libexec/git-core/git-gui--askpass ssh=/usr/bin/ksshaskpass-helper";
    assert.equal(vault.obfuscateText(sample), sample, "identity and askpass env vars must stay unredacted");

    const credVal = ["gcp", "cred", "val", "998877"].join("_");
    const credOut = vault.obfuscateText(`cred=${credVal}`);
    assert.ok(!credOut.includes(credVal), "_-delimited CREDENTIALS token must still be collected");
  });

  it("protects emitted placeholders from being partially rewritten by later literals or custom regexes", () => {
    const { logger } = createFakeLogger();
    const openAiVal = ["sk", "-proj-", "abcdefghijklm", "nopqrstuvwxyz", "123456"].join("");
    const labelLit = ["OPENAI", "KEY"].join("");
    const vault = createSecretVault({
      loadConfigFiles: false,
      env: {
        LABEL_SECRET: labelLit, // literal equal to a generated placeholder label (9 chars >= 8)
      },
      entries: [
        { pattern: labelLit, label: "CUSTLBL", mode: "obfuscate" },
      ],
      log: logger,
    });

    const obf = vault.obfuscateText(`api=${openAiVal} bare=OPENAIKEY`);
    assert.ok(!obf.includes(openAiVal), "OpenAI key must be obfuscated");
    // The emitted $$OPENAIKEY_<hash>$$ placeholder must remain intact (not corrupted into $$...$$ inside $$...$$)
    const phMatch = obf.match(/^api=(\$\$OPENAIKEY_[a-f0-9]{10}\$\$) bare=(\$\$[A-Z0-9]+_[a-f0-9]{10}\$\$)$/);
    assert.ok(phMatch, `placeholders must remain intact without corruption; got: ${obf}`);
    assert.equal(vault.restoreText(obf), `api=${openAiVal} bare=OPENAIKEY`);
  });

  it("extracts passwords embedded in URL credentials from env and runtime text", () => {
    const { logger } = createFakeLogger();
    const envPass = ["envdb", "pass", "9876"].join("");
    const runtimePass = ["runtime", "Redis", "Pass42"].join("");
    const vault = createSecretVault({
      loadConfigFiles: false,
      log: logger,
      env: {
        DATABASE_URL: makeUrlWithCred("postgres", "admin", envPass, "db.internal:5432/prod"),
      },
    });

    const fromEnv = vault.obfuscateText(`Connecting with ${envPass} to DB`);
    assert.ok(!fromEnv.includes(envPass));
    assert.match(fromEnv, /\$\$DATABASEURL_[a-f0-9]{10}\$\$/);
    assert.equal(vault.restoreText(fromEnv), `Connecting with ${envPass} to DB`);

    const runtimeUrl = makeUrlWithCred("redis", "default", runtimePass, "cache.internal:6379/0");
    const fromRuntime = vault.obfuscateText(runtimeUrl);
    assert.ok(!fromRuntime.includes(runtimePass));
    assert.match(fromRuntime, /^redis:\/\/default:\$\$URLPASS_[a-f0-9]{10}\$\$@cache\.internal:6379\/0$/);
    assert.equal(vault.restoreText(fromRuntime), runtimeUrl);
  });

  it("redacts built-in credential patterns deterministically and restores them reversibly", () => {
    const { logger } = createFakeLogger();
    const vault = createSecretVault({ loadConfigFiles: false, env: {}, log: logger });

    const alpha = "abcdefghijklmnopqrstuvwxyz";
    const digits = "1234567890";
    const pemStart = ["-----BEGIN ", "RSA ", "PRIVATE KEY-----"].join("");
    const pemEnd = ["-----END ", "RSA ", "PRIVATE KEY-----"].join("");

    const samples = [
      { label: "GHTOKEN", val: ["ghp", "_", digits, alpha, "ABCD"].join("") },
      { label: "GLTOKEN", val: ["glpat", "-", alpha.slice(0, 24)].join("") },
      { label: "ANTHROPICKEY", val: ["sk", "-ant-api03-", alpha, digits.slice(0, 6)].join("") },
      { label: "OPENAIKEY", val: ["sk", "-proj-", alpha, digits.slice(0, 6)].join("") },
      { label: "AWSKEY", val: ["AKIA", "IOSFODNN7", "EXAMPLE"].join("") },
      { label: "GOOGLEKEY", val: ["AIza", "SyA", digits, alpha.slice(0, 22)].join("") },
      { label: "SLACKTOKEN", val: ["xoxb", "-", digits, "-", digits, "-", alpha.slice(0, 12)].join("") },
      { label: "NPMTOKEN", val: ["npm", "_", digits, alpha].join("") },
      { label: "STRIPEKEY", val: ["sk", "_live_", digits, alpha.slice(0, 16)].join("") },
      {
        label: "JWT",
        val: [
          ["eyJ", "hbGciOiJIUzI1NiJ9"].join(""),
          ["eyJ", "zdWIiOiIxMjM0NTY3ODkwIn0"].join(""),
          [alpha.slice(0, 16), digits.slice(0, 5)].join(""),
        ].join("."),
      },
      {
        label: "PEMKEY",
        val: `${pemStart}\n${["TEST", "KEY", "BODY", "DATA"].join("")}\n${pemEnd}`,
      },
    ];

    for (const { label, val } of samples) {
      const first = vault.obfuscateText(`prefix ${val} suffix`);
      const second = vault.obfuscateText(`prefix ${val} suffix`);
      assert.equal(first, second, `placeholder for ${label} must be deterministic`);
      assert.ok(!first.includes(val), `${label} must be redacted`);
      assert.match(first, new RegExp(`\\$\\$${label}_[a-f0-9]{10}\\$\\$`));
      // Running obfuscateText again must not double-obfuscate the placeholder.
      assert.equal(vault.obfuscateText(first), first, `${label} placeholder must be idempotent`);
      // Reversible restoration recovers exact original text.
      assert.equal(vault.restoreText(first), `prefix ${val} suffix`);
    }

    // Bearer token preserves "Bearer " prefix
    const bearerTok = ["bearer", "unit", "sample", "9876543210"].join("_");
    const bearerRaw = `Authorization: Bearer ${bearerTok}`;
    const bearerObf = vault.obfuscateText(bearerRaw);
    assert.match(bearerObf, /^Authorization: Bearer \$\$BEARER_[a-f0-9]{10}\$\$$/);
    assert.equal(vault.restoreText(bearerObf), bearerRaw);
  });

  it("supports .pi/secrets.jsonc and ~/.pi/agent/secrets.jsonc with obfuscate vs one-way replace modes", () => {
    const { logger } = createFakeLogger();
    const projectDir = trackTempDir("sec-proj-");
    const homeDir = trackTempDir("sec-home-");

    fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
    fs.mkdirSync(path.join(homeDir, ".pi", "agent"), { recursive: true });

    const globalRev = ["global", "reversible", "value"].join("-");
    const oneWayLit = ["oneway", "never", "restore"].join("-");
    const urlOneWay = ["url", "oneway", "pass"].join("-");

    fs.writeFileSync(
      path.join(homeDir, ".pi", "agent", "secrets.jsonc"),
      `{
        // Global config with comments
        "entries": [
          { "value": "${globalRev}", "label": "GLOBSEC", "mode": "obfuscate" },
          { "value": "tiny", "label": "SHORT", "mode": "obfuscate" },
          { "value": "${oneWayLit}", "mode": "replace", "replacement": "[SCRUBBED]" }
        ]
      }`,
    );

    fs.writeFileSync(
      path.join(projectDir, ".pi", "secrets.jsonc"),
      `{
        /* Project custom regex + one-way replace */
        "entries": [
          { "pattern": "ACME_[A-Z0-9]{12}", "label": "ACME", "mode": "obfuscate" },
          { "pattern": "SSN-\\\\d{3}-\\\\d{2}-\\\\d{4}", "mode": "replace", "replacement": "$$FAKE_1234567890$$" },
          { "value": "${urlOneWay}", "mode": "replace", "replacement": "[REDACTED]" }
        ]
      }`,
    );

    const vault = createSecretVault({
      cwd: projectDir,
      homeDir,
      env: {},
      log: logger,
    });

    // Global reversible works and restores
    const gObf = vault.obfuscateText(`val=${globalRev}`);
    assert.match(gObf, /^val=\$\$GLOBSEC_[a-f0-9]{10}\$\$$/);
    assert.equal(vault.restoreText(gObf), `val=${globalRev}`);

    // Short (<8) value in obfuscate mode is skipped
    assert.equal(vault.obfuscateText("tiny"), "tiny");

    // Project custom regex obfuscate works and restores
    const pObf = vault.obfuscateText("key=ACME_ABCDEF123456");
    assert.match(pObf, /^key=\$\$ACME_[a-f0-9]{10}\$\$$/);
    assert.equal(vault.restoreText(pObf), "key=ACME_ABCDEF123456");

    // One-way replace literal is scrubbed and NEVER restored
    const rLit = vault.obfuscateText(`item=${oneWayLit}`);
    assert.equal(rLit, "item=[SCRUBBED]");
    assert.equal(vault.restoreText(rLit), "item=[SCRUBBED]");

    // One-way replace regex even with placeholder-like output is NEVER restored
    const rReg = vault.obfuscateText("id=SSN-123-45-6789");
    assert.equal(rReg, "id=$$FAKE_1234567890$$");
    assert.equal(vault.restoreText(rReg), "id=$$FAKE_1234567890$$");

    // One-way replace inside a URL does not get re-obfuscated as a reversible URL password
    const rUrl = vault.obfuscateText(makeUrlWithCred("postgres", "alice", urlOneWay, "db.local/app"));
    assert.equal(rUrl, "postgres://alice:[REDACTED]@db.local/app");
    assert.equal(vault.restoreText(rUrl), "postgres://alice:[REDACTED]@db.local/app");
  });

  it("replaces longest literal secret first and avoids partial corruption", () => {
    const { logger } = createFakeLogger();
    const shortVal = ["base", "item", "1234"].join("_");
    const longVal = [shortVal, "extended", "9999"].join("_");
    const vault = createSecretVault({
      loadConfigFiles: false,
      env: {
        SHORT_TOKEN: shortVal,
        LONG_TOKEN: longVal,
      },
      log: logger,
    });

    const obf = vault.obfuscateText(`a=${longVal} b=${shortVal}`);
    assert.ok(!obf.includes(shortVal));
    assert.ok(!obf.includes("_extended_9999"));
    assert.equal(vault.restoreText(obf), `a=${longVal} b=${shortVal}`);
  });
});

describe("registerSecretObfuscation extension hooks (#1413)", () => {
  it("is a complete no-op when secret_obfuscation is disabled (default)", async () => {
    const cwd = trackTempDir("sec-off-");
    const { logger } = createFakeLogger();
    const disabledVal = ["ghp", "_", "disabled", "0000000000111111111122222222"].join("");
    const { emit, getVault } = createHarness({
      env: { GITHUB_TOKEN: disabledVal },
      homeDir: cwd,
      logger,
    });

    await emit("session_start", {}, { cwd });
    assert.equal(getVault(), null);

    const res = await emit(
      "tool_result",
      {
        toolName: "bash",
        content: [{ type: "text", text: `val=${disabledVal}` }],
      },
      { cwd },
    );
    assert.equal(res, undefined);
  });

  it("performs full tool_result obfuscation -> tool_call restoration round-trip and never mutates system prompts", async () => {
    const cwd = trackTempDir("sec-on-");
    const homeDir = trackTempDir("sec-on-home-");
    const { logger } = createFakeLogger();
    const oneWayVal = ["oneway", "item", "9999"].join("-");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".pi", "pi-config-settings.json"),
      JSON.stringify({ secret_obfuscation: true }),
    );
    fs.writeFileSync(
      path.join(cwd, ".pi", "secrets.jsonc"),
      JSON.stringify({
        entries: [{ value: oneWayVal, mode: "replace", replacement: "[ONEWAY]" }],
      }),
    );

    const apiVal = ["myapi", "unit", "value", "12345678"].join("_");
    const { emit } = createHarness({
      env: { MY_API_TOKEN: apiVal },
      homeDir,
      logger,
    });

    await emit("session_start", {}, { cwd });

    // 1. tool_result redacts both text content and structuredContent
    const toolRes = await emit(
      "tool_result",
      {
        toolName: "bash",
        content: [{ type: "text", text: `val=${apiVal} other=${oneWayVal}` }],
        structuredContent: { nested: { auth: `Bearer ${apiVal}` } },
      },
      { cwd },
    );
    assert.ok(toolRes, "tool_result should return redacted payload");
    const obfText = toolRes.content[0].text as string;
    assert.ok(!obfText.includes(apiVal));
    assert.ok(obfText.includes("[ONEWAY]"));
    const match = obfText.match(/\$\$MYAPITOKEN_[a-f0-9]{10}\$\$/);
    assert.ok(match, "placeholder should be present");
    const placeholder = match[0];
    assert.equal(toolRes.structuredContent.nested.auth, `Bearer ${placeholder}`);

    // 2. tool_call restores reversible placeholder in nested arguments (in place), never restores one-way token
    const callEvent = {
      type: "tool_call",
      toolName: "bash",
      input: {
        command: `curl -H "Authorization: Bearer ${placeholder}" https://example.com`,
        nested: { list: [placeholder, "[ONEWAY]"] },
      },
    };
    await emit("tool_call", callEvent, { cwd });
    assert.equal(
      callEvent.input.command,
      `curl -H "Authorization: Bearer ${apiVal}" https://example.com`,
    );
    assert.deepEqual(callEvent.input.nested.list, [apiVal, "[ONEWAY]"]);

    // 3. context hook redacts user/assistant/toolResult messages WITHOUT mutating system prompts
    const systemMsg = {
      role: "system",
      content: `Static system prompt mentioning ${apiVal} must stay cache-identical`,
    };
    const userMsg = {
      role: "user",
      content: `Use value ${apiVal} please`,
    };
    const ctxRes = await emit("context", { type: "context", messages: [systemMsg, userMsg] }, { cwd });
    assert.ok(ctxRes?.messages, "context hook should return updated messages");
    assert.strictEqual(ctxRes.messages[0], systemMsg, "system message must remain identical reference");
    assert.ok(
      (ctxRes.messages[0].content as string).includes(apiVal),
      "static system prompt must never be mutated",
    );
    assert.equal(ctxRes.messages[1].content, `Use value ${placeholder} please`);
  });

  it("retains dynamically discovered placeholders across /reload and cwd changes, clears on shutdown, and blocks unresolved placeholders", async () => {
    const cwd1 = trackTempDir("sec-reload-1-");
    const cwd2 = trackTempDir("sec-reload-2-");
    const homeDir = trackTempDir("sec-reload-home-");
    const { logger } = createFakeLogger();

    for (const dir of [cwd1, cwd2]) {
      fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, ".pi", "pi-config-settings.json"),
        JSON.stringify({ secret_obfuscation: true }),
      );
    }

    const { emit } = createHarness({ env: {}, homeDir, logger });
    const ctx1 = { cwd: cwd1, sessionManager: { getSessionId: () => "sess-reload" } };
    const ctx2 = { cwd: cwd2, sessionManager: { getSessionId: () => "sess-reload" } };

    await emit("session_start", {}, ctx1);

    // Dynamically discover a GitHub token from tool_result (NOT in env!)
    const dynamicTok = ["ghp", "_", "1234567890", "abcdefghijklmnopqrstuvwxyz", "WXYZ"].join("");
    const toolRes = await emit(
      "tool_result",
      {
        toolName: "bash",
        content: [{ type: "text", text: `found=${dynamicTok}` }],
      },
      ctx1,
    );
    const placeholder = (toolRes.content[0].text as string).match(/\$\$GHTOKEN_[a-f0-9]{10}\$\$/)?.[0];
    assert.ok(placeholder, "dynamic token should be obfuscated");

    // Simulate reload + cwd change: placeholder must STILL restore!
    await emit("session_shutdown", { reason: "reload" }, ctx1);
    await emit("session_start", { reason: "reload" }, ctx2);

    const callAfterReload = {
      type: "tool_call",
      toolName: "bash",
      input: { command: `echo ${placeholder}` },
    };
    const resAfterReload = await emit("tool_call", callAfterReload, ctx2);
    assert.equal(resAfterReload, undefined, "resolved placeholder after reload must not be blocked");
    assert.equal(callAfterReload.input.command, `echo ${dynamicTok}`);

    // Real shutdown (not reload) clears dynamic mappings; subsequent unresolved placeholder is BLOCKED!
    await emit("session_shutdown", { reason: "exit" }, ctx2);
    await emit("session_start", { reason: "startup" }, ctx2);

    const callAfterShutdown = {
      type: "tool_call",
      toolName: "bash",
      input: { command: `curl -H "Authorization: Bearer ${placeholder}" https://example.com` },
    };
    const blocked = await emit("tool_call", callAfterShutdown, ctx2);
    assert.ok(blocked?.block, "unresolved placeholder must be blocked instead of passing $$ to bash");
    assert.match(blocked.reason, /Unresolved secret placeholder/);
  });
});
