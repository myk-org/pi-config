import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { runSingleAgent } from "../../../extensions/orchestrator/subagent-tool.js";
import { registerAsyncAgents } from "../../../extensions/orchestrator/async-agents.js";
import { clearSettingsCache, setGlobalSettingsPath } from "../../../extensions/orchestrator/project-settings.js";

// The sync path invokes process.argv[1]; the async path invokes its runner.
// Run a real Node child at each boundary so its observed environment, not a
// reconstructed options object, determines the assertions.
describe("subagent child model environment", { concurrency: false }, () => {
  for (const { selected, inherited } of [
    { selected: true, inherited: true },
    { selected: true, inherited: false },
    { selected: false, inherited: true },
    { selected: false, inherited: false },
  ]) {
    const label = `${selected ? "selected" : "no selected"} model, ${inherited ? "inherited" : "no inherited"} PI_MODEL`;
    async function withChild(check: (cwd: string, script: string, output: string, agent: any, parentModelId: string | undefined) => Promise<void>) {
      const cwd = mkdtempSync(join(tmpdir(), "subagent-model-env-"));
      const previous = { model: process.env.PI_MODEL, primary: process.env.PI_PRIMARY_MODEL, argv: process.argv[1], projectTmp: process.env.PROJECT_TMP_DIR, output: process.env.CHILD_ENV_OUTPUT };
      const previousInterval = global.setInterval;
      const script = join(cwd, "child.cjs");
      const output = join(cwd, "child.json");
      writeFileSync(script, `require('node:fs').writeFileSync(process.env.CHILD_ENV_OUTPUT, JSON.stringify({ model: process.env.PI_MODEL ?? null, primary: process.env.PI_PRIMARY_MODEL, args: process.argv.slice(2) }));`);
      writeFileSync(join(cwd, "settings.json"), "{}");
      try {
        setGlobalSettingsPath(join(cwd, "settings.json"));
        clearSettingsCache();
        if (inherited) process.env.PI_MODEL = "inherited-model";
        else delete process.env.PI_MODEL;
        delete process.env.PI_PRIMARY_MODEL;
        process.env.CHILD_ENV_OUTPUT = output;
        process.argv[1] = script;
        const agent = { name: "worker", source: "project", systemPrompt: "", ...(selected ? { model: "chosen-model" } : {}) } as any;
        await check(cwd, script, output, agent, selected ? "parent-model" : undefined);
      } finally {
        global.setInterval = previousInterval;
        process.argv[1] = previous.argv;
        for (const [key, value] of [["PI_MODEL", previous.model], ["PI_PRIMARY_MODEL", previous.primary], ["PROJECT_TMP_DIR", previous.projectTmp], ["CHILD_ENV_OUTPUT", previous.output]] as const) {
          if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
        setGlobalSettingsPath(null);
        clearSettingsCache();
        rmSync(cwd, { recursive: true, force: true });
      }
    }

    it(`sync child: ${label}`, () => withChild(async (cwd, _script, output, agent, parentModelId) => {
      const sync = await runSingleAgent([agent], "worker", "check", cwd, undefined, undefined, undefined, () => ({} as any), parentModelId);
      assert.equal(sync.exitCode, 0);
      const child = JSON.parse(readFileSync(output, "utf8"));
      assert.equal(child.model, selected ? "chosen-model" : null);
      assert.equal(child.primary, inherited ? "inherited-model" : "");
      assert.equal(child.args.includes("--model"), selected);
      if (selected) assert.equal(child.args[child.args.indexOf("--model") + 1], "chosen-model");
    }));

    it(`async child: ${label}`, () => withChild(async (cwd, script, output, agent, parentModelId) => {
      global.setInterval = (() => ({ unref() {} })) as any;
      const handlers = new Map<string, Array<(event: unknown, ctx: any) => void>>();
      const pi = { on: (name: string, handler: any) => { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); }, registerCommand() {}, sendMessage() {}, events: new EventEmitter() };
      const api = registerAsyncAgents(pi as any, () => {}, {
        spawnProcess: ((command: string, _args: string[], options: any) => spawn(command, [script], options)) as any,
      });
      handlers.get("session_start")![0]({}, { cwd, sessionManager: { getCwd: () => cwd, getSessionId: () => "model-test" } });
      const asyncJob = api.spawnAsyncAgent("worker", "check", cwd, [agent], { parentModelId });
      assert.equal(asyncJob.error, undefined);
      assert.equal(asyncJob.model, selected ? "chosen-model" : undefined);
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const poll = () => {
          try {
            const child = JSON.parse(readFileSync(output, "utf8"));
            if (child.args.length === 0) return resolve();
          } catch {}
          if (Date.now() > deadline) return reject(new Error("async child did not write environment"));
          setTimeout(poll, 10);
        };
        poll();
      });
      const child = JSON.parse(readFileSync(output, "utf8"));
      assert.equal(child.model, selected ? "chosen-model" : null);
      assert.equal(child.primary, inherited ? "inherited-model" : "");
      const config = JSON.parse(readFileSync(join(cwd, ".pi", "tmp", `async-cfg-${asyncJob.id}.json`), "utf8"));
      assert.equal(config.piArgs.includes("--model"), selected);
      if (selected) assert.equal(config.piArgs[config.piArgs.indexOf("--model") + 1], "chosen-model");
    }));
  }
});
