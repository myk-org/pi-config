/**
 * Unit tests for declarative `tool_permissions` glob/annotation rules,
 * domain-scoped `fetch_content` approvals, HMAC-authenticated SQLite host grants,
 * `/forget-approvals`, headless fail-closed behavior, and non-weakening guarantees (#1450).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import {
  clearTrackedSettingsCache,
  evaluateBashPolicy,
  evaluateFileWritePolicy,
} from "../../../extensions/orchestrator/bash-policy.js";
import { registerEnforcement } from "../../../extensions/orchestrator/enforcement.js";
import {
  clearSettingsCache,
  getSetting,
  parseSettingInput,
  SETTINGS_KEYS,
  setGlobalSettingsPath,
  validateSetting,
} from "../../../extensions/orchestrator/project-settings.js";
import {
  clearRestrictedFoldersFloor,
  setApprovalHmacKeyPathForTests,
} from "../../../extensions/orchestrator/restricted-folders.js";
import {
  closeStateDbs,
  CURRENT_SCHEMA_VERSION,
  getProjectStateDbPath,
  openStateDb,
} from "../../../extensions/orchestrator/state-db.js";
import {
  addPersistentHostApproval,
  alwaysAllowHostChoice,
  CHOICE_ALLOW_ONCE,
  CHOICE_DENY,
  clearPersistentHostApprovals,
  evaluateToolPermissions,
  extractTargetHosts,
  hasPersistentHostApproval,
  listPersistentHostApprovals,
  matchGlob,
  resolvePermissionAction,
  type ToolPermissions,
} from "../../../extensions/orchestrator/tool-permissions.js";
import { validateSettingValue } from "../../../extensions/pidash/browser-ops.js";

const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tool-permissions-run-"));
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(runRoot, prefix));
  tempDirs.push(dir);
  return dir;
}

let testHmacKeyPath = "";

beforeEach(() => {
  const keyDir = makeTempDir("hmac-key-");
  testHmacKeyPath = path.join(keyDir, ".approval-hmac-key");
  setApprovalHmacKeyPathForTests(testHmacKeyPath);
  const globalDir = makeTempDir("global-settings-");
  setGlobalSettingsPath(path.join(globalDir, "pi-config-settings.json"));
  clearSettingsCache();
  clearTrackedSettingsCache();
  clearRestrictedFoldersFloor();
});

afterEach(() => {
  closeStateDbs();
  setApprovalHmacKeyPathForTests(null);
  setGlobalSettingsPath(null);
  clearSettingsCache();
  clearTrackedSettingsCache();
  clearRestrictedFoldersFloor();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

after(() => {
  fs.rmSync(runRoot, { recursive: true, force: true });
});

function setupEnforcementHarness(opts: {
  settings?: Record<string, unknown>;
  globalSettings?: Record<string, unknown>;
  tools?: Array<{ name: string; annotations?: Record<string, boolean> }>;
} = {}) {
  const cwd = makeTempDir("enf-proj-");
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  if (opts.settings) {
    fs.writeFileSync(
      path.join(cwd, ".pi", "pi-config-settings.json"),
      JSON.stringify(opts.settings, null, 2),
    );
  }
  if (opts.globalSettings) {
    const gDir = makeTempDir("enf-global-");
    const gFile = path.join(gDir, "pi-config-settings.json");
    fs.writeFileSync(gFile, JSON.stringify(opts.globalSettings, null, 2));
    setGlobalSettingsPath(gFile);
  }
  clearSettingsCache();

  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const piMock: any = {
    on(event: string, fn: (...args: any[]) => any) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(fn);
    },
    registerCommand(name: string, def: any) {
      commands.set(name, def);
    },
    registerTool() {},
    getAllTools() {
      return (opts.tools ?? []).map((t) => ({
        name: t.name,
        description: "",
        parameters: {},
        exposure: "direct",
        annotations: t.annotations,
        sourceInfo: {},
      }));
    },
    events: { emit() {}, on() { return () => {}; } },
  };
  registerEnforcement(piMock);

  const callTool = async (event: any, ctx: any) => {
    for (const h of handlers.get("tool_call") ?? []) {
      const res = await h(event, ctx);
      if (res) return res;
    }
    return undefined;
  };

  return { cwd, commands, callTool };
}

describe("tool_permissions schema & agent-edit protection (#1450)", () => {
  it("declares tool_permissions in settings-keys.json with default {} and no env override", () => {
    const def = SETTINGS_KEYS.tool_permissions;
    assert.ok(def, "tool_permissions must exist in settings-keys.json");
    assert.equal(def.type, "tool_permissions");
    assert.deepEqual(def.default, {});
    assert.equal(def.group, "Enforcement");
    assert.equal(def.env, undefined, "ambient env must not override tool_permissions");
  });

  it("validates valid rules and rejects invalid shapes in strict mode", () => {
    assert.deepEqual(validateSetting("tool_permissions", {}), { ok: true, value: {} });
    const valid: ToolPermissions = {
      fetch_content: { "*": "ask", "github.com": "allow", "*.redhat.com": "allow" },
      "mcp__*": "ask",
      "annotation:destructive": "deny",
    };
    assert.deepEqual(validateSetting("tool_permissions", valid), { ok: true, value: valid });
    assert.equal(validateSetting("tool_permissions", ["bad"]).ok, false);
    assert.equal(validateSetting("tool_permissions", { "mcp__*": "maybe" }).ok, false);
    assert.equal(validateSetting("tool_permissions", { fetch_content: { "*": "bogus" } }).ok, false);
    assert.equal(parseSettingInput("tool_permissions", '{"mcp__*":"ask"}').ok, true);
    assert.equal(parseSettingInput("tool_permissions", "not-json").ok, false);
  });

  it("drops malformed sibling entries in lenient mode while preserving valid rules", () => {
    const res = validateSetting(
      "tool_permissions",
      {
        "mcp__*": "ask",
        bad_tool: "invalid_action",
        fetch_content: { "*": "ask", bad_host: 123, "github.com": "allow" },
      },
      { mode: "lenient" },
    );
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.deepEqual(res.value, {
        "mcp__*": "ask",
        fetch_content: { "*": "ask", "github.com": "allow" },
      });
    }
  });

  it("blocks direct agent file edits and browser writes to tool_permissions", () => {
    const cwd = makeTempDir("prot-settings-");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    const editDecision = evaluateFileWritePolicy(path.join(cwd, ".pi", "pi-config-settings.json"), cwd);
    assert.ok(editDecision?.block, "direct edit/write to .pi/pi-config-settings.json must be blocked");
    assert.match(editDecision!.reason, /tool permissions/i);

    const browserErr = validateSettingValue("tool_permissions", { "*": "allow" });
    assert.ok(browserErr, "browser write to tool_permissions must be refused");
    assert.match(browserErr!, /terminal settings editor/);
  });

  it("blocks bash tampering with tool_host_approvals in state.db", async () => {
    const cwd = makeTempDir("prot-bash-db-");
    const decision = await evaluateBashPolicy({
      command: `sqlite3 .pi/data/state.db "INSERT INTO tool_host_approvals (tool_name, hostname, signature, created_at) VALUES ('fetch_content', 'evil.com', 'deadbeef', 'now')"`,
      cwd,
      ui: null,
    });
    assert.equal(decision.action, "block");
  });

  it("ignores allow rules in git-tracked project settings so cloned repos cannot weaken global rules", async () => {
    const repo = makeTempDir("tracked-repo-");
    execFileSync("git", ["init", "-q"], { cwd: repo });
    fs.mkdirSync(path.join(repo, ".pi"), { recursive: true });
    const projSettings = path.join(repo, ".pi", "pi-config-settings.json");
    fs.writeFileSync(
      projSettings,
      JSON.stringify({
        tool_permissions: {
          "mcp__*": "allow",
          fetch_content: { "*": "allow" },
        },
      }),
    );
    execFileSync("git", ["add", "-f", ".pi/pi-config-settings.json"], { cwd: repo });

    const gDir = makeTempDir("tracked-global-");
    const gFile = path.join(gDir, "pi-config-settings.json");
    fs.writeFileSync(
      gFile,
      JSON.stringify({
        tool_permissions: {
          "mcp__*": "ask",
          fetch_content: { "*": "ask" },
        },
      }),
    );
    setGlobalSettingsPath(gFile);
    clearSettingsCache();
    clearTrackedSettingsCache();

    const mcpRes = await evaluateToolPermissions({
      toolName: "mcp__jira_delete",
      input: {},
      cwd: repo,
      ui: null,
    });
    assert.ok(mcpRes?.block, "tracked project allow must not override global ask");

    const fetchRes = await evaluateToolPermissions({
      toolName: "fetch_content",
      input: { url: "https://example.com/data" },
      cwd: repo,
      ui: null,
    });
    assert.ok(fetchRes?.block, "tracked project fetch_content allow must not override global ask");
  });
});

describe("empty/default tool_permissions: {} (zero behavior change)", () => {
  it("resolves default {} and allows all tools without prompting or creating SQLite DB", async () => {
    const cwd = makeTempDir("empty-default-");
    assert.deepEqual(getSetting(cwd, "tool_permissions"), {});
    const dbPath = getProjectStateDbPath(cwd);

    const res1 = await evaluateToolPermissions({
      toolName: "mcp__jira_create",
      input: {},
      cwd,
      ui: null,
    });
    const res2 = await evaluateToolPermissions({
      toolName: "fetch_content",
      input: { url: "not-even-a-url" },
      cwd,
      ui: null,
    });

    assert.equal(res1, undefined);
    assert.equal(res2, undefined);
    assert.equal(fs.existsSync(dbPath), false, "empty rules must not even open SQLite DB");
  });
});

describe("last-match-wins glob & Pi 1.6 annotation matching", () => {
  it("matches * and ? globs with last-match-wins semantics across tool names", () => {
    assert.equal(matchGlob("mcp__*", "mcp__jira_get"), true);
    assert.equal(matchGlob("mcp__?", "mcp__a"), true);
    assert.equal(matchGlob("mcp__?", "mcp__ab"), false);
    assert.equal(matchGlob("*.redhat.com", "docs.redhat.com", true), true);
    assert.equal(matchGlob("*.redhat.com", "a.b.redhat.com", true), true);
    assert.equal(matchGlob("*.redhat.com", "redhat.com", true), false);
    assert.equal(matchGlob("*.redhat.com", "evilredhat.com", true), false);

    const rules: ToolPermissions = {
      "mcp__*": "ask",
      "mcp__docs_*": "allow",
      "mcp__docs_delete": "deny",
    };
    assert.equal(resolvePermissionAction([rules], "mcp__jira_search")?.action, "ask");
    assert.equal(resolvePermissionAction([rules], "mcp__docs_read")?.action, "allow");
    assert.equal(resolvePermissionAction([rules], "mcp__docs_delete")?.action, "deny");
    assert.equal(resolvePermissionAction([rules], "read"), null);
  });

  it("evaluates per-host globs with last-match-wins semantics", () => {
    const rules: ToolPermissions = {
      fetch_content: {
        "*": "ask",
        "github.com": "allow",
        "*.redhat.com": "allow",
        "blocked.redhat.com": "deny",
      },
    };
    assert.equal(resolvePermissionAction([rules], "fetch_content", undefined, "github.com")?.action, "allow");
    assert.equal(resolvePermissionAction([rules], "fetch_content", undefined, "api.redhat.com")?.action, "allow");
    assert.equal(resolvePermissionAction([rules], "fetch_content", undefined, "blocked.redhat.com")?.action, "deny");
    assert.equal(resolvePermissionAction([rules], "fetch_content", undefined, "example.org")?.action, "ask");
  });

  it("matches Pi 1.6 tool annotations (destructive / openWorld / readOnly) with last-match-wins", () => {
    const rules: ToolPermissions = {
      "annotation:openWorld": "ask",
      "annotation:destructive": "deny",
      "mcp__safe_delete": "allow",
    };
    assert.equal(
      resolvePermissionAction([rules], "mcp__web_tool", { openWorldHint: true })?.action,
      "ask",
    );
    assert.equal(
      resolvePermissionAction([rules], "mcp__db_drop", { destructiveHint: true })?.action,
      "deny",
    );
    // MCP spec: destructiveHint does not apply when readOnlyHint is true.
    assert.equal(
      resolvePermissionAction([rules], "mcp__readonly_tool", { readOnlyHint: true, destructiveHint: true }),
      null,
    );
    // Later exact tool rule overrides earlier annotation rule.
    assert.equal(
      resolvePermissionAction([rules], "mcp__safe_delete", { destructiveHint: true })?.action,
      "allow",
    );
  });

  it("reads Pi 1.6 tool annotations from pi.getAllTools() in registerEnforcement", async () => {
    const { cwd, callTool } = setupEnforcementHarness({
      settings: {
        tool_permissions: {
          "annotation:destructive": "deny",
          "annotation:openWorld": "ask",
        },
      },
      tools: [
        { name: "mcp__nuke", annotations: { destructiveHint: true } },
        { name: "mcp__search", annotations: { openWorldHint: true } },
        { name: "mcp__local", annotations: { readOnlyHint: true } },
      ],
    });
    const headlessCtx = { cwd, hasUI: false, ui: {} };

    const nukeRes = await callTool({ type: "tool_call", toolName: "mcp__nuke", input: {} }, headlessCtx);
    assert.ok(nukeRes?.block);
    assert.match(nukeRes!.reason, /denied/);

    const searchRes = await callTool({ type: "tool_call", toolName: "mcp__search", input: {} }, headlessCtx);
    assert.ok(searchRes?.block);
    assert.match(searchRes!.reason, /headless/i);

    const localRes = await callTool({ type: "tool_call", toolName: "mcp__local", input: {} }, headlessCtx);
    assert.equal(localRes, undefined);
  });
});

describe("multi-URL fetch_content scoping & fail-closed validation", () => {
  it("extracts and normalizes hosts from url and urls[], failing closed on malformed/non-HTTP(S) URLs", () => {
    const ok = extractTargetHosts({
      url: "https://GitHub.COM:443/org/repo",
      urls: ["https://docs.redhat.com./guide", "https://github.com/other"],
    });
    assert.deepEqual(ok, { ok: true, hosts: ["github.com", "docs.redhat.com"] });

    assert.equal(extractTargetHosts({ url: "not-a-url" }).ok, false);
    assert.equal(extractTargetHosts({ url: "file:///etc/passwd" }).ok, false);
    assert.equal(extractTargetHosts({ url: "file://localhost/etc/passwd" }).ok, false);
    assert.equal(extractTargetHosts({ url: "javascript:alert(1)" }).ok, false);
    assert.equal(extractTargetHosts({ urls: ["https://github.com/a", "bad://"] }).ok, false);
    assert.equal(extractTargetHosts({}).ok, false);
  });

  it("validates EVERY URL in urls[] — one denied or unapproved host blocks/prompts", async () => {
    const cwd = makeTempDir("multi-url-");
    const rules: ToolPermissions = {
      fetch_content: {
        "*": "ask",
        "github.com": "allow",
        "*.redhat.com": "allow",
        "evil.example": "deny",
      },
    };

    // All allowed -> passes without prompting
    let prompted = false;
    const allAllowed = await evaluateToolPermissions({
      toolName: "fetch_content",
      input: { urls: ["https://github.com/myk-org/pi-config", "https://access.redhat.com/docs"] },
      cwd,
      rules,
      ui: {
        async select() {
          prompted = true;
          return CHOICE_DENY;
        },
      },
    });
    assert.equal(allAllowed, undefined);
    assert.equal(prompted, false);

    // One denied host alongside an allowed host -> blocks without prompting
    const oneDenied = await evaluateToolPermissions({
      toolName: "fetch_content",
      input: { urls: ["https://github.com/a", "https://evil.example/payload"] },
      cwd,
      rules,
      ui: {
        async select() {
          prompted = true;
          return CHOICE_ALLOW_ONCE;
        },
      },
    });
    assert.ok(oneDenied?.block);
    assert.match(oneDenied!.reason, /evil\.example/);
    assert.equal(prompted, false);

    // One unapproved ask host alongside an allowed host -> prompts ONLY for unapproved host
    const seenPrompts: Array<{ title: string; options: string[] }> = [];
    const oneAsk = await evaluateToolPermissions({
      toolName: "fetch_content",
      input: { urls: ["https://github.com/a", "https://unknown.example/page"] },
      cwd,
      rules,
      ui: {
        async select(title, options) {
          seenPrompts.push({ title, options });
          return CHOICE_ALLOW_ONCE;
        },
      },
    });
    assert.equal(oneAsk, undefined);
    assert.equal(seenPrompts.length, 1);
    assert.match(seenPrompts[0]!.title, /unknown\.example/);
    assert.deepEqual(seenPrompts[0]!.options, [
      CHOICE_ALLOW_ONCE,
      alwaysAllowHostChoice("unknown.example"),
      CHOICE_DENY,
    ]);
    assert.ok(
      !seenPrompts[0]!.options.some((o) => o.includes("*")),
      "prompt must never offer a wildcard * approval",
    );
  });

  it("fails closed on malformed URL when fetch_content has a non-allow rule", async () => {
    const cwd = makeTempDir("bad-url-");
    const res = await evaluateToolPermissions({
      toolName: "fetch_content",
      input: { urls: ["https://github.com/ok", "not a url"] },
      cwd,
      rules: { fetch_content: { "*": "ask", "github.com": "allow" } },
      ui: { async select() { return CHOICE_ALLOW_ONCE; } },
    });
    assert.ok(res?.block);
    assert.match(res!.reason, /malformed URL/i);
  });
});

describe("HMAC-authenticated SQLite host approvals & /forget-approvals", () => {
  it("persists exact-hostname HMAC grant across reload/new session, never wildcard, and clears via /forget-approvals", async () => {
    const { cwd, commands, callTool } = setupEnforcementHarness({
      settings: {
        tool_permissions: {
          fetch_content: { "*": "ask" },
        },
      },
    });

    const notifications: string[] = [];
    let promptCount = 0;
    const interactiveCtx = {
      cwd,
      hasUI: true,
      sessionManager: { getSessionId: () => "sess-1" },
      ui: {
        async select(_title: string, options: string[]) {
          promptCount++;
          assert.ok(options.includes(alwaysAllowHostChoice("docs.example.com")));
          return alwaysAllowHostChoice("docs.example.com");
        },
        notify(msg: string) {
          notifications.push(msg);
        },
      },
    };
    const headlessCtx = {
      cwd,
      hasUI: false,
      sessionManager: { getSessionId: () => "sess-2" },
      ui: {},
    };

    // First call prompts and persists grant for docs.example.com
    const first = await callTool(
      { type: "tool_call", toolName: "fetch_content", input: { url: "https://docs.example.com/a" } },
      interactiveCtx,
    );
    assert.equal(first, undefined);
    assert.equal(promptCount, 1);

    // Schema version is bumped to CURRENT_SCHEMA_VERSION
    const db = openStateDb(getProjectStateDbPath(cwd));
    const version = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
    assert.equal(version.v, CURRENT_SCHEMA_VERSION);

    // Simulate reload / new session by closing cached DB handles
    closeStateDbs();

    // Same host passes even in a new headless session (grant persisted!)
    const second = await callTool(
      { type: "tool_call", toolName: "fetch_content", input: { url: "https://DOCS.EXAMPLE.COM/b" } },
      headlessCtx,
    );
    assert.equal(second, undefined);

    // Different host (even sibling subdomain!) is NOT covered by docs.example.com grant -> fails closed
    const otherHost = await callTool(
      { type: "tool_call", toolName: "fetch_content", input: { url: "https://api.example.com/v1" } },
      headlessCtx,
    );
    assert.ok(otherHost?.block);

    // `/forget-approvals session` must NOT clear persistent host approvals
    const forgetCmd = commands.get("forget-approvals");
    assert.ok(forgetCmd);
    await forgetCmd!.handler("session", interactiveCtx);
    assert.equal(listPersistentHostApprovals(cwd).length, 1);

    // `/forget-approvals` clears persistent host approvals
    await forgetCmd!.handler("", interactiveCtx);
    assert.equal(listPersistentHostApprovals(cwd).length, 0);
    assert.ok(notifications.some((m) => m.includes("1 persistent approval(s)")));

    // Now docs.example.com fails closed again in headless session
    const afterForget = await callTool(
      { type: "tool_call", toolName: "fetch_content", input: { url: "https://docs.example.com/c" } },
      headlessCtx,
    );
    assert.ok(afterForget?.block);
  });

  it("refuses to persist wildcard hostnames", () => {
    const cwd = makeTempDir("no-wildcard-");
    assert.throws(() => addPersistentHostApproval(cwd, "fetch_content", "*"), /wildcard|non-exact/i);
    assert.throws(() => addPersistentHostApproval(cwd, "fetch_content", "*.redhat.com"), /wildcard|non-exact/i);
    assert.throws(() => addPersistentHostApproval(cwd, "fetch_content", "foo?.com"), /wildcard|non-exact/i);
  });

  it("rejects tampered SQLite rows, missing HMAC key, and cross-DB replays", () => {
    const cwdA = makeTempDir("hmac-a-");
    const cwdB = makeTempDir("hmac-b-");

    addPersistentHostApproval(cwdA, "fetch_content", "trusted.example.com");
    assert.equal(hasPersistentHostApproval(cwdA, "fetch_content", "trusted.example.com"), true);

    // Grab valid signature from project A and try replaying into project B's DB
    const dbA = openStateDb(getProjectStateDbPath(cwdA));
    const rowA = dbA
      .prepare("SELECT signature FROM tool_host_approvals WHERE hostname = ?")
      .get("trusted.example.com") as { signature: string };

    const dbB = openStateDb(getProjectStateDbPath(cwdB));
    dbB
      .prepare(
        "INSERT INTO tool_host_approvals (tool_name, hostname, signature, created_at) VALUES (?, ?, ?, ?)",
      )
      .run("fetch_content", "trusted.example.com", rowA.signature, new Date().toISOString());
    assert.equal(
      hasPersistentHostApproval(cwdB, "fetch_content", "trusted.example.com"),
      false,
      "cross-DB signature replay must be rejected",
    );

    // Tamper hostname in project A's DB without updating HMAC
    dbA
      .prepare("UPDATE tool_host_approvals SET hostname = ? WHERE hostname = ?")
      .run("evil.example.com", "trusted.example.com");
    assert.equal(
      hasPersistentHostApproval(cwdA, "fetch_content", "evil.example.com"),
      false,
      "tampered hostname row must be rejected",
    );

    // Insert forged row with fake 64-hex signature
    dbA
      .prepare(
        "INSERT INTO tool_host_approvals (tool_name, hostname, signature, created_at) VALUES (?, ?, ?, ?)",
      )
      .run("fetch_content", "forged.example.com", "a".repeat(64), new Date().toISOString());
    assert.equal(hasPersistentHostApproval(cwdA, "fetch_content", "forged.example.com"), false);

    // Valid grant rejected if HMAC key is deleted
    addPersistentHostApproval(cwdA, "fetch_content", "valid.example.com");
    assert.equal(hasPersistentHostApproval(cwdA, "fetch_content", "valid.example.com"), true);
    fs.unlinkSync(testHmacKeyPath);
    assert.equal(hasPersistentHostApproval(cwdA, "fetch_content", "valid.example.com"), false);
    assert.equal(clearPersistentHostApprovals(cwdA) >= 1, true);
  });
});

describe("headless fail-closed & non-weakening of hard security blocks", () => {
  it("fails closed on ask rules when headless (hasUI: false)", async () => {
    const { cwd, callTool } = setupEnforcementHarness({
      settings: {
        tool_permissions: {
          "mcp__*": "ask",
          fetch_content: { "*": "ask" },
        },
      },
    });
    const headlessCtx = { cwd, hasUI: false, ui: {} };

    const mcpBlocked = await callTool(
      { type: "tool_call", toolName: "mcp__jira_get", input: {} },
      headlessCtx,
    );
    assert.ok(mcpBlocked?.block);
    assert.match(mcpBlocked!.reason, /headless/i);

    const fetchBlocked = await callTool(
      { type: "tool_call", toolName: "fetch_content", input: { url: "https://example.com" } },
      headlessCtx,
    );
    assert.ok(fetchBlocked?.block);
    assert.match(fetchBlocked!.reason, /headless/i);
  });

  it("cannot weaken built-in hard security blocks (restricted_folders, settings protection, hmac key, bash policy)", async () => {
    const { cwd, callTool } = setupEnforcementHarness({
      settings: {
        restricted_folders: ["secrets"],
        tool_permissions: {
          "*": "allow",
          read: "allow",
          write: "allow",
          edit: "allow",
          bash: "allow",
        },
      },
    });
    fs.mkdirSync(path.join(cwd, "secrets"), { recursive: true });
    const secretFile = path.join(cwd, "secrets", "token.txt");
    fs.writeFileSync(secretFile, "super-secret");
    const headlessCtx = { cwd, hasUI: false, ui: {} };

    // 1. restricted_folders still blocks read
    const readRestricted = await callTool(
      { type: "tool_call", toolName: "read", input: { path: secretFile } },
      headlessCtx,
    );
    assert.ok(readRestricted?.block, "tool_permissions allow must NEVER weaken restricted_folders");

    // 2. settings edit protection still blocks write to .pi/pi-config-settings.json
    const writeSettings = await callTool(
      {
        type: "tool_call",
        toolName: "write",
        input: { path: path.join(cwd, ".pi", "pi-config-settings.json"), content: "{}" },
      },
      headlessCtx,
    );
    assert.ok(writeSettings?.block, "tool_permissions allow must NEVER weaken settings edit protection");

    // 3. HMAC key protection still blocks reading .approval-hmac-key
    const readHmac = await callTool(
      { type: "tool_call", toolName: "read", input: { path: testHmacKeyPath } },
      headlessCtx,
    );
    assert.ok(readHmac?.block, "tool_permissions allow must NEVER weaken .approval-hmac-key protection");

    // 4. bash-policy still blocks forbidden commands (pip install / git add .)
    const bashBlocked = await callTool(
      { type: "tool_call", toolName: "bash", input: { command: "pip install requests" } },
      headlessCtx,
    );
    assert.ok(bashBlocked?.block, "tool_permissions allow must NEVER weaken bash-policy");
  });
});
