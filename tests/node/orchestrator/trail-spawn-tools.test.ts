/**
 * Trail #978 spawn-layer contract: what the child spawners actually put in
 * `--tools`. Qodo round 2: "some child agents receive no Trail tools".
 *
 * `trailToolsArgs` is the single exported assembly both spawners call, so it is
 * asserted behaviourally here — a source-text pin on the call sites made an
 * equivalent refactor fail (Qodo round 4), while `--tools ""` (a child restricted
 * to zero tools instead of left unrestricted) still fails.
 *
 * Run: env -u PI_SUBAGENT_CHILD npx tsx --test tests/node/orchestrator/trail-spawn-tools.test.ts
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRAIL_QUERY_TOOLS, trailToolsArgs, withTrailTools } from "../../../extensions/orchestrator/trail.js";
import { clearSettingsCache, setGlobalSettingsPath } from "../../../extensions/orchestrator/project-settings.js";

beforeEach(() => {
  // Pin the global settings file: a developer's ~/.pi settings must never decide the result.
  setGlobalSettingsPath(join(tmpdir(), `trail-spawn-global-${process.pid}.json`));
  clearSettingsCache();
});
afterEach(() => {
  setGlobalSettingsPath(null);
  clearSettingsCache();
});
/** Temp repo whose own `.pi` settings say whether Trail is on. */
function repo(trailEnable: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "trail-spawn-"));
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(join(root, ".pi/pi-config-settings.jsonc"), JSON.stringify({ trail_enable: trailEnable }));
  return root;
}
const QUERY_TOOLS = "trail_find_code,trail_find_all,trail_file_api,trail_trace_calls,trail_repo_map";

describe("trailToolsArgs (what the spawners append to the child command)", () => {
  it("passes no --tools for an undeclared list, so the child stays unrestricted", () => {
    // A child with no --tools registers every tool in its own session, Trail
    // included: naming the five would narrow it, not widen it.
    const root = repo(true);
    try {
      assert.deepEqual(trailToolsArgs(undefined, root), []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("passes no --tools for an empty declared list (never `--tools \"\"`)", () => {
    const root = repo(true);
    try {
      assert.deepEqual(trailToolsArgs([], root), []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("appends the five query tools to a declared list", () => {
    const root = repo(true);
    try {
      assert.deepEqual(trailToolsArgs(["read", "bash", "edit"], root), ["--tools", `read,bash,edit,${QUERY_TOOLS}`]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("does not duplicate Trail tools that are already declared", () => {
    const root = repo(true);
    try {
      const [, list] = trailToolsArgs(["read", "trail_find_code", "trail_repo_map"], root);
      const names = list!.split(",");
      assert.equal(new Set(names).size, names.length, "no duplicates");
      assert.deepEqual(names, ["read", "trail_find_code", "trail_repo_map", "trail_find_all", "trail_file_api", "trail_trace_calls"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("forwards a declared list untouched when trail_enable is false, adding no Trail tools", () => {
    // No Trail tools when disabled, but the agent's own restriction must still
    // reach the child: dropping `--tools` would widen a read-only agent instead.
    const root = repo(false);
    try {
      assert.deepEqual(trailToolsArgs(["read", "bash"], root), ["--tools", "read,bash"]);
      assert.deepEqual(trailToolsArgs(undefined, root), []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("withTrailTools (the list trailToolsArgs builds on)", () => {
  it("leaves a missing tool list missing, so the child stays unrestricted", () => {
    assert.equal(withTrailTools(undefined, true), undefined);
    assert.deepEqual(withTrailTools([], true), []);
    assert.equal(withTrailTools(undefined, false), undefined);
  });

  it("appends exactly the five Trail query tools to a declared list, keeping the agent's own", () => {
    const tools = withTrailTools(["read", "bash", "edit"], true)!;
    for (const name of TRAIL_QUERY_TOOLS) assert.equal(tools.filter(entry => entry === name).length, 1, `${name} appears exactly once`);
    assert.deepEqual(tools.slice(0, 3), ["read", "bash", "edit"], "the declared tools survive in order");
    assert.equal(tools.length, 3 + TRAIL_QUERY_TOOLS.length);
  });

  it("does not duplicate Trail tools that are already declared", () => {
    const declared = ["read", "trail_find_code", "trail_repo_map"];
    const tools = withTrailTools(declared, true)!;
    assert.equal(tools.length, declared.length + TRAIL_QUERY_TOOLS.length - 2, "the two already-present tools are not re-added");
    assert.equal(new Set(tools).size, tools.length);
    for (const name of TRAIL_QUERY_TOOLS) assert.equal(tools.filter(entry => entry === name).length, 1);
  });

  it("returns the declared list untouched when Trail is disabled", () => {
    assert.deepEqual(withTrailTools(["read", "bash"], false), ["read", "bash"]);
    // A copy, not the caller's array: the spawner must not mutate agent config.
    const declared = ["read"];
    assert.notEqual(withTrailTools(declared, false), declared);
  });
});
