/**
 * Trail #978 spawn-layer contract: what the child spawners actually put in
 * `--tools`. Qodo round 2: "some child agents receive no Trail tools".
 *
 * `withTrailTools` is asserted directly (the helper both spawners call) AND the
 * two call sites are pinned at source level, because the helper returning the
 * right thing is worthless if a spawner drops the "only when non-empty" guard:
 * `--tools ""` would restrict a child to zero tools instead of leaving it
 * unrestricted (where its own session registers Trail anyway).
 *
 * Run: env -u PI_SUBAGENT_CHILD npx tsx --test tests/node/orchestrator/trail-spawn-tools.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TRAIL_QUERY_TOOLS, withTrailTools } from "../../../extensions/orchestrator/trail.js";

const orchestrator = join(dirname(fileURLToPath(import.meta.url)), "../../../extensions/orchestrator");
const SPAWNERS = ["subagent-tool.ts", "async-agents.ts"];

describe("withTrailTools (the helper the spawners call)", () => {
  it("leaves a missing tool list missing, so the child stays unrestricted", () => {
    // A child with no --tools registers every tool in its own session, Trail
    // included: naming the five would narrow it, not widen it.
    assert.equal(withTrailTools(undefined, true), undefined);
    // An empty declared list needs no Trail names; the spawner's length guard
    // still passes no --tools, so the child stays unrestricted.
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

describe("spawner call sites (`--tools` is only pushed for a non-empty list)", () => {
  for (const file of SPAWNERS) {
    it(`${file} derives --tools from withTrailTools and guards on a non-empty result`, () => {
      const source = readFileSync(join(orchestrator, file), "utf8");
      const derived = /const tools = withTrailTools\(agent\.tools, trailEnabled\(cwd\)\);/.exec(source);
      assert.ok(derived, `${file} must derive its child tool list from withTrailTools(agent.tools, trailEnabled(cwd))`);
      // The exact guard: `if (tools?.length) <args>.push("--tools", tools.join(","))`.
      // `tools &&` / `tools.length > 0` are equivalent, so allow them, but a bare
      // push (no guard) or `tools ? …` (pushes for an empty list) must fail here.
      const guard = /if \(tools(?:\?\.length|\.length(?: > 0)?| && tools\.length)\)\s*(\w+)\.push\("--tools", tools\.join\(","\)\);/.exec(source);
      assert.ok(guard, `${file} must push --tools only when the list is non-empty (no --tools \"\" for an unrestricted child)`);
      // Exactly one such push: a second, unguarded one would defeat the check above.
      assert.equal(source.match(/\.push\("--tools"/g)?.length, 1, `${file} pushes --tools in exactly one place`);
    });
  }
});
