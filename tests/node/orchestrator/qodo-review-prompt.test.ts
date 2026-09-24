import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { qodoReviewArgumentCompletions } from "../../../extensions/orchestrator/extended-autocomplete.js";

const prompt = readFileSync(new URL("../../../prompts/qodo-review.md", import.meta.url), "utf8");

describe("qodo-review prompt", () => {
  it("keeps the raw arguments block", () => {
    assert.match(prompt, /## Raw Arguments\n\n```text\n\$ARGUMENTS\n```/);
  });

  it("omits removed boilerplate", () => {
    assert.doesNotMatch(prompt, /Bug Reporting Policy/);
  });

  it("documents the safe prerequisite stop", () => {
    assert.match(prompt, /curl -fsSL https:\/\/get\.qodo\.ai \| sh/);
    assert.match(prompt, /NEVER execute it/);
    assert.match(prompt, /run `qodo` to finish setup, then rerun `\/qodo-review`/);
  });

  it("requires default approval", () => {
    assert.match(prompt, /call\n  `ask_user` once/);
  });

  it("allows autofix without approval but bounds retries and stagnation", () => {
    assert.match(prompt, /`--autofix`: skip `ask_user` and fix every finding/);
    assert.match(prompt, /at most 3 autofix cycles/);
    assert.match(prompt, /same findings recur or a cycle makes no effective progress/);
  });

  it("requires passing tests", () => {
    assert.match(prompt, /Tests are mandatory and every test must pass/);
  });

  it("prohibits forge operations", () => {
    assert.match(prompt, /Never commit, push, create a PR/);
  });
});

describe("qodo-review autocomplete", () => {
  it("offers all constrained flags", () => {
    assert.deepEqual(
      qodoReviewArgumentCompletions("")?.map(({ label }) => label),
      ["--autofix", "--fast", "--deep", "--ticket"],
    );
  });

  it("enforces exclusive depth suggestions", () => {
    assert.deepEqual(
      qodoReviewArgumentCompletions("--fast ")?.map(({ label }) => label),
      ["--autofix", "--ticket"],
    );
  });

  it("does not complete a free-text ticket URL", () => {
    assert.equal(qodoReviewArgumentCompletions("--ticket "), null);
    assert.equal(qodoReviewArgumentCompletions("--ticket https://example.test/T-1"), null);
  });

  it("resumes flag suggestions after a completed ticket URL", () => {
    assert.deepEqual(qodoReviewArgumentCompletions("--ticket https://example.test/T-1 ")?.map(({ label }) => label),
      ["--autofix", "--fast", "--deep", "--ticket"]);
    assert.deepEqual(qodoReviewArgumentCompletions("--ticket https://example.test/T-1 --fast ")?.map(({ label }) => label),
      ["--autofix", "--ticket"]);
  });

  it("never writes ticket URLs or pathspecs into debug logs", () => {
    const home = mkdtempSync(join(tmpdir(), "qodo-autocomplete-log-"));
    try {
      const script = `
        const { setGlobalSessionId } = await import(${JSON.stringify(new URL("../../../extensions/shared/file-logger.ts", import.meta.url).href)});
        const { qodoReviewArgumentCompletions } = await import(${JSON.stringify(new URL("../../../extensions/orchestrator/extended-autocomplete.ts", import.meta.url).href)});
        setGlobalSessionId("test-session");
        qodoReviewArgumentCompletions("--ticket https://secret:password@example.test/T-1?token=private /private/path --fast "); // pragma: allowlist secret — synthetic test URL
      `;
      const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
        encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home, __PI_PARENT_SESSION_ID: "", PI_LOG_AUTOCOMPLETE: "debug" },
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const body = readFileSync(join(home, ".pi/logs/autocomplete/test-session/main.log"), "utf8");
      assert.match(body, /Completing qodo-review arguments/);
      assert.doesNotMatch(body, /secret|password|private|example\.test|T-1/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
