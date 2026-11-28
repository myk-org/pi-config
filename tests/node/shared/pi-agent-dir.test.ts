/**
 * Unit tests for Pi 1.7.0 `--agent-dir` CLI flag parsing, resolution precedence,
 * and child-process env propagation (`extensions/shared/pi-agent-dir.ts`).
 */

import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  extractAgentDirFromArgv,
  resolvePiAgentDir,
  withPropagatedPiAgentDirEnv,
} from "../../../extensions/shared/pi-agent-dir.js";

describe("extractAgentDirFromArgv", () => {
  it("parses space-separated --agent-dir flag", () => {
    assert.equal(
      extractAgentDirFromArgv(["--model", "gpt-5", "--agent-dir", "/custom/agent"]),
      "/custom/agent",
    );
  });

  it("parses equals-form --agent-dir flag", () => {
    assert.equal(
      extractAgentDirFromArgv(["--agent-dir=/custom/equals-agent", "-p"]),
      "/custom/equals-agent",
    );
  });

  it("uses last-wins when --agent-dir is repeated", () => {
    assert.equal(
      extractAgentDirFromArgv(["--agent-dir", "/first/agent", "--agent-dir=/second/agent"]),
      "/second/agent",
    );
  });

  it("trims whitespace around the --agent-dir value", () => {
    assert.equal(
      extractAgentDirFromArgv(["--agent-dir=  /trimmed/agent  "]),
      "/trimmed/agent",
    );
  });

  it("stops parsing at the -- end-of-options sentinel", () => {
    assert.equal(
      extractAgentDirFromArgv(["--", "--agent-dir", "/after/sentinel"]),
      undefined,
    );
  });

  it("keeps value before -- when another --agent-dir appears after --", () => {
    assert.equal(
      extractAgentDirFromArgv(["--agent-dir", "/before/sentinel", "--", "--agent-dir", "/after/sentinel"]),
      "/before/sentinel",
    );
  });

  it("ignores --agent-dir with a missing value at end of argv", () => {
    assert.equal(extractAgentDirFromArgv(["--model", "foo", "--agent-dir"]), undefined);
  });

  it("ignores --agent-dir followed immediately by another flag", () => {
    assert.equal(extractAgentDirFromArgv(["--agent-dir", "--mode", "json"]), undefined);
  });

  it("ignores empty --agent-dir equals value", () => {
    assert.equal(extractAgentDirFromArgv(["--agent-dir="]), undefined);
  });

  it("ignores whitespace-only --agent-dir value", () => {
    assert.equal(extractAgentDirFromArgv(["--agent-dir", "   "]), undefined);
  });

  it("keeps prior valid --agent-dir when a later flag has an empty value", () => {
    assert.equal(
      extractAgentDirFromArgv(["--agent-dir", "/valid/agent", "--agent-dir="]),
      "/valid/agent",
    );
  });

  it("ignores --agent-dir=... consumed as the value of --system-prompt", () => {
    assert.equal(
      extractAgentDirFromArgv(["--system-prompt", "--agent-dir=/other/path"]),
      undefined,
    );
  });

  it("ignores --agent-dir=... consumed as the value of --session", () => {
    assert.equal(
      extractAgentDirFromArgv(["--session", "--agent-dir=/other/path"]),
      undefined,
    );
  });

  it("keeps genuine --agent-dir when --system-prompt also holds --agent-dir=... as its value", () => {
    assert.equal(
      extractAgentDirFromArgv([
        "--system-prompt",
        "--agent-dir=/fake/path",
        "--agent-dir",
        "/real/agent",
      ]),
      "/real/agent",
    );
  });

  it("keeps prior genuine --agent-dir when a later --session consumes --agent-dir=...", () => {
    assert.equal(
      extractAgentDirFromArgv([
        "--agent-dir=/real/agent",
        "--session",
        "--agent-dir=/fake/path",
      ]),
      "/real/agent",
    );
  });
});

