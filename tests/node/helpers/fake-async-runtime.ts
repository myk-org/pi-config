/**
 * Fakes for the async-agent runtime's injected dependencies.
 *
 * `registerAsyncAgents` takes `spawnProcess: typeof spawn` and a `discoverAgents` that returns
 * `Pick<AgentDiscoveryResult, "agents">`. Both are far larger than a test needs, so the fake lives
 * here once: one documented cast instead of one per suite, and a typed agent config so a test
 * cannot invent a field the real discovery result does not carry.
 */
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import type { AgentConfig } from "../../../extensions/orchestrator/agents.js";

/**
 * A child process stand-in. The spawner only reads `stderr`, the `exit`/`error` events and
 * `unref`, so the stub is an EventEmitter with a `stderr` that swallows the pipe.
 */
export function fakeSpawnProcess(): typeof spawn {
  const spawnFake = () => Object.assign(new EventEmitter(), { stderr: { pipe() {} }, stdin: null, stdout: null });
  return spawnFake as unknown as typeof spawn;
}

/** An agent the discovery step would return; every field the runtime reads has a value. */
export function fakeAgent(name: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name,
    description: `${name} test agent`,
    systemPrompt: "",
    source: "user",
    filePath: `/agents/${name}.md`,
    ...overrides,
  };
}
