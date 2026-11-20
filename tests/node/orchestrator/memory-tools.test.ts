import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, before, test } from "node:test";
import { registerMemoryTools } from "../../../extensions/orchestrator/memory-tools.js";
import { registerSessionSearch } from "../../../extensions/orchestrator/session-search.js";
import { addMemoryEntry } from "../../../extensions/orchestrator/memory-write.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

const originalChild = process.env.PI_SUBAGENT_CHILD;

before(() => delete process.env.PI_SUBAGENT_CHILD);
after(() => {
  if (originalChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
  else process.env.PI_SUBAGENT_CHILD = originalChild;
});

test("memory_add gives portable npm guidance for an empty run_after command", async () => {
  const tools = new Map<string, any>();
  registerMemoryTools({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any);

  const result = await tools.get("memory_add").execute(
    "test-call",
    { text: "Run checks", category: "lesson", action: "run_after " },
    undefined,
    undefined,
    { cwd: process.cwd() },
  );

  assert.equal(
    result.content[0].text,
    "Invalid action \"run_after \". run_after requires a command (e.g., 'run_after npm test')",
  );
});

const EXPECTED_MEMORY_TOOL_PARAMS: Record<string, string[]> = {
  memory_search: ["query", "category"],
  memory_reinforce: ["entryText", "category"],
  memory_topics: [],
  memory_add: [
    "text",
    "category",
    "pinned",
    "trigger",
    "action",
    "verifier",
    "scope",
    "overrideConflicts",
    "sourceSession",
    "derivedFrom",
    "informs",
  ],
  memory_remove: ["text", "category"],
  memory_reflect: ["query"],
  memory_edit: [
    "op",
    "text",
    "category",
    "newText",
    "supersededBy",
    "sourceSession",
    "derivedFrom",
    "informs",
  ],
  memory_consolidate: [],
  session_search: ["query", "limit"],
};

function collectRegisteredTools(): Map<string, any> {
  const tools = new Map<string, any>();
  const pi = { registerTool: (tool: any) => tools.set(tool.name, tool), on: () => {} } as any;
  registerMemoryTools(pi);
  registerSessionSearch(pi);
  return tools;
}

test("registers all 9 memory/session tools with expected parameter keys (#1198)", () => {
  const tools = collectRegisteredTools();
  for (const [name, keys] of Object.entries(EXPECTED_MEMORY_TOOL_PARAMS)) {
    const tool = tools.get(name);
    assert.ok(tool, `expected tool ${name} to be registered`);
    assert.deepEqual(Object.keys(tool.parameters.properties ?? {}), keys);
  }
});

test("enforces tightened schema char budget across 9 memory/session tools (#1198)", () => {
  const tools = collectRegisteredTools();
  let totalChars = 0;
  for (const name of Object.keys(EXPECTED_MEMORY_TOOL_PARAMS)) {
    const tool = tools.get(name);
    totalChars += JSON.stringify({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }).length;
  }

  // Baseline before #1198 was 6412 chars (~1603 tokens); tightened target <= 4100 chars (~1025 tokens)
  assert.ok(totalChars <= 4100, `expected tightened schemas <= 4100 chars, got ${totalChars}`);
});

test("memory_edit invalidate reports not found when target entry is absent", async () => {
  const cwd = makeTempDir("memory-edit-inv-");
  try {
    await addMemoryEntry(cwd, { text: "Existing lesson in topic file", category: "lesson" });
    const tools = collectRegisteredTools();
    const res = await tools.get("memory_edit").execute(
      "test-inv",
      { op: "invalidate", category: "lesson", text: "Missing or changed lesson text" },
      undefined,
      undefined,
      { cwd },
    );
    assert.match(res.content[0].text, /Memory not found:/);
    assert.doesNotMatch(res.content[0].text, /^Invalidated:/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