describe("resolvePiAgentDir", () => {
  const prevEnv = process.env.PI_CODING_AGENT_DIR;
  const prevArgv = [...process.argv];

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevEnv;
    process.argv.splice(0, process.argv.length, ...prevArgv);
  });

  it("prefers explicit agentDir over CLI flag", () => {
    process.env.PI_CODING_AGENT_DIR = "/env/agent";
    assert.equal(
      resolvePiAgentDir("/explicit/agent", ["--agent-dir", "/cli/agent"]),
      "/explicit/agent",
    );
  });

  it("prefers CLI --agent-dir over PI_CODING_AGENT_DIR", () => {
    process.env.PI_CODING_AGENT_DIR = "/env/agent";
    assert.equal(
      resolvePiAgentDir(undefined, ["--agent-dir", "/cli/agent"]),
      "/cli/agent",
    );
  });

  it("falls back to PI_CODING_AGENT_DIR when CLI flag is absent", () => {
    process.env.PI_CODING_AGENT_DIR = "/env/agent";
    assert.equal(resolvePiAgentDir(undefined, []), "/env/agent");
  });

  it("falls back to ~/.pi/agent when neither CLI flag nor env var is set", () => {
    delete process.env.PI_CODING_AGENT_DIR;
    assert.equal(resolvePiAgentDir(undefined, []), join(homedir(), ".pi", "agent"));
  });

  it("expands leading tilde in --agent-dir path", () => {
    delete process.env.PI_CODING_AGENT_DIR;
    assert.equal(
      resolvePiAgentDir(undefined, ["--agent-dir=~/custom-agent"]),
      join(homedir(), "custom-agent"),
    );
  });

  it("expands leading tilde in PI_CODING_AGENT_DIR", () => {
    process.env.PI_CODING_AGENT_DIR = "~/env-agent";
    assert.equal(resolvePiAgentDir(undefined, []), join(homedir(), "env-agent"));
  });

  it("reads --agent-dir from process.argv when argv override is omitted", () => {
    delete process.env.PI_CODING_AGENT_DIR;
    process.argv.splice(0, process.argv.length, "node", "pi", "--agent-dir", "/from/process-argv");
    assert.equal(resolvePiAgentDir(), "/from/process-argv");
  });

  it("resolves relative --agent-dir to the same absolute path as child env propagation", () => {
    delete process.env.PI_CODING_AGENT_DIR;
    const argv = ["--agent-dir", "relative/agent"];
    assert.equal(resolvePiAgentDir(undefined, argv), resolve("relative/agent"));
    assert.equal(
      resolvePiAgentDir(undefined, argv),
      withPropagatedPiAgentDirEnv({}, argv).PI_CODING_AGENT_DIR,
    );
  });
});

describe("withPropagatedPiAgentDirEnv", () => {
  it("propagates CLI --agent-dir into PI_CODING_AGENT_DIR", () => {
    const env = withPropagatedPiAgentDirEnv({ PATH: "/usr/bin" }, ["--agent-dir", "/cli/agent"]);
    assert.equal(env.PI_CODING_AGENT_DIR, "/cli/agent");
    assert.equal(env.PATH, "/usr/bin");
  });

  it("overrides inherited PI_CODING_AGENT_DIR with CLI --agent-dir", () => {
    const env = withPropagatedPiAgentDirEnv(
      { PI_CODING_AGENT_DIR: "/env/agent" },
      ["--agent-dir=/cli/agent"],
    );
    assert.equal(env.PI_CODING_AGENT_DIR, "/cli/agent");
  });

  it("omits PI_CODING_AGENT_DIR when neither CLI flag nor env var is set", () => {
    const env = withPropagatedPiAgentDirEnv({ PATH: "/usr/bin" }, []);
    assert.equal("PI_CODING_AGENT_DIR" in env, false);
  });

  it("preserves existing PI_CODING_AGENT_DIR when CLI flag is absent", () => {
    const env = withPropagatedPiAgentDirEnv({ PI_CODING_AGENT_DIR: "/env/agent" }, []);
    assert.equal(env.PI_CODING_AGENT_DIR, "/env/agent");
  });

  it("resolves relative --agent-dir to an absolute path for child processes", () => {
    const env = withPropagatedPiAgentDirEnv({}, ["--agent-dir", "relative/agent"]);
    assert.equal(env.PI_CODING_AGENT_DIR, resolve("relative/agent"));
  });

  it("expands tilde when propagating --agent-dir to child env", () => {
    const env = withPropagatedPiAgentDirEnv({}, ["--agent-dir=~/child-agent"]);
    assert.equal(env.PI_CODING_AGENT_DIR, join(homedir(), "child-agent"));
  });

  it("emits propagating_cli_agent_dir debug log when PI_CODING_AGENT_DIR changes", () => {
    const events: Array<{ event: string; payload: unknown }> = [];
    const stubLogger = {
      debug(event: string, payload?: unknown) {
        events.push({ event, payload });
      },
    };
    withPropagatedPiAgentDirEnv(
      { PI_CODING_AGENT_DIR: "/old/agent" },
      ["--agent-dir", "/new/agent"],
      stubLogger,
    );
    assert.deepEqual(events, [
      { event: "propagating_cli_agent_dir", payload: { agentDir: "/new/agent" } },
    ]);
  });

  it("does not emit propagating_cli_agent_dir debug log when PI_CODING_AGENT_DIR already matches", () => {
    const events: Array<{ event: string; payload: unknown }> = [];
    const stubLogger = {
      debug(event: string, payload?: unknown) {
        events.push({ event, payload });
      },
    };
    withPropagatedPiAgentDirEnv(
      { PI_CODING_AGENT_DIR: "/same/agent" },
      ["--agent-dir", "/same/agent"],
      stubLogger,
    );
    assert.deepEqual(events, []);
  });
});
