import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { registerMemoryTools } from "../../../extensions/orchestrator/memory-tools.js";

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
