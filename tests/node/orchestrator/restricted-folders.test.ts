/**
 * Unit tests for restricted_folders enforcement, tiered approval grants, and
 * /forget-approvals (issue #1416).
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { evaluateBashPolicy, evaluateFileWritePolicy } from "../../../extensions/orchestrator/bash-policy.js";
import { registerEnforcement } from "../../../extensions/orchestrator/enforcement.js";
import {
  clearSettingsCache,
  setGlobalSettingsPath,
  SETTINGS_KEYS,
  updateSetting,
} from "../../../extensions/orchestrator/project-settings.js";
import {
  addPersistentApproval,
  addSessionApproval,
  CHOICE_APPROVE_DIR_PERSISTENT,
  CHOICE_APPROVE_DIR_SESSION,
  CHOICE_APPROVE_FILE_PERSISTENT,
  CHOICE_APPROVE_FILE_SESSION,
  CHOICE_APPROVE_ONCE,
  CHOICE_DENY,
  clearRestrictedFoldersFloor,
  clearSessionApprovals,
  evaluateRestrictedFolderAccess,
  forgetApprovals,
  getApprovalHmacKeyPath,
  grantCoversPath,
  isPathInsideFolder,
  listPersistentApprovals,
  listSessionApprovals,
  loadRestrictedFolders,
  matchRestrictedFolder,
  restoreRestrictedFoldersFloorForTests,
  setApprovalHmacKeyPathForTests,
  snapshotRestrictedFoldersFloorForTests,
} from "../../../extensions/orchestrator/restricted-folders.js";
import {
  closeStateDbs,
  CURRENT_SCHEMA_VERSION,
  getProjectStateDbPath,
  openStateDb,
} from "../../../extensions/orchestrator/state-db.js";
import { validateSettingValue } from "../../../extensions/pidash/browser-ops.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

const tempDirs: string[] = [];
function trackTempDir(prefix: string): string {
  const dir = makeTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

function createGrantFixture() {
  const root = trackTempDir("rf-fixture-");
  const restricted = path.join(root, "restricted");
  const subDir = path.join(restricted, "sub");
  const grandDir = path.join(subDir, "nested");
  fs.mkdirSync(grandDir, { recursive: true });
  const fileA = path.join(restricted, "a.txt");
  const fileB = path.join(restricted, "b.txt");
  const subChild1 = path.join(subDir, "c1.txt");
  const subChild2 = path.join(subDir, "c2.txt");
  const grandChild = path.join(grandDir, "deep.txt");
  fs.writeFileSync(fileA, "a");
  fs.writeFileSync(fileB, "b");
  fs.writeFileSync(subChild1, "c1");
  fs.writeFileSync(subChild2, "c2");
  fs.writeFileSync(grandChild, "deep");
  const dbPath = path.join(root, "state.db");
  const hmacKeyPath = path.join(root, ".approval-hmac-key");
  return { root, restricted, subDir, grandDir, fileA, fileB, subChild1, subChild2, grandChild, dbPath, hmacKeyPath };
}

function createEnforcementHarness(cwd: string) {
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const commands = new Map<string, { description: string; handler: (...args: any[]) => any }>();
  const pi = {
    on(event: string, handler: (...args: any[]) => any) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand(name: string, opts: any) {
      commands.set(name, opts);
    },
    registerTool() {},
    events: {
      on() {},
      off() {},
      emit() {},
    },
  } as any;

  registerEnforcement(pi, false);

  async function callTool(event: any, ctx: any) {
    for (const h of handlers.get("tool_call") ?? []) {
      const res = await h(event, ctx);
      if (res) return res;
    }
    return undefined;
  }

  return { handlers, commands, callTool };
}

afterEach(() => {
  clearSessionApprovals();
  clearRestrictedFoldersFloor();
  setApprovalHmacKeyPathForTests(null);
  clearSettingsCache();
  setGlobalSettingsPath(null);
  closeStateDbs();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("restricted_folders schema + agent-edit protection (#1416)", () => {
  it("declares restricted_folders as string_list in Enforcement without env override", () => {
    const def = SETTINGS_KEYS.restricted_folders;
    assert.ok(def, "restricted_folders key must exist in settings-keys.json");
    assert.equal(def.type, "string_list");
    assert.deepEqual(def.default, []);
    assert.equal(def.env, undefined, "ambient env must not alter restricted_folders");
    assert.equal(def.group, "Enforcement");
  });

  it("blocks direct agent file writes to pi-config-settings.json", () => {
    const cwd = trackTempDir("rf-protect-direct-");
    const projSettings = path.join(cwd, ".pi", "pi-config-settings.json");
    const writeDecision = evaluateFileWritePolicy(projSettings, cwd);
    assert.ok(writeDecision?.block);
    assert.match(writeDecision!.reason, /restricted folders/i);
  });

  it("blocks @-prefixed agent file writes to pi-config-settings.json", () => {
    const cwd = trackTempDir("rf-protect-at-");
    const projSettings = path.join(cwd, ".pi", "pi-config-settings.json");
    const atWriteDecision = evaluateFileWritePolicy(`@${projSettings}`, cwd);
    assert.ok(atWriteDecision?.block);
  });

  it("blocks fragmented bash redirects targeting pi-config-settings.json", async () => {
    const cwd = trackTempDir("rf-protect-bash-");
    for (const cmd of [
      `p="pi-config"; s="settings.json"; echo '{"restricted_folders":[]}' > ".pi/$p-$s"`,
      `echo '{"restricted_folders":[]}' > .pi/"pi-config""-settings.json"`,
    ]) {
      const res = await evaluateBashPolicy({ command: cmd, cwd, ui: null });
      assert.equal(res.action, "block", `fragmented settings write must be blocked: ${cmd}`);
    }
  });

  it("refuses browser writes to restricted_folders", () => {
    const browserErr = validateSettingValue("restricted_folders", []);
    assert.ok(browserErr);
    assert.match(browserErr!, /terminal settings editor/);
  });

  it("retains pinned project restricted_folders after external settings file overwrite", () => {
    const cwd = trackTempDir("rf-floor-external-");
    const projSettings = path.join(cwd, ".pi", "pi-config-settings.json");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(projSettings, JSON.stringify({ restricted_folders: ["secrets/prod"] }));
    setGlobalSettingsPath(path.join(cwd, "nonexistent-global.json"));
    clearSettingsCache();
    assert.deepEqual(loadRestrictedFolders(cwd), ["secrets/prod"]);

    fs.writeFileSync(projSettings, JSON.stringify({ restricted_folders: [] }));
    clearSettingsCache();
    assert.deepEqual(loadRestrictedFolders(cwd), ["secrets/prod"]);
  });

  it("allows authorized updateSetting() to remove a project restricted folder", () => {
    const cwd = trackTempDir("rf-floor-human-");
    setApprovalHmacKeyPathForTests(path.join(cwd, ".test-hmac-key"));
    const projSettings = path.join(cwd, ".pi", "pi-config-settings.json");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(projSettings, JSON.stringify({ restricted_folders: ["secrets/prod"] }));
    setGlobalSettingsPath(path.join(cwd, "nonexistent-global.json"));
    clearSettingsCache();
    assert.deepEqual(loadRestrictedFolders(cwd), ["secrets/prod"]);

    const upd = updateSetting(cwd, "project", "restricted_folders", []);
    assert.equal(upd.ok, true);
    assert.deepEqual(loadRestrictedFolders(cwd), []);
  });

  it("clears root floor when restricted_folders is saved from a subdirectory", () => {
    const repo = trackTempDir("rf-floor-subdir-");
    setApprovalHmacKeyPathForTests(path.join(repo, ".test-hmac-key"));
    const subdir = path.join(repo, "packages", "sub");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repo, ".pi"), { recursive: true });
    fs.mkdirSync(subdir, { recursive: true });
    const projSettings = path.join(repo, ".pi", "pi-config-settings.json");
    fs.writeFileSync(projSettings, JSON.stringify({ restricted_folders: ["secrets/prod"] }));
    setGlobalSettingsPath(path.join(repo, "nonexistent-global.json"));
    clearSettingsCache();

    // Load at repository root -> pins floor under canonical repo root
    assert.deepEqual(loadRestrictedFolders(repo), ["secrets/prod"]);

    // Save removal from a nested subdirectory -> must clear the shared repo root floor
    assert.equal(updateSetting(subdir, "project", "restricted_folders", []).ok, true);
    assert.deepEqual(loadRestrictedFolders(repo), []);
  });

  it("honors an authorized cross-process restricted_folders removal via HMAC attestation", () => {
    const repo = trackTempDir("rf-floor-xproc-");
    const hmacKey = path.join(repo, ".test-hmac-key");
    setApprovalHmacKeyPathForTests(hmacKey);
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repo, ".pi"), { recursive: true });
    const projSettings = path.join(repo, ".pi", "pi-config-settings.json");
    fs.writeFileSync(projSettings, JSON.stringify({ restricted_folders: ["secrets/prod"] }));
    setGlobalSettingsPath(path.join(repo, "nonexistent-global.json"));
    clearSettingsCache();

    // Simulate Process B pinning ["secrets/prod"]
    assert.deepEqual(loadRestrictedFolders(repo), ["secrets/prod"]);
    const savedProcessBFloor = snapshotRestrictedFoldersFloorForTests();

    // Process A authorizes removal via updateSetting (writes HMAC attestation in shared state.db)
    assert.equal(updateSetting(repo, "project", "restricted_folders", []).ok, true);

    // Restore Process B's pre-save local floor (as if Process B never received Process A's in-process callback)
    restoreRestrictedFoldersFloorForTests(savedProcessBFloor);
    clearSettingsCache();

    // Process B verifies the HMAC attestation in shared state.db and accepts the removal
    assert.deepEqual(loadRestrictedFolders(repo), []);
  });

  it("retains the local floor when persisting the HMAC attestation fails", () => {
    const repo = trackTempDir("rf-floor-attest-fail-");
    // Point HMAC key path at an existing directory so writing the key file fails with EISDIR
    const blockingDir = path.join(repo, "unwritable-key-dir");
    fs.mkdirSync(blockingDir, { recursive: true });
    setApprovalHmacKeyPathForTests(blockingDir);

    fs.mkdirSync(path.join(repo, ".pi"), { recursive: true });
    const projSettings = path.join(repo, ".pi", "pi-config-settings.json");
    fs.writeFileSync(projSettings, JSON.stringify({ restricted_folders: ["secrets/prod"] }));
    setGlobalSettingsPath(path.join(repo, "nonexistent-global.json"));
    clearSettingsCache();

    assert.deepEqual(loadRestrictedFolders(repo), ["secrets/prod"]);

    // Authorized save triggers attestation write which fails -> local floor must stay pinned!
    assert.equal(updateSetting(repo, "project", "restricted_folders", []).ok, true);
    clearSettingsCache();
    assert.deepEqual(loadRestrictedFolders(repo), ["secrets/prod"]);
  });

  it("rejects replaying an older empty-list attestation after a folder is restored externally", () => {
    const repo = trackTempDir("rf-floor-replay-");
    setApprovalHmacKeyPathForTests(path.join(repo, ".test-hmac-key"));
    fs.mkdirSync(path.join(repo, ".pi"), { recursive: true });
    const projSettings = path.join(repo, ".pi", "pi-config-settings.json");
    fs.writeFileSync(projSettings, JSON.stringify({ restricted_folders: ["secrets/prod"] }));
    setGlobalSettingsPath(path.join(repo, "nonexistent-global.json"));
    clearSettingsCache();

    // 1. Initial load pins ["secrets/prod"] at gen 0; authorized save removes it (signs gen 1, [])
    assert.deepEqual(loadRestrictedFolders(repo), ["secrets/prod"]);
    assert.equal(updateSetting(repo, "project", "restricted_folders", []).ok, true);
    assert.deepEqual(loadRestrictedFolders(repo), []);

    // 2. Folder is restored externally (pinned at gen 1)
    fs.writeFileSync(projSettings, JSON.stringify({ restricted_folders: ["secrets/prod"] }));
    clearSettingsCache();
    assert.deepEqual(loadRestrictedFolders(repo), ["secrets/prod"]);

    // 3. Unauthorized external overwrite returns file to [] without a new authorized save
    //    The old gen-1 attestation for [] must NOT clear the folder pinned at gen 1!
    fs.writeFileSync(projSettings, JSON.stringify({ restricted_folders: [] }));
    clearSettingsCache();
    assert.deepEqual(loadRestrictedFolders(repo), ["secrets/prod"]);
  });

  it("attests the live on-disk folder list across overlapping authorized saves", () => {
    const repo = trackTempDir("rf-floor-overlap-");
    setApprovalHmacKeyPathForTests(path.join(repo, ".test-hmac-key"));
    fs.mkdirSync(path.join(repo, ".pi"), { recursive: true });
    const projSettings = path.join(repo, ".pi", "pi-config-settings.json");
    fs.writeFileSync(projSettings, JSON.stringify({ restricted_folders: ["secrets/a", "secrets/b"] }));
    setGlobalSettingsPath(path.join(repo, "nonexistent-global.json"));
    clearSettingsCache();

    // Reader pins original two folders at gen 0
    assert.deepEqual(loadRestrictedFolders(repo), ["secrets/a", "secrets/b"]);
    const readerFloor = snapshotRestrictedFoldersFloorForTests();

    // Two overlapping authorized updates: first narrows to ["secrets/a"], second clears to []
    assert.equal(updateSetting(repo, "project", "restricted_folders", ["secrets/a"]).ok, true);
    assert.equal(updateSetting(repo, "project", "restricted_folders", []).ok, true);

    // Reader retaining its original floor verifies the newer generation and accepts []
    restoreRestrictedFoldersFloorForTests(readerFloor);
    clearSettingsCache();
    assert.deepEqual(loadRestrictedFolders(repo), []);
  });

  it("keeps restricted_folders floor intact when saving an unrelated setting", () => {
    const cwd = trackTempDir("rf-floor-unrelated-");
    setApprovalHmacKeyPathForTests(path.join(cwd, ".test-hmac-key"));
    const projSettings = path.join(cwd, ".pi", "pi-config-settings.json");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(projSettings, JSON.stringify({ restricted_folders: ["secrets/prod"] }));
    setGlobalSettingsPath(path.join(cwd, "nonexistent-global.json"));
    clearSettingsCache();
    assert.deepEqual(loadRestrictedFolders(cwd), ["secrets/prod"]);

    // Saving an unrelated key must NOT clear the floor
    const upd = updateSetting(cwd, "project", "dco", true);
    assert.equal(upd.ok, true);

    // Subsequent external overwrite removing restricted_folders must still be ignored
    fs.writeFileSync(projSettings, JSON.stringify({ dco: true, restricted_folders: [] }));
    clearSettingsCache();
    assert.deepEqual(loadRestrictedFolders(cwd), ["secrets/prod"]);
  });

  it("keeps project B floor intact when project A updates restricted_folders", () => {
    const projA = trackTempDir("rf-floor-a-");
    const projB = trackTempDir("rf-floor-b-");
    setApprovalHmacKeyPathForTests(path.join(projA, ".test-hmac-key"));
    setGlobalSettingsPath(path.join(projA, "nonexistent-global.json"));
    fs.mkdirSync(path.join(projA, ".pi"), { recursive: true });
    fs.mkdirSync(path.join(projB, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(projA, ".pi", "pi-config-settings.json"), JSON.stringify({ restricted_folders: ["a-sec"] }));
    fs.writeFileSync(path.join(projB, ".pi", "pi-config-settings.json"), JSON.stringify({ restricted_folders: ["b-sec"] }));
    clearSettingsCache();

    assert.deepEqual(loadRestrictedFolders(projA), ["a-sec"]);
    assert.deepEqual(loadRestrictedFolders(projB), ["b-sec"]);

    // Project A clears its own list via authorized API
    assert.equal(updateSetting(projA, "project", "restricted_folders", []).ok, true);
    assert.deepEqual(loadRestrictedFolders(projA), []);

    // External tamper on Project B must still fail closed
    fs.writeFileSync(path.join(projB, ".pi", "pi-config-settings.json"), JSON.stringify({ restricted_folders: [] }));
    clearSettingsCache();
    assert.deepEqual(loadRestrictedFolders(projB), ["b-sec"]);
  });

  it("unions global restricted_folders with project entries so project settings cannot shadow globals", () => {
    const cwd = trackTempDir("rf-union-proj-");
    const globalDir = trackTempDir("rf-union-global-");
    const globalSettings = path.join(globalDir, "pi-config-settings.json");
    setGlobalSettingsPath(globalSettings);

    fs.writeFileSync(globalSettings, JSON.stringify({ restricted_folders: ["~/.ssh", "~/.aws"] }));
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".pi", "pi-config-settings.json"),
      JSON.stringify({ restricted_folders: ["secrets/prod"] }),
    );
    clearSettingsCache();
    assert.deepEqual(loadRestrictedFolders(cwd), ["~/.ssh", "~/.aws", "secrets/prod"]);

    clearRestrictedFoldersFloor(cwd);
    fs.writeFileSync(
      path.join(cwd, ".pi", "pi-config-settings.json"),
      JSON.stringify({ restricted_folders: [] }),
    );
    clearSettingsCache();
    assert.deepEqual(loadRestrictedFolders(cwd), ["~/.ssh", "~/.aws"]);
  });
});

describe("path boundary + symlink-safe matching (#1416)", () => {
  it("enforces strict path boundaries so /a/foo never matches /a/foobar", () => {
    assert.equal(isPathInsideFolder("/a/foo", "/a/foo"), true);
    assert.equal(isPathInsideFolder("/a/foo/bar.txt", "/a/foo"), true);
    assert.equal(isPathInsideFolder("/a/foobar", "/a/foo"), false);
    assert.equal(isPathInsideFolder("/a/foobar/bar.txt", "/a/foo"), false);

    const root = trackTempDir("rf-boundary-");
    const fooDir = path.join(root, "foo");
    const foobarDir = path.join(root, "foobar");
    fs.mkdirSync(fooDir, { recursive: true });
    fs.mkdirSync(foobarDir, { recursive: true });

    assert.ok(matchRestrictedFolder(path.join(fooDir, "secret.txt"), root, [fooDir]));
    assert.equal(matchRestrictedFolder(path.join(foobarDir, "safe.txt"), root, [fooDir]), null);
  });

  it("expands ~ paths against homeDir", () => {
    const root = trackTempDir("rf-tilde-");
    const fakeHome = path.join(root, "home");
    fs.mkdirSync(path.join(fakeHome, ".ssh"), { recursive: true });
    assert.ok(matchRestrictedFolder("~/.ssh/id_rsa", root, ["~/.ssh"], false, fakeHome));
  });

  it("resolves relative paths against cwd", () => {
    const root = trackTempDir("rf-rel-");
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(path.join(workspace, "secrets"), { recursive: true });
    assert.ok(matchRestrictedFolder("secrets/api.env", workspace, ["secrets"], false, root));
  });

  it("strips leading @ prefixes before matching restricted folders", () => {
    const root = trackTempDir("rf-at-");
    const fakeHome = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(path.join(fakeHome, ".ssh"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "secrets"), { recursive: true });

    assert.ok(matchRestrictedFolder("@~/.ssh/id_rsa", root, ["~/.ssh"], false, fakeHome));
    assert.ok(matchRestrictedFolder("@secrets/api.env", workspace, ["secrets"], false, fakeHome));
  });

  it("normalizes Unicode spaces to ASCII spaces before matching", () => {
    const root = trackTempDir("rf-unicode-");
    const spaceDir = path.join(root, "my secrets");
    fs.mkdirSync(spaceDir, { recursive: true });
    assert.ok(matchRestrictedFolder(path.join(root, "my\u00A0secrets", "k.txt"), root, [spaceDir]));
  });

  it("detects symlinks pointing to existing files inside a restricted folder", () => {
    const root = trackTempDir("rf-sym-exist-");
    const restrictedDir = path.join(root, "vault");
    const workDir = path.join(root, "work");
    fs.mkdirSync(restrictedDir, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });
    const secretFile = path.join(restrictedDir, "key.pem");
    fs.writeFileSync(secretFile, "top-secret");

    const linkToFile = path.join(workDir, "innocent.txt");
    fs.symlinkSync(secretFile, linkToFile);
    const m = matchRestrictedFolder(linkToFile, workDir, [restrictedDir]);
    assert.ok(m);
    assert.equal(m.canonicalTarget, fs.realpathSync(secretFile));
  });

  it("detects non-existent files under a symlinked parent pointing into a restricted folder", () => {
    const root = trackTempDir("rf-sym-parent-");
    const restrictedDir = path.join(root, "vault");
    const workDir = path.join(root, "work");
    fs.mkdirSync(restrictedDir, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });
    const linkToDir = path.join(workDir, "alias-dir");
    fs.symlinkSync(restrictedDir, linkToDir);

    const nonExistentViaLink = path.join(linkToDir, "subdir", "new.txt");
    const m = matchRestrictedFolder(nonExistentViaLink, workDir, [restrictedDir]);
    assert.ok(m);
    assert.equal(m.canonicalTarget, path.join(fs.realpathSync(restrictedDir), "subdir", "new.txt"));
  });

  it("detects dangling symlinks pointing into a restricted folder", () => {
    const root = trackTempDir("rf-sym-dangling-");
    const restrictedDir = path.join(root, "vault");
    const workDir = path.join(root, "work");
    fs.mkdirSync(restrictedDir, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });
    const danglingLink = path.join(workDir, "dangling-write.txt");
    fs.symlinkSync(path.join(restrictedDir, "future.txt"), danglingLink);

    const m = matchRestrictedFolder(danglingLink, workDir, [restrictedDir]);
    assert.ok(m);
    assert.equal(m.canonicalTarget, path.join(fs.realpathSync(restrictedDir), "future.txt"));
  });

  it("detects nested paths traversing a symlink located inside a restricted folder", () => {
    const root = trackTempDir("rf-sym-inner-");
    const restrictedDir = path.join(root, "vault");
    const workDir = path.join(root, "work");
    const outsideDir = path.join(root, "outside");
    fs.mkdirSync(restrictedDir, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    const outsideFile = path.join(outsideDir, "public.txt");
    fs.writeFileSync(outsideFile, "public");

    const innerLink = path.join(restrictedDir, "link-out.txt");
    fs.symlinkSync(outsideFile, innerLink);
    assert.ok(matchRestrictedFolder(innerLink, workDir, [restrictedDir]));

    const innerDirLink = path.join(restrictedDir, "link-dir");
    fs.symlinkSync(outsideDir, innerDirLink);
    const nestedThroughInnerLink = path.join(innerDirLink, "public.txt");
    const m = matchRestrictedFolder(nestedThroughInnerLink, workDir, [restrictedDir]);
    assert.ok(m);
    assert.equal(m.restrictedRoot, fs.realpathSync(restrictedDir));
  });
});

describe("headless fail-closed + bash operand protection (#1416)", () => {
  it("denies restricted file/search/bash tool calls in headless mode", async () => {
    const root = trackTempDir("rf-headless-");
    const restricted = path.join(root, "restricted");
    const work = path.join(root, "work");
    fs.mkdirSync(restricted, { recursive: true });
    fs.mkdirSync(work, { recursive: true });
    const dbPath = path.join(root, "state.db");
    const hmacKeyPath = path.join(root, ".approval-hmac-key");

    for (const call of [
      { toolName: "read", input: { path: path.join(restricted, "a.txt") }, cwd: work },
      { toolName: "read", input: { path: `@${path.join(restricted, "a.txt")}` }, cwd: work },
      { toolName: "write", input: { path: path.join(restricted, "b.txt") }, cwd: work },
      { toolName: "edit", input: { path: path.join(restricted, "a.txt") }, cwd: work },
      { toolName: "grep", input: { pattern: "x", path: restricted }, cwd: work },
      { toolName: "grep", input: { pattern: "x" }, cwd: root },
      { toolName: "find", input: { pattern: "*.txt", path: root }, cwd: work },
      { toolName: "ls", input: { path: restricted }, cwd: work },
      { toolName: "bash", input: { command: "ls" }, cwd: restricted },
      { toolName: "bash", input: { command: `cd "${restricted}" && ls` }, cwd: work },
      { toolName: "bash", input: { command: `cd "${work}" && (cd "${restricted}" && ls)` }, cwd: work },
      { toolName: "bash", input: { command: `cat "${path.join(restricted, "a.txt")}"` }, cwd: work },
      { toolName: "bash", input: { command: `target="${restricted}"; cd "$target" && ls` }, cwd: work },
    ]) {
      const decision = await evaluateRestrictedFolderAccess({
        ...call,
        ui: null,
        restrictedFolders: [restricted],
        dbPath,
        hmacKeyPath,
      });
      assert.ok(decision?.block, `${call.toolName} (${JSON.stringify(call.input)}) must fail closed`);
    }

    const safeDecision = await evaluateRestrictedFolderAccess({
      toolName: "bash",
      input: { command: "echo ok" },
      cwd: work,
      ui: null,
      restrictedFolders: [restricted],
      dbPath,
      hmacKeyPath,
    });
    assert.equal(safeDecision, undefined);
  });

  it("fails closed on dynamic cd/pushd shell expansions in bash", async () => {
    const root = trackTempDir("rf-dyn-cd-");
    const restricted = path.join(root, "restricted");
    const work = path.join(root, "work");
    fs.mkdirSync(restricted, { recursive: true });
    fs.mkdirSync(work, { recursive: true });
    const dbPath = path.join(root, "state.db");
    const hmacKeyPath = path.join(root, ".approval-hmac-key");

    for (const cmd of [
      `cd "$DYNAMIC_DIR" && ls`,
      `cd "$(echo /tmp)" && ls`,
      `pushd "${root}/rest*" && ls`,
      `cd - && ls`,
    ]) {
      const decision = await evaluateRestrictedFolderAccess({
        toolName: "bash",
        input: { command: cmd },
        cwd: work,
        ui: null,
        restrictedFolders: [restricted],
        dbPath,
        hmacKeyPath,
      });
      assert.ok(decision?.block, `dynamic cd command must fail closed: ${cmd}`);
    }
  });

  it("blocks bash operands referencing $HOME, inherited env vars, or unresolved leading $VAR paths", async () => {
    const root = trackTempDir("rf-env-vars-");
    const fakeHome = path.join(root, "home");
    const sshDir = path.join(fakeHome, ".ssh");
    const vaultDir = path.join(root, "vault");
    const work = path.join(root, "work");
    fs.mkdirSync(sshDir, { recursive: true });
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.mkdirSync(work, { recursive: true });
    const dbPath = path.join(root, "state.db");
    const hmacKeyPath = path.join(root, ".approval-hmac-key");

    for (const cmd of [
      `cat "$HOME/.ssh/id_rsa"`,
      `cat "$MY_VAULT/key.txt"`,
      `cat "$UNKNOWN_DIR/secret.txt"`,
    ]) {
      const decision = await evaluateRestrictedFolderAccess({
        toolName: "bash",
        input: { command: cmd },
        cwd: work,
        ui: null,
        restrictedFolders: ["~/.ssh", vaultDir],
        dbPath,
        hmacKeyPath,
        homeDir: fakeHome,
        env: { HOME: fakeHome, MY_VAULT: vaultDir },
      });
      assert.ok(decision?.block, `env-var bash operand must be blocked: ${cmd}`);
    }
  });

  it("blocks restricted reads inside command substitutions, backticks, bash -c, or eval", async () => {
    const root = trackTempDir("rf-nested-shell-");
    const restricted = path.join(root, "restricted");
    const work = path.join(root, "work");
    fs.mkdirSync(restricted, { recursive: true });
    fs.mkdirSync(work, { recursive: true });
    const tokenFile = path.join(restricted, "token");
    fs.writeFileSync(tokenFile, "secret");
    const dbPath = path.join(root, "state.db");
    const hmacKeyPath = path.join(root, ".approval-hmac-key");

    for (const cmd of [
      `printf '%s\\n' "$(cat "${tokenFile}")"`,
      `echo \`cat ${tokenFile}\``,
      `bash -c 'cat "${tokenFile}"'`,
      `bash -c'cat "${tokenFile}"'`,
      `bash -c"cat ${tokenFile}"`,
      `bash -c$'cat ${tokenFile}'`,
      `eval "cat '${tokenFile}'"`,
    ]) {
      const decision = await evaluateRestrictedFolderAccess({
        toolName: "bash",
        input: { command: cmd },
        cwd: work,
        ui: null,
        restrictedFolders: [restricted],
        dbPath,
        hmacKeyPath,
      });
      assert.ok(decision?.block, `nested shell read must fail closed: ${cmd}`);
    }
  });

  it("blocks runtime-constructed bash paths targeting .approval-hmac-key even with empty restricted_folders", async () => {
    const root = trackTempDir("rf-hmac-escape-");
    for (const cmd of [
      `cat ~/.pi/agent/.approval-hmac-key`,
      `p=$(printf '\\056approval-hmac-key'); cat "$HOME/.pi/agent/$p"`,
      `p=$(printf '\\x2e%s-%s-%s' approval hmac key); cat "$HOME/.pi/agent/$p"`,
    ]) {
      const res = await evaluateBashPolicy({ command: cmd, cwd: root, ui: null });
      assert.equal(res.action, "block", `HMAC key access must be blocked: ${cmd}`);
    }

    // Even when restricted_folders is empty, evaluateRestrictedFolderAccess blocks direct read of HMAC key
    const fakeHome = trackTempDir("rf-hmac-home-");
    const directRead = await evaluateRestrictedFolderAccess({
      toolName: "read",
      input: { path: getApprovalHmacKeyPath(fakeHome) },
      cwd: root,
      ui: null,
      restrictedFolders: [],
      homeDir: fakeHome,
    });
    assert.ok(directRead?.block);
  });

  it("blocks hex-encoded ANSI-C quoted bash -c scripts entering restricted folders", async () => {
    const root = trackTempDir("rf-ansic-encoded-");
    const restricted = path.join(root, "restricted");
    const work = path.join(root, "work");
    fs.mkdirSync(restricted, { recursive: true });
    fs.mkdirSync(work, { recursive: true });
    const dbPath = path.join(root, "state.db");
    const hmacKeyPath = path.join(root, ".approval-hmac-key");

    // Encode `cd <restricted>; cat secret` completely in ANSI-C \xHH escapes so no literal slash or `cd` appears
    const hexEncode = (s: string) =>
      [...s].map((c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`).join("");
    const encodedBody = hexEncode(`cd ${restricted}; cat secret`);

    for (const cmd of [
      `bash -c $'${encodedBody}'`,
      `bash -c$'${encodedBody}'`,
    ]) {
      const decision = await evaluateRestrictedFolderAccess({
        toolName: "bash",
        input: { command: cmd },
        cwd: work,
        ui: null,
        restrictedFolders: [restricted],
        dbPath,
        hmacKeyPath,
      });
      assert.ok(decision?.block, `encoded ANSI-C bash -c script must be blocked: ${cmd}`);
    }
  });

  it("blocks ANSI-C quoted attached bash -c deletion of state.db", async () => {
    const root = trackTempDir("rf-ansic-bash-");
    for (const cmd of [
      `bash -c$'rm .pi/data/state.db'`,
      `bash -c $'\\x72\\x6d \\x2epi/data/state.db'`,
      `bash -c$'\\x72\\x6d \\x2epi/data/state.db'`,
    ]) {
      const res = await evaluateBashPolicy({ command: cmd, cwd: root, ui: null });
      assert.equal(res.action, "block", `ANSI-C bash -c delete must be blocked: ${cmd}`);
    }
  });

  it("blocks indirect parameter expansion overwriting state.db", async () => {
    const root = trackTempDir("rf-indirect-param-");
    for (const cmd of [
      `p=.pi/data/state.db; x=p; cp /dev/null "\${!x}"`,
      `p=.pi/data/state.db; x=p; rm "\${!x}"`,
    ]) {
      const res = await evaluateBashPolicy({ command: cmd, cwd: root, ui: null });
      assert.equal(res.action, "block", `indirect expansion tamper must be blocked: ${cmd}`);
    }
  });

  it("blocks positional-parameter state.db deletion when review_loop_enforcement is disabled", async () => {
    const root = trackTempDir("rf-pos-param-");
    for (const cmd of [
      `set -- .pi/data/state.db; rm "$1"`,
      `set -- .pi/data state.db; rm "$1/$2"`,
    ]) {
      const res = await evaluateBashPolicy({ command: cmd, cwd: root, ui: null });
      assert.equal(res.action, "block", `positional state.db delete must be blocked: ${cmd}`);
    }
  });

  it("allows documented read-only sqlite3 SELECT inspection on .pi/data/state.db", async () => {
    const root = trackTempDir("rf-sqlite-ro-");
    const readOnlyCmd =
      `sqlite3 .pi/data/state.db "SELECT payload FROM kv_state WHERE store_key='memory-scoring'" | jq -r '.entries'`;
    const res = await evaluateBashPolicy({ command: readOnlyCmd, cwd: root, ui: null });
    assert.equal(res.action, "allow", "verifiably read-only sqlite3 SELECT inspection must be allowed");
  });

  it("blocks mutating or unclassifiable sqlite3 commands on .pi/data/state.db", async () => {
    const root = trackTempDir("rf-sqlite-rw-");
    for (const cmd of [
      `d=".pi/data"; f="state.db"; sqlite3 "$d/$f" "INSERT INTO restricted_folder_approvals VALUES (1,'file','/a','/a','','now')"`,
      `sqlite3 .pi/data/state.db "SELECT 1; DELETE FROM restricted_folder_approvals"`,
      `sqlite3 .pi/data/state.db "SELECT writefile('.pi/data/state.db-wal',X'00')"`,
      `echo "DELETE FROM restricted_folder_approvals" | sqlite3 .pi/data/state.db`,
      `python3 -c 'import sqlite3; sqlite3.connect(".pi/data/" + "state.db").execute("DELETE FROM restricted_folder_approvals")'`,
    ]) {
      const res = await evaluateBashPolicy({ command: cmd, cwd: root, ui: null });
      assert.equal(res.action, "block", `mutating sqlite command must be blocked: ${cmd}`);
    }
  });
});

describe("tiered session + SQLite approval grants (#1416)", () => {
  it("denies access on explicit Deny or cancelled prompt", async () => {
    const fx = createGrantFixture();
    for (const choice of [CHOICE_DENY, undefined]) {
      const decision = await evaluateRestrictedFolderAccess({
        toolName: "read",
        input: { path: fx.fileA },
        cwd: fx.root,
        sessionId: "s1",
        ui: { async select() { return choice; } },
        restrictedFolders: [fx.restricted],
        dbPath: fx.dbPath,
        hmacKeyPath: fx.hmacKeyPath,
      });
      assert.ok(decision?.block);
    }
  });

  it("re-prompts on subsequent calls after Approve Once", async () => {
    const fx = createGrantFixture();
    let prompts = 0;
    const ui = { async select() { prompts++; return CHOICE_APPROVE_ONCE; } };
    assert.equal(
      await evaluateRestrictedFolderAccess({
        toolName: "read",
        input: { path: fx.fileA },
        cwd: fx.root,
        sessionId: "s1",
        ui,
        restrictedFolders: [fx.restricted],
        dbPath: fx.dbPath,
        hmacKeyPath: fx.hmacKeyPath,
      }),
      undefined,
    );
    assert.equal(
      await evaluateRestrictedFolderAccess({
        toolName: "read",
        input: { path: fx.fileA },
        cwd: fx.root,
        sessionId: "s1",
        ui,
        restrictedFolders: [fx.restricted],
        dbPath: fx.dbPath,
        hmacKeyPath: fx.hmacKeyPath,
      }),
      undefined,
    );
    assert.equal(prompts, 2);
  });

  it("caches Approve File (this session) per exact file within the same session only", async () => {
    const fx = createGrantFixture();
    let prompts = 0;
    let choice: string = CHOICE_APPROVE_FILE_SESSION;
    const ui = { async select() { prompts++; return choice; } };

    assert.equal(
      await evaluateRestrictedFolderAccess({
        toolName: "read",
        input: { path: fx.fileA },
        cwd: fx.root,
        sessionId: "s1",
        ui,
        restrictedFolders: [fx.restricted],
        dbPath: fx.dbPath,
        hmacKeyPath: fx.hmacKeyPath,
      }),
      undefined,
    );
    assert.equal(
      await evaluateRestrictedFolderAccess({
        toolName: "read",
        input: { path: fx.fileA },
        cwd: fx.root,
        sessionId: "s1",
        ui,
        restrictedFolders: [fx.restricted],
        dbPath: fx.dbPath,
        hmacKeyPath: fx.hmacKeyPath,
      }),
      undefined,
    );
    assert.equal(prompts, 1);

    choice = CHOICE_DENY;
    assert.ok(
      (
        await evaluateRestrictedFolderAccess({
          toolName: "read",
          input: { path: fx.fileB },
          cwd: fx.root,
          sessionId: "s1",
          ui,
          restrictedFolders: [fx.restricted],
          dbPath: fx.dbPath,
          hmacKeyPath: fx.hmacKeyPath,
        })
      )?.block,
    );
    assert.ok(
      (
        await evaluateRestrictedFolderAccess({
          toolName: "read",
          input: { path: fx.fileA },
          cwd: fx.root,
          sessionId: "s2",
          ui,
          restrictedFolders: [fx.restricted],
          dbPath: fx.dbPath,
          hmacKeyPath: fx.hmacKeyPath,
        })
      )?.block,
    );
  });

  it("persists Approve File (persistent) in SQLite across sessions", async () => {
    const fx = createGrantFixture();
    let prompts = 0;
    const ui = { async select() { prompts++; return CHOICE_APPROVE_FILE_PERSISTENT; } };

    assert.equal(
      await evaluateRestrictedFolderAccess({
        toolName: "read",
        input: { path: fx.fileB },
        cwd: fx.root,
        sessionId: "s1",
        ui,
        restrictedFolders: [fx.restricted],
        dbPath: fx.dbPath,
        hmacKeyPath: fx.hmacKeyPath,
      }),
      undefined,
    );
    assert.equal(listPersistentApprovals(fx.root, fx.dbPath, fx.hmacKeyPath).length, 1);
    clearSessionApprovals();

    assert.equal(
      await evaluateRestrictedFolderAccess({
        toolName: "read",
        input: { path: fx.fileB },
        cwd: fx.root,
        sessionId: "s99",
        ui,
        restrictedFolders: [fx.restricted],
        dbPath: fx.dbPath,
        hmacKeyPath: fx.hmacKeyPath,
      }),
      undefined,
    );
    assert.equal(prompts, 1);
  });

  it("restricts Approve Directory grants to direct children only (never grandchildren)", async () => {
    const fx = createGrantFixture();
    let prompts = 0;
    let choice: string = CHOICE_APPROVE_DIR_SESSION;
    const ui = { async select() { prompts++; return choice; } };

    assert.equal(
      await evaluateRestrictedFolderAccess({
        toolName: "read",
        input: { path: fx.subChild1 },
        cwd: fx.root,
        sessionId: "s1",
        ui,
        restrictedFolders: [fx.restricted],
        dbPath: fx.dbPath,
        hmacKeyPath: fx.hmacKeyPath,
      }),
      undefined,
    );
    assert.equal(
      await evaluateRestrictedFolderAccess({
        toolName: "read",
        input: { path: fx.subChild2 },
        cwd: fx.root,
        sessionId: "s1",
        ui,
        restrictedFolders: [fx.restricted],
        dbPath: fx.dbPath,
        hmacKeyPath: fx.hmacKeyPath,
      }),
      undefined,
    );
    assert.equal(prompts, 1);

    choice = CHOICE_DENY;
    assert.ok(
      (
        await evaluateRestrictedFolderAccess({
          toolName: "read",
          input: { path: fx.grandChild },
          cwd: fx.root,
          sessionId: "s1",
          ui,
          restrictedFolders: [fx.restricted],
          dbPath: fx.dbPath,
          hmacKeyPath: fx.hmacKeyPath,
        })
      )?.block,
    );
    assert.equal(
      grantCoversPath({ scope: "directory", targetPath: fs.realpathSync(fx.subDir) }, fs.realpathSync(fx.subChild2)),
      true,
    );
    assert.equal(
      grantCoversPath({ scope: "directory", targetPath: fs.realpathSync(fx.subDir) }, fs.realpathSync(fx.grandChild)),
      false,
    );
  });

  it("clears cached grants via forgetApprovals", async () => {
    const fx = createGrantFixture();
    addSessionApproval("s1", "file", fs.realpathSync(fx.fileA), fs.realpathSync(fx.restricted));
    addPersistentApproval(fx.root, "directory", fs.realpathSync(fx.subDir), fs.realpathSync(fx.restricted), fx.dbPath, fx.hmacKeyPath);

    const cleared = forgetApprovals(fx.root, "s1", "all", fx.dbPath);
    assert.equal(cleared.sessionCleared, 1);
    assert.equal(cleared.persistentCleared, 1);
    assert.equal(listSessionApprovals("s1").length, 0);
    assert.equal(listPersistentApprovals(fx.root, fx.dbPath, fx.hmacKeyPath).length, 0);
  });

  it("isolates ID-less contexts by omitting session choices without a sessionId", async () => {
    const fx = createGrantFixture();
    assert.equal(addSessionApproval(null, "file", fx.fileA, fx.restricted), null);
    assert.equal(addSessionApproval("   ", "file", fx.fileA, fx.restricted), null);
    assert.deepEqual(listSessionApprovals(null), []);

    const offeredOptions: string[][] = [];
    const ui = {
      async select(_title: string, options: string[]) {
        offeredOptions.push(options);
        return CHOICE_APPROVE_FILE_SESSION;
      },
    };
    assert.equal(
      await evaluateRestrictedFolderAccess({
        toolName: "read",
        input: { path: fx.fileA },
        cwd: fx.root,
        sessionId: null,
        ui,
        restrictedFolders: [fx.restricted],
        dbPath: fx.dbPath,
        hmacKeyPath: fx.hmacKeyPath,
      }),
      undefined,
    );
    assert.ok(!offeredOptions[0]!.includes(CHOICE_APPROVE_FILE_SESSION));
    assert.ok(!offeredOptions[0]!.includes(CHOICE_APPROVE_DIR_SESSION));

    const ctx2 = await evaluateRestrictedFolderAccess({
      toolName: "read",
      input: { path: fx.fileA },
      cwd: fx.root,
      sessionId: null,
      ui: null,
      restrictedFolders: [fx.restricted],
      dbPath: fx.dbPath,
      hmacKeyPath: fx.hmacKeyPath,
    });
    assert.ok(ctx2?.block);
  });

  it("requires explicit recursive approval for grep on a directory even with a one-level directory grant", async () => {
    const fx = createGrantFixture();
    addSessionApproval("sess-rec", "directory", fs.realpathSync(fx.restricted), fs.realpathSync(fx.restricted));

    const titles: string[] = [];
    const optionsSeen: string[][] = [];
    const decision = await evaluateRestrictedFolderAccess({
      toolName: "grep",
      input: { pattern: "deep", path: fx.restricted },
      cwd: fx.root,
      sessionId: "sess-rec",
      ui: {
        async select(title, options) {
          titles.push(title);
          optionsSeen.push(options);
          return CHOICE_DENY;
        },
      },
      restrictedFolders: [fx.restricted],
      dbPath: fx.dbPath,
      hmacKeyPath: fx.hmacKeyPath,
    });
    assert.ok(decision?.block);
    assert.match(titles[0]!, /recursive/i);
    assert.deepEqual(optionsSeen[0], [CHOICE_DENY, CHOICE_APPROVE_ONCE]);
  });

  it("honors a cached file grant for single-file grep", async () => {
    const fx = createGrantFixture();
    addSessionApproval("sess-file-grep", "file", fs.realpathSync(fx.fileA), fs.realpathSync(fx.restricted));
    const decision = await evaluateRestrictedFolderAccess({
      toolName: "grep",
      input: { pattern: "a", path: fx.fileA },
      cwd: fx.root,
      sessionId: "sess-file-grep",
      ui: null,
      restrictedFolders: [fx.restricted],
      dbPath: fx.dbPath,
      hmacKeyPath: fx.hmacKeyPath,
    });
    assert.equal(decision, undefined);
  });

  it("rejects forged SQLite restricted_folder_approvals rows with invalid HMAC signatures", async () => {
    const fx = createGrantFixture();
    addPersistentApproval(fx.root, "file", fs.realpathSync(fx.fileB), fs.realpathSync(fx.restricted), fx.dbPath, fx.hmacKeyPath);

    const db = openStateDb(fx.dbPath);
    db.prepare(
      "INSERT INTO restricted_folder_approvals (scope, target_path, restricted_root, signature, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("file", fs.realpathSync(fx.fileA), fs.realpathSync(fx.restricted), "0".repeat(64), new Date().toISOString());

    const validGrants = listPersistentApprovals(fx.root, fx.dbPath, fx.hmacKeyPath);
    assert.equal(validGrants.length, 1);
    assert.equal(validGrants[0]!.targetPath, fs.realpathSync(fx.fileB));

    const forgedCheck = await evaluateRestrictedFolderAccess({
      toolName: "read",
      input: { path: fx.fileA },
      cwd: fx.root,
      ui: null,
      restrictedFolders: [fx.restricted],
      dbPath: fx.dbPath,
      hmacKeyPath: fx.hmacKeyPath,
    });
    assert.ok(forgedCheck?.block);
  });

  it("rejects a legitimately signed approval row copied into another project's database", async () => {
    const fxA = createGrantFixture();
    const projB = trackTempDir("rf-proj-b-");
    const dbPathB = path.join(projB, "state.db");
    // Shared HMAC key on the same machine, distinct project databases
    addPersistentApproval(fxA.root, "file", fs.realpathSync(fxA.fileA), fs.realpathSync(fxA.restricted), fxA.dbPath, fxA.hmacKeyPath);

    const rowFromA = openStateDb(fxA.dbPath)
      .prepare("SELECT scope, target_path, restricted_root, signature, created_at FROM restricted_folder_approvals")
      .get() as { scope: string; target_path: string; restricted_root: string; signature: string; created_at: string };

    // Copy the exact signed row from Project A into Project B's DB
    openStateDb(dbPathB)
      .prepare(
        "INSERT INTO restricted_folder_approvals (scope, target_path, restricted_root, signature, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(rowFromA.scope, rowFromA.target_path, rowFromA.restricted_root, rowFromA.signature, rowFromA.created_at);

    assert.equal(listPersistentApprovals(projB, dbPathB, fxA.hmacKeyPath).length, 0);
    const crossProjDecision = await evaluateRestrictedFolderAccess({
      toolName: "read",
      input: { path: fxA.fileA },
      cwd: projB,
      ui: null,
      restrictedFolders: [fxA.restricted],
      dbPath: dbPathB,
      hmacKeyPath: fxA.hmacKeyPath,
    });
    assert.ok(crossProjDecision?.block, "copied grant from Project A must fail verification in Project B");
  });

  it("upgrades a pre-existing schema v3 state.db so persistent approvals save cleanly", () => {
    const root = trackTempDir("rf-v3-upgrade-");
    const restricted = path.join(root, "restricted");
    fs.mkdirSync(restricted, { recursive: true });
    const fileA = path.join(restricted, "a.txt");
    fs.writeFileSync(fileA, "secret");
    const dbPath = path.join(root, "state.db");
    const hmacKeyPath = path.join(root, ".approval-hmac-key");

    // Create a pre-upgrade v3 database missing `restricted_folder_approvals`
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE kv_state (store_key TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL);
      CREATE TABLE migrated_stores (store_key TEXT PRIMARY KEY, source_path TEXT NOT NULL, migrated_at TEXT NOT NULL, source_mtime_ms REAL NOT NULL DEFAULT 0, source_size INTEGER NOT NULL DEFAULT 0);
      INSERT INTO schema_version (version, applied_at) VALUES (3, '2026-01-01T00:00:00.000Z');
    `);
    legacy.close();

    addPersistentApproval(root, "file", fs.realpathSync(fileA), fs.realpathSync(restricted), dbPath, hmacKeyPath);
    const grants = listPersistentApprovals(root, dbPath, hmacKeyPath);
    assert.equal(grants.length, 1);
    const version = openStateDb(dbPath).prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
    assert.equal(version.v, CURRENT_SCHEMA_VERSION);
  });
});

describe("registerEnforcement integration (#1416)", () => {
  function setupEnforcementProject() {
    const cwd = trackTempDir("rf-enf-");
    const restricted = path.join(cwd, "secrets");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.mkdirSync(restricted, { recursive: true });
    const secretFile = path.join(restricted, "token.txt");
    fs.writeFileSync(secretFile, "xyz");
    fs.writeFileSync(
      path.join(cwd, ".pi", "pi-config-settings.json"),
      JSON.stringify({ restricted_folders: ["secrets"] }),
    );
    setGlobalSettingsPath(path.join(cwd, "nonexistent-global.json"));
    clearSettingsCache();
    return { cwd, restricted, secretFile, ...createEnforcementHarness(cwd) };
  }

  it("blocks direct agent writes to project state.db", async () => {
    const { cwd, callTool } = setupEnforcementProject();
    const res = await callTool(
      { type: "tool_call", toolName: "write", input: { path: getProjectStateDbPath(cwd), content: "" } },
      { cwd, hasUI: false, ui: {} },
    );
    assert.ok(res?.block);
  });

  it("blocks direct agent reads of .approval-hmac-key", async () => {
    const { cwd, callTool } = setupEnforcementProject();
    const res = await callTool(
      { type: "tool_call", toolName: "read", input: { path: getApprovalHmacKeyPath() } },
      { cwd, hasUI: false, ui: {} },
    );
    assert.ok(res?.block);
  });

  it("prompts via ui-bridge with blockedKind permission on interactive restricted read", async () => {
    const { cwd, secretFile, callTool } = setupEnforcementProject();
    const seenKinds: string[] = [];
    const ctx = {
      cwd,
      hasUI: true,
      sessionManager: { getSessionId: () => "sess-perm" },
      ui: {
        async select(_title: string, _opts: string[], opts?: { blockedKind?: string }) {
          if (opts?.blockedKind) seenKinds.push(opts.blockedKind);
          return CHOICE_APPROVE_ONCE;
        },
        notify() {},
      },
    };
    assert.equal(await callTool({ type: "tool_call", toolName: "read", input: { path: secretFile } }, ctx), undefined);
    assert.deepEqual(seenKinds, ["permission"]);
  });

  it("preserves session grants on reload shutdown while clearing them on exit shutdown", async () => {
    const { cwd, secretFile, handlers, callTool } = setupEnforcementProject();
    const ctx = {
      cwd,
      hasUI: true,
      sessionManager: { getSessionId: () => "sess-reload-test" },
      ui: {
        async select() { return CHOICE_APPROVE_DIR_SESSION; },
        notify() {},
      },
    };
    assert.equal(await callTool({ type: "tool_call", toolName: "read", input: { path: secretFile } }, ctx), undefined);
    assert.equal(listSessionApprovals("sess-reload-test").length, 1);

    for (const h of handlers.get("session_shutdown") ?? []) {
      await h({ reason: "reload" }, ctx);
    }
    assert.equal(listSessionApprovals("sess-reload-test").length, 1);

    for (const h of handlers.get("session_shutdown") ?? []) {
      await h({ reason: "exit" }, ctx);
    }
    assert.equal(listSessionApprovals("sess-reload-test").length, 0);
  });

  it("clears persistent SQLite grants via the /forget-approvals command", async () => {
    const { cwd, secretFile, commands, callTool } = setupEnforcementProject();
    const notifications: string[] = [];
    const interactiveCtx = {
      cwd,
      hasUI: true,
      sessionManager: { getSessionId: () => "sess-forget" },
      ui: {
        async select() { return CHOICE_APPROVE_FILE_PERSISTENT; },
        notify(msg: string) { notifications.push(msg); },
      },
    };
    const headlessCtx = {
      cwd,
      hasUI: false,
      sessionManager: { getSessionId: () => "sess-forget-h" },
      ui: {},
    };

    assert.equal(
      await callTool({ type: "tool_call", toolName: "read", input: { path: secretFile } }, interactiveCtx),
      undefined,
    );
    assert.equal(listPersistentApprovals(cwd).length, 1);

    const forgetCmd = commands.get("forget-approvals");
    assert.ok(forgetCmd);
    await forgetCmd!.handler("", interactiveCtx);

    assert.equal(listPersistentApprovals(cwd).length, 0);
    assert.ok(notifications.some((m) => m.includes("Cleared 0 session approval(s) and 1 persistent approval(s)")));
    const blockedAfter = await callTool({ type: "tool_call", toolName: "read", input: { path: secretFile } }, headlessCtx);
    assert.ok(blockedAfter?.block);
  });
});
