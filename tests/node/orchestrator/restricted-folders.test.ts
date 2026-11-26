/**
 * Unit tests for restricted_folders enforcement, tiered approval grants, and
 * /forget-approvals (issue #1416).
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

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
} from "../../../extensions/orchestrator/restricted-folders.js";
import { closeStateDbs, getProjectStateDbPath, openStateDb } from "../../../extensions/orchestrator/state-db.js";
import { validateSettingValue } from "../../../extensions/pidash/browser-ops.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

const tempDirs: string[] = [];
function trackTempDir(prefix: string): string {
  const dir = makeTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  clearSessionApprovals();
  clearRestrictedFoldersFloor();
  clearSettingsCache();
  setGlobalSettingsPath(null);
  closeStateDbs();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("restricted_folders settings schema & agent-edit protection (#1416)", () => {
  it("defines restricted_folders as string_list with default [] and no env override", () => {
    const def = SETTINGS_KEYS.restricted_folders;
    assert.ok(def, "restricted_folders key must exist in settings-keys.json");
    assert.equal(def.type, "string_list");
    assert.deepEqual(def.default, []);
    assert.equal(def.env, undefined, "ambient env must not alter restricted_folders");
    assert.equal(def.group, "Enforcement");
  });

  it("protects restricted_folders from agent edits, @-prefixed writes, fragmented bash scripts, and browser writes", async () => {
    const cwd = trackTempDir("rf-protect-");
    const projSettings = path.join(cwd, ".pi", "pi-config-settings.json");
    const writeDecision = evaluateFileWritePolicy(projSettings, cwd);
    assert.ok(writeDecision?.block, "agent write to pi-config-settings.json must be blocked");
    assert.match(writeDecision!.reason, /restricted folders/i);

    const atWriteDecision = evaluateFileWritePolicy(`@${projSettings}`, cwd);
    assert.ok(atWriteDecision?.block, "@-prefixed write to pi-config-settings.json must be blocked");

    // Dynamically assembled settings paths in bash redirects must be blocked
    for (const cmd of [
      `p="pi-config"; s="settings.json"; echo '{"restricted_folders":[]}' > ".pi/$p-$s"`,
      `echo '{"restricted_folders":[]}' > .pi/"pi-config""-settings.json"`,
    ]) {
      const res = await evaluateBashPolicy({ command: cmd, cwd, ui: null });
      assert.equal(res.action, "block", `fragmented settings write must be blocked: ${cmd}`);
    }

    // Even if an external script overwrites .pi/pi-config-settings.json directly to clear
    // restricted_folders, the monotonic in-process floor retains the initial restrictions
    // while authorized human updates via updateSetting() can remove them cleanly.
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(projSettings, JSON.stringify({ restricted_folders: ["secrets/prod"] }));
    setGlobalSettingsPath(path.join(cwd, "nonexistent-global.json"));
    clearSettingsCache();
    assert.deepEqual(loadRestrictedFolders(cwd), ["secrets/prod"]);

    // Simulate external tamper rewriting the settings file with []
    fs.writeFileSync(projSettings, JSON.stringify({ restricted_folders: [] }));
    clearSettingsCache();
    assert.deepEqual(
      loadRestrictedFolders(cwd),
      ["secrets/prod"],
      "external overwrite of .pi/pi-config-settings.json must NOT clear project restricted_folders",
    );

    // Authorized human save via updateSetting() updates the floor legitimately
    const upd = updateSetting(cwd, "project", "restricted_folders", []);
    assert.equal(upd.ok, true);
    assert.deepEqual(loadRestrictedFolders(cwd), []);

    const browserErr = validateSettingValue("restricted_folders", []);
    assert.ok(browserErr, "browser write to restricted_folders must be refused");
    assert.match(browserErr!, /terminal settings editor/);
  });

  it("unions global and project restricted_folders so project settings cannot clear global restrictions", () => {
    const cwd = trackTempDir("rf-union-proj-");
    const globalDir = trackTempDir("rf-union-global-");
    const globalSettings = path.join(globalDir, "pi-config-settings.json");
    setGlobalSettingsPath(globalSettings);

    fs.writeFileSync(globalSettings, JSON.stringify({ restricted_folders: ["~/.ssh", "~/.aws"] }));
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    // Even if project attempts to set [] or another list, global entries remain enforced!
    fs.writeFileSync(
      path.join(cwd, ".pi", "pi-config-settings.json"),
      JSON.stringify({ restricted_folders: ["secrets/prod"] }),
    );
    clearSettingsCache();

    const loaded = loadRestrictedFolders(cwd);
    assert.deepEqual(loaded, ["~/.ssh", "~/.aws", "secrets/prod"]);

    // Verify empty project array (without prior project entries) still keeps global entries
    clearRestrictedFoldersFloor(cwd);
    fs.writeFileSync(
      path.join(cwd, ".pi", "pi-config-settings.json"),
      JSON.stringify({ restricted_folders: [] }),
    );
    clearSettingsCache();
    assert.deepEqual(loadRestrictedFolders(cwd), ["~/.ssh", "~/.aws"]);
  });
});

describe("path boundary & symlink-safe matching (#1416)", () => {
  it("enforces strict path boundaries: /a/foo never matches /a/foobar", () => {
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

  it("expands ~ and resolves relative paths against cwd", () => {
    const root = trackTempDir("rf-tilde-");
    const fakeHome = path.join(root, "home");
    const sshDir = path.join(fakeHome, ".ssh");
    const relSecrets = path.join(root, "workspace", "secrets");
    fs.mkdirSync(sshDir, { recursive: true });
    fs.mkdirSync(relSecrets, { recursive: true });

    const mHome = matchRestrictedFolder("~/.ssh/id_rsa", root, ["~/.ssh"], false, fakeHome);
    assert.ok(mHome, "~ restricted folder must match ~ target");

    const mRel = matchRestrictedFolder(
      "secrets/api.env",
      path.join(root, "workspace"),
      ["secrets"],
      false,
      fakeHome,
    );
    assert.ok(mRel, "relative restricted folder must resolve against cwd");

    // @-prefixed paths and Unicode spaces (matching Pi's resolveToCwd)
    const mAtHome = matchRestrictedFolder("@~/.ssh/id_rsa", root, ["~/.ssh"], false, fakeHome);
    assert.ok(mAtHome, "@~/.ssh/id_rsa must match ~/.ssh");
    const mAtRel = matchRestrictedFolder(
      "@secrets/api.env",
      path.join(root, "workspace"),
      ["secrets"],
      false,
      fakeHome,
    );
    assert.ok(mAtRel, "@secrets/api.env must match relative secrets folder");

    const spaceDir = path.join(root, "my secrets");
    fs.mkdirSync(spaceDir, { recursive: true });
    const mUnicodeSpace = matchRestrictedFolder(
      path.join(root, "my\u00A0secrets", "k.txt"),
      root,
      [spaceDir],
      false,
      fakeHome,
    );
    assert.ok(mUnicodeSpace, "Unicode space in path must normalize to ASCII space and match");
  });

  it("blocks symlink escapes (existing target, non-existent child under symlinked parent, dangling symlink, and inner symlink)", () => {
    const root = trackTempDir("rf-symlink-");
    const restrictedDir = path.join(root, "vault");
    const workDir = path.join(root, "work");
    const outsideDir = path.join(root, "outside");
    fs.mkdirSync(restrictedDir, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    const secretFile = path.join(restrictedDir, "key.pem");
    fs.writeFileSync(secretFile, "top-secret");

    // 1. Symlink to existing file inside restricted folder
    const linkToFile = path.join(workDir, "innocent.txt");
    fs.symlinkSync(secretFile, linkToFile);
    const m1 = matchRestrictedFolder(linkToFile, workDir, [restrictedDir]);
    assert.ok(m1, "symlink pointing to restricted file must match");
    assert.equal(m1.canonicalTarget, fs.realpathSync(secretFile));

    // 2. Non-existent file under symlinked parent pointing into restricted folder
    const linkToDir = path.join(workDir, "alias-dir");
    fs.symlinkSync(restrictedDir, linkToDir);
    const nonExistentViaLink = path.join(linkToDir, "subdir", "new.txt");
    const m2 = matchRestrictedFolder(nonExistentViaLink, workDir, [restrictedDir]);
    assert.ok(m2, "non-existent child under symlinked parent must match");
    assert.equal(m2.canonicalTarget, path.join(fs.realpathSync(restrictedDir), "subdir", "new.txt"));

    // 3. Dangling symlink pointing directly to non-existent file inside restricted folder
    const danglingLink = path.join(workDir, "dangling-write.txt");
    fs.symlinkSync(path.join(restrictedDir, "future.txt"), danglingLink);
    const m3 = matchRestrictedFolder(danglingLink, workDir, [restrictedDir]);
    assert.ok(m3, "dangling symlink pointing into restricted folder must match");
    assert.equal(m3.canonicalTarget, path.join(fs.realpathSync(restrictedDir), "future.txt"));

    // 4. Symlink located INSIDE restricted folder pointing outside (both direct and nested child!)
    const outsideFile = path.join(outsideDir, "public.txt");
    fs.writeFileSync(outsideFile, "public");
    const innerLink = path.join(restrictedDir, "link-out.txt");
    fs.symlinkSync(outsideFile, innerLink);
    const m4 = matchRestrictedFolder(innerLink, workDir, [restrictedDir]);
    assert.ok(m4, "symlink living inside restricted folder must match");

    const innerDirLink = path.join(restrictedDir, "link-dir");
    fs.symlinkSync(outsideDir, innerDirLink);
    const nestedThroughInnerLink = path.join(innerDirLink, "public.txt");
    const m5 = matchRestrictedFolder(nestedThroughInnerLink, workDir, [restrictedDir]);
    assert.ok(m5, "nested path beneath symlink inside restricted folder must match");
    assert.equal(m5.restrictedRoot, fs.realpathSync(restrictedDir));
  });
});

describe("headless fail-closed & tiered session/SQLite approval grants (#1416)", () => {
  it("fails closed (denies) in headless/non-TUI contexts for read/write/edit/search and bash cwd", async () => {
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
      { toolName: "grep", input: { pattern: "x" }, cwd: root }, // omitted path defaults to ancestor cwd
      { toolName: "find", input: { pattern: "*.txt", path: root }, cwd: work }, // explicit ancestor path
      { toolName: "ls", input: { path: restricted }, cwd: work },
      { toolName: "bash", input: { command: "ls" }, cwd: restricted },
      { toolName: "bash", input: { command: `cd "${restricted}" && ls` }, cwd: work },
      { toolName: "bash", input: { command: `cd "${work}" && (cd "${restricted}" && ls)` }, cwd: work },
      { toolName: "bash", input: { command: `cat "${path.join(restricted, "a.txt")}"` }, cwd: work },
      { toolName: "bash", input: { command: `target="${restricted}"; cd "$target" && ls` }, cwd: work },
      { toolName: "bash", input: { command: `cd "$DYNAMIC_DIR" && ls` }, cwd: work },
      { toolName: "bash", input: { command: `cd "$(echo /tmp)" && ls` }, cwd: work },
      { toolName: "bash", input: { command: `pushd "${root}/rest*" && ls` }, cwd: work },
      { toolName: "bash", input: { command: `cd - && ls` }, cwd: work },
    ]) {
      const decision = await evaluateRestrictedFolderAccess({
        ...call,
        ui: null,
        restrictedFolders: [restricted],
        dbPath,
        hmacKeyPath,
      });
      assert.ok(decision?.block, `${call.toolName} (${JSON.stringify(call.input)}) must fail closed in headless mode`);
      assert.match(decision!.reason, /headless|interactive approval/i);
    }

    // Non-restricted bash command succeeds without prompt
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

  it("isolates ID-less contexts (never shares __default__ bucket) and omits session choices without sessionId", async () => {
    const root = trackTempDir("rf-idless-");
    const restricted = path.join(root, "restricted");
    fs.mkdirSync(restricted, { recursive: true });
    const fileA = path.join(restricted, "a.txt");
    fs.writeFileSync(fileA, "secret");
    const dbPath = path.join(root, "state.db");
    const hmacKeyPath = path.join(root, ".approval-hmac-key");

    // Direct API: addSessionApproval/listSessionApprovals ignore null/blank sessionId
    assert.equal(addSessionApproval(null, "file", fileA, restricted), null);
    assert.equal(addSessionApproval("   ", "file", fileA, restricted), null);
    assert.deepEqual(listSessionApprovals(null), []);
    assert.deepEqual(listSessionApprovals(""), []);

    const offeredOptions: string[][] = [];
    const ui = {
      async select(_title: string, options: string[]) {
        offeredOptions.push(options);
        return CHOICE_APPROVE_FILE_SESSION; // Even if forcibly returned, must not cache without sessionId
      },
    };

    // Context 1 (null sessionId) approves
    assert.equal(
      await evaluateRestrictedFolderAccess({
        toolName: "read",
        input: { path: fileA },
        cwd: root,
        sessionId: null,
        ui,
        restrictedFolders: [restricted],
        dbPath,
        hmacKeyPath,
      }),
      undefined,
    );
    assert.ok(
      !offeredOptions[0]!.includes(CHOICE_APPROVE_FILE_SESSION) &&
        !offeredOptions[0]!.includes(CHOICE_APPROVE_DIR_SESSION),
      "session choices must be omitted when sessionId is missing",
    );

    // Context 2 (also null sessionId) MUST still be denied when headless (no leaked approval!)
    const ctx2Decision = await evaluateRestrictedFolderAccess({
      toolName: "read",
      input: { path: fileA },
      cwd: root,
      sessionId: null,
      ui: null,
      restrictedFolders: [restricted],
      dbPath,
      hmacKeyPath,
    });
    assert.ok(ctx2Decision?.block, "second ID-less context must not inherit approval from first");
  });

  it("blocks recursive grep/find even when directory has a one-level grant, while honoring single-file grep grant", async () => {
    const root = trackTempDir("rf-recursive-");
    const restricted = path.join(root, "restricted");
    const nested = path.join(restricted, "nested");
    fs.mkdirSync(nested, { recursive: true });
    const topFile = path.join(restricted, "top.txt");
    const deepFile = path.join(nested, "deep.txt");
    fs.writeFileSync(topFile, "hello");
    fs.writeFileSync(deepFile, "secret");
    const dbPath = path.join(root, "state.db");
    const hmacKeyPath = path.join(root, ".approval-hmac-key");

    // Grant direct-children-only directory access on `restricted`
    addSessionApproval("sess-rec", "directory", fs.realpathSync(restricted), fs.realpathSync(restricted));

    // Direct child read IS allowed
    assert.equal(
      await evaluateRestrictedFolderAccess({
        toolName: "read",
        input: { path: topFile },
        cwd: root,
        sessionId: "sess-rec",
        ui: null,
        restrictedFolders: [restricted],
        dbPath,
        hmacKeyPath,
      }),
      undefined,
    );

    // Recursive grep/find on `restricted` MUST still prompt / fail closed despite one-level directory grant!
    const titles: string[] = [];
    const optionsSeen: string[][] = [];
    const ui = {
      async select(title: string, options: string[]) {
        titles.push(title);
        optionsSeen.push(options);
        return CHOICE_DENY;
      },
    };
    const grepDecision = await evaluateRestrictedFolderAccess({
      toolName: "grep",
      input: { pattern: "secret", path: restricted },
      cwd: root,
      sessionId: "sess-rec",
      ui,
      restrictedFolders: [restricted],
      dbPath,
      hmacKeyPath,
    });
    assert.ok(grepDecision?.block);
    assert.match(titles[0]!, /recursive/i);
    assert.deepEqual(optionsSeen[0], [CHOICE_DENY, CHOICE_APPROVE_ONCE]);

    // Single-file grep on an explicitly approved file IS allowed
    addSessionApproval("sess-rec", "file", fs.realpathSync(topFile), fs.realpathSync(restricted));
    assert.equal(
      await evaluateRestrictedFolderAccess({
        toolName: "grep",
        input: { pattern: "hello", path: topFile },
        cwd: root,
        sessionId: "sess-rec",
        ui: null,
        restrictedFolders: [restricted],
        dbPath,
        hmacKeyPath,
      }),
      undefined,
    );
  });

  it("rejects forged SQLite restricted_folder_approvals rows and blocks bash state.db tamper scripts", async () => {
    const root = trackTempDir("rf-forged-");
    const restricted = path.join(root, "restricted");
    fs.mkdirSync(restricted, { recursive: true });
    const secretFile = path.join(restricted, "key.txt");
    fs.writeFileSync(secretFile, "top-secret");
    const dbPath = path.join(root, "state.db");
    const hmacKeyPath = path.join(root, ".approval-hmac-key");

    // 1. Seed one legitimate signed approval so key exists, then forge an unsigned row directly in SQLite
    const otherFile = path.join(restricted, "legit.txt");
    fs.writeFileSync(otherFile, "ok");
    addPersistentApproval(root, "file", fs.realpathSync(otherFile), fs.realpathSync(restricted), dbPath, hmacKeyPath);

    const db = openStateDb(dbPath);
    db.prepare(
      "INSERT INTO restricted_folder_approvals (scope, target_path, restricted_root, signature, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("file", fs.realpathSync(secretFile), fs.realpathSync(restricted), "0".repeat(64), new Date().toISOString());

    const validGrants = listPersistentApprovals(root, dbPath, hmacKeyPath);
    assert.equal(validGrants.length, 1, "forged SQLite row must be rejected by HMAC verification");
    assert.equal(validGrants[0]!.targetPath, fs.realpathSync(otherFile));

    // Accessing the forged target MUST still fail closed in headless mode
    const forgedCheck = await evaluateRestrictedFolderAccess({
      toolName: "read",
      input: { path: secretFile },
      cwd: root,
      ui: null,
      restrictedFolders: [restricted],
      dbPath,
      hmacKeyPath,
    });
    assert.ok(forgedCheck?.block, "forged DB row must never authorize restricted access");

    // 2. Bash scripts dynamically assembling .pi/data/state.db or reading .approval-hmac-key are blocked
    for (const cmd of [
      `d=".pi/data"; f="state.db"; sqlite3 "$d/$f" "INSERT INTO restricted_folder_approvals VALUES (1,'file','/a','/a','','now')"`,
      `python3 -c 'import sqlite3; sqlite3.connect(".pi/data/" + "state.db").execute("DELETE FROM restricted_folder_approvals")'`,
      `cat ~/.pi/agent/.approval-hmac-key`,
    ]) {
      const res = await evaluateBashPolicy({ command: cmd, cwd: root, ui: null });
      assert.equal(res.action, "block", `tamper bash command must be blocked: ${cmd}`);
    }
  });

  it("supports Approve Once, Approve File (session vs persistent), Approve Directory (direct children only), and Deny/cancel", async () => {
    const root = trackTempDir("rf-grants-");
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

    let promptCount = 0;
    let nextChoice: string | undefined = CHOICE_DENY;
    const ui = {
      async select() {
        promptCount++;
        return nextChoice;
      },
    };

    // 1. Deny & cancel (undefined) both block
    nextChoice = CHOICE_DENY;
    assert.ok(
      (
        await evaluateRestrictedFolderAccess({
          toolName: "read",
          input: { path: fileA },
          cwd: root,
          sessionId: "s1",
          ui,
          restrictedFolders: [restricted],
          dbPath,
        })
      )?.block,
    );
    nextChoice = undefined;
    assert.ok(
      (
        await evaluateRestrictedFolderAccess({
          toolName: "read",
          input: { path: fileA },
          cwd: root,
          sessionId: "s1",
          ui,
          restrictedFolders: [restricted],
          dbPath,
        })
      )?.block,
    );

    // 2. Approve Once allows one call, prompts again on the next
    promptCount = 0;
    nextChoice = CHOICE_APPROVE_ONCE;
    assert.equal(
      await evaluateRestrictedFolderAccess({
        toolName: "read",
        input: { path: fileA },
        cwd: root,
        sessionId: "s1",
        ui,
        restrictedFolders: [restricted],
        dbPath,
      }),
      undefined,
    );
    assert.equal(promptCount, 1);
    assert.equal(
      await evaluateRestrictedFolderAccess({
        toolName: "read",
        input: { path: fileA },
        cwd: root,
        sessionId: "s1",
        ui,
        restrictedFolders: [restricted],
        dbPath,
      }),
      undefined,
    );
    assert.equal(promptCount, 2, "Approve Once must not cache grant");

    // 3. Approve File (this session) caches exact file for s1, NOT sibling, NOT s2
    promptCount = 0;
    nextChoice = CHOICE_APPROVE_FILE_SESSION;
    assert.equal(
      await evaluateRestrictedFolderAccess({
        toolName: "read",
        input: { path: fileA },
        cwd: root,
        sessionId: "s1",
        ui,
        restrictedFolders: [restricted],
        dbPath,
      }),
      undefined,
    );
    assert.equal(promptCount, 1);
    // Repeat fileA in s1 -> no prompt
    assert.equal(
      await evaluateRestrictedFolderAccess({
        toolName: "read",
        input: { path: fileA },
        cwd: root,
        sessionId: "s1",
        ui,
        restrictedFolders: [restricted],
        dbPath,
      }),
      undefined,
    );
    assert.equal(promptCount, 1, "cached session file grant must not re-prompt");
    // Sibling fileB in s1 -> prompts (deny)
    nextChoice = CHOICE_DENY;
    assert.ok(
      (
        await evaluateRestrictedFolderAccess({
          toolName: "read",
          input: { path: fileB },
          cwd: root,
          sessionId: "s1",
          ui,
          restrictedFolders: [restricted],
          dbPath,
        })
      )?.block,
    );
    assert.equal(promptCount, 2);
    // Same fileA in different session s2 -> prompts (deny)
    assert.ok(
      (
        await evaluateRestrictedFolderAccess({
          toolName: "read",
          input: { path: fileA },
          cwd: root,
          sessionId: "s2",
          ui,
          restrictedFolders: [restricted],
          dbPath,
        })
      )?.block,
    );
    assert.equal(promptCount, 3);

    // 4. Approve File (persistent) persists in SQLite across sessions
    promptCount = 0;
    nextChoice = CHOICE_APPROVE_FILE_PERSISTENT;
    assert.equal(
      await evaluateRestrictedFolderAccess({
        toolName: "read",
        input: { path: fileB },
        cwd: root,
        sessionId: "s1",
        ui,
        restrictedFolders: [restricted],
        dbPath,
        hmacKeyPath,
      }),
      undefined,
    );
    assert.equal(listPersistentApprovals(root, dbPath, hmacKeyPath).length, 1);
    clearSessionApprovals();
    // Different session s99 still gets fileB without prompting
    assert.equal(
      await evaluateRestrictedFolderAccess({
        toolName: "read",
        input: { path: fileB },
        cwd: root,
        sessionId: "s99",
        ui,
        restrictedFolders: [restricted],
        dbPath,
        hmacKeyPath,
      }),
      undefined,
    );
    assert.equal(promptCount, 1, "persistent SQLite file grant survives new session");

    // 5. Approve Directory (direct children only) — allows direct children, NEVER grandchildren!
    promptCount = 0;
    nextChoice = CHOICE_APPROVE_DIR_SESSION;
    assert.equal(
      await evaluateRestrictedFolderAccess({
        toolName: "read",
        input: { path: subChild1 },
        cwd: root,
        sessionId: "s1",
        ui,
        restrictedFolders: [restricted],
        dbPath,
      }),
      undefined,
    );
    assert.equal(promptCount, 1);
    // Direct sibling child in subDir -> allowed without prompting!
    assert.equal(
      await evaluateRestrictedFolderAccess({
        toolName: "read",
        input: { path: subChild2 },
        cwd: root,
        sessionId: "s1",
        ui,
        restrictedFolders: [restricted],
        dbPath,
      }),
      undefined,
    );
    assert.equal(promptCount, 1);
    // Grandchild in subDir/nested/deep.txt -> MUST prompt (not covered by direct-children-only grant)
    nextChoice = CHOICE_DENY;
    assert.ok(
      (
        await evaluateRestrictedFolderAccess({
          toolName: "read",
          input: { path: grandChild },
          cwd: root,
          sessionId: "s1",
          ui,
          restrictedFolders: [restricted],
          dbPath,
        })
      )?.block,
    );
    assert.equal(promptCount, 2, "directory grant must NOT cover nested grandchildren");

    // Also test persistent directory grant directly via grantCoversPath & DB
    nextChoice = CHOICE_APPROVE_DIR_PERSISTENT;
    assert.equal(
      await evaluateRestrictedFolderAccess({
        toolName: "read",
        input: { path: grandChild },
        cwd: root,
        sessionId: "s1",
        ui,
        restrictedFolders: [restricted],
        dbPath,
        hmacKeyPath,
      }),
      undefined,
    );
    assert.equal(
      grantCoversPath({ scope: "directory", targetPath: fs.realpathSync(subDir) }, fs.realpathSync(subChild2)),
      true,
    );
    assert.equal(
      grantCoversPath({ scope: "directory", targetPath: fs.realpathSync(subDir) }, fs.realpathSync(grandChild)),
      false,
    );

    // 6. forgetApprovals clears session and persistent grants
    assert.ok(listSessionApprovals("s1").length > 0);
    assert.ok(listPersistentApprovals(root, dbPath, hmacKeyPath).length > 0);
    const cleared = forgetApprovals(root, "s1", "all", dbPath);
    assert.ok(cleared.sessionCleared >= 1);
    assert.ok(cleared.persistentCleared >= 2);
    assert.equal(listSessionApprovals("s1").length, 0);
    assert.equal(listPersistentApprovals(root, dbPath, hmacKeyPath).length, 0);
  });
});

describe("registerEnforcement integration for restricted_folders & /forget-approvals (#1416)", () => {
  it("wires tool_call gating, ui-bridge permission prompts, state.db protection, session_shutdown, and /forget-approvals", async () => {
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

    const notifications: string[] = [];
    const seenBlockedKinds: string[] = [];
    let selectedChoice: string | undefined = CHOICE_APPROVE_FILE_PERSISTENT;

    const interactiveCtx = {
      cwd,
      hasUI: true,
      sessionManager: { getSessionId: () => "sess-1" },
      ui: {
        async select(_title: string, _options: string[], opts?: { blockedKind?: string }) {
          if (opts?.blockedKind) seenBlockedKinds.push(opts.blockedKind);
          return selectedChoice;
        },
        notify(msg: string) {
          notifications.push(msg);
        },
      },
    };

    const headlessCtx = {
      cwd,
      hasUI: false,
      sessionManager: { getSessionId: () => "sess-headless" },
      ui: {},
    };

    // 1. Direct write to project state.db and direct read of .approval-hmac-key are blocked by enforcement
    const dbTamper = await callTool(
      { type: "tool_call", toolName: "write", input: { path: getProjectStateDbPath(cwd), content: "" } },
      interactiveCtx,
    );
    assert.ok(dbTamper?.block, "direct edit/write to project state.db must be blocked");

    const hmacRead = await callTool(
      { type: "tool_call", toolName: "read", input: { path: getApprovalHmacKeyPath() } },
      interactiveCtx,
    );
    assert.ok(hmacRead?.block, "direct read of .approval-hmac-key must be blocked");

    // 2. Headless read inside restricted folder fails closed
    const headlessBlock = await callTool(
      { type: "tool_call", toolName: "read", input: { path: secretFile } },
      headlessCtx,
    );
    assert.ok(headlessBlock?.block, "headless read in restricted folder must fail closed");

    // 3. Interactive read prompts with blockedKind: "permission" and persists approval
    selectedChoice = CHOICE_APPROVE_FILE_PERSISTENT;
    const allowed = await callTool(
      { type: "tool_call", toolName: "read", input: { path: secretFile } },
      interactiveCtx,
    );
    assert.equal(allowed, undefined);
    assert.deepEqual(seenBlockedKinds, ["permission"]);

    // 4. Reload shutdown preserves session grants; real shutdown clears session grants
    selectedChoice = CHOICE_APPROVE_DIR_SESSION;
    const otherFile = path.join(restricted, "other.txt");
    fs.writeFileSync(otherFile, "abc");
    assert.equal(
      await callTool({ type: "tool_call", toolName: "read", input: { path: otherFile } }, interactiveCtx),
      undefined,
    );
    assert.equal(listSessionApprovals("sess-1").length, 1);

    for (const h of handlers.get("session_shutdown") ?? []) {
      await h({ reason: "reload" }, interactiveCtx);
    }
    assert.equal(listSessionApprovals("sess-1").length, 1, "reload must preserve session approvals");

    for (const h of handlers.get("session_shutdown") ?? []) {
      await h({ reason: "exit" }, interactiveCtx);
    }
    assert.equal(listSessionApprovals("sess-1").length, 0, "shutdown must clear session approvals");

    // 5. /forget-approvals command clears persistent SQLite approvals too
    const forgetCmd = commands.get("forget-approvals");
    assert.ok(forgetCmd, "/forget-approvals command must be registered");
    assert.equal(listPersistentApprovals(cwd).length, 1);

    await forgetCmd!.handler("", interactiveCtx);
    assert.equal(listPersistentApprovals(cwd).length, 0);
    assert.ok(notifications.some((m) => m.includes("Cleared 0 session approval(s) and 1 persistent approval(s)")));

    // After /forget-approvals, headless read fails closed again
    const blockedAgain = await callTool(
      { type: "tool_call", toolName: "read", input: { path: secretFile } },
      headlessCtx,
    );
    assert.ok(blockedAgain?.block, "access must require approval again after /forget-approvals");
  });
});
