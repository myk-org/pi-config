/**
 * Cursor CLI driver — per-cwd history reseed (#768 Qodo) and
 * bindPiSessionId provisional-marker migration (#1167).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import {
  createCursorCliAdapter,
  cursorTurnNeedsHistorySeed,
} from "../../../extensions/providers/cursor-cli-driver.js";
import {
  isProvisionalPiSessionId,
  listCliSessions,
  loadCliSessionId,
} from "../../../extensions/cli-provider/sessions.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

function withFakeCursorHome(fn: (home: string, work: string, fakeAgent: string) => Promise<void> | void) {
  return async () => {
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    const home = makeTempDir("cursor-bind-");
    const work = makeTempDir("cursor-work-");
    process.env.HOME = home;
    process.env.USERPROFILE = home;

    const fakeAgent = join(work, "fake-agent");
    writeFileSync(
      fakeAgent,
      [
        "#!/usr/bin/env sh",
        "printf '%s\\n' '{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"cli-123\"}'",
        "printf '%s\\n' '{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"ok\"}]}}'",
        "printf '%s\\n' '{\"type\":\"result\",\"result\":\"ok\"}'",
      ].join("\n"),
      "utf-8",
    );
    chmodSync(fakeAgent, 0o755);

    try {
      await fn(home, work, fakeAgent);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  };
}

describe("cursorTurnNeedsHistorySeed", () => {
  it("does not reseed another cwd when only job-a is listed", () => {
    const listed = new Set(["/tmp/job-a"]);
    assert.equal(cursorTurnNeedsHistorySeed("/tmp/job-a", listed, false), true);
    assert.equal(cursorTurnNeedsHistorySeed("/tmp/job-b", listed, false), false);
  });

  it("global setForceHistorySeed override reseeds every cwd", () => {
    const listed = new Set<string>();
    assert.equal(cursorTurnNeedsHistorySeed("/tmp/job-b", listed, true), true);
  });
});

describe("createCursorCliAdapter bindPiSessionId (#1167)", () => {
  it("skips cli-sessions readdirSync when no provisional marker was written", async (t) => {
    await withFakeCursorHome((_home, work, fakeAgent) => {
      const adapter = createCursorCliAdapter(
        { binary: fakeAgent, enabled: true },
        work,
        "inst-1",
      );
      let readdirCalls = 0;
      const origReaddir = fs.readdirSync;
      t.mock.method(fs, "readdirSync", (target: any, ...args: any[]) => {
        if (String(target).includes("cli-sessions")) readdirCalls += 1;
        return (origReaddir as any)(target, ...args);
      });
      syncBuiltinESMExports();
      try {
        adapter.bindPiSessionId("real-sid-1");
        adapter.bindPiSessionId("real-sid-1");
        assert.equal(readdirCalls, 0);
      } finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      }
    })();
  });

  it("migrates provisional marker onto real piSessionId on bindPiSessionId", async () => {
    await withFakeCursorHome(async (_home, work, fakeAgent) => {
      const adapter = createCursorCliAdapter(
        { binary: fakeAgent, enabled: true },
        work,
        "inst-2",
      );
      const handle = await adapter.startSession({ model: "m1", cwd: work });
      await adapter.sendTurn(handle, "hi");

      const beforeBind = listCliSessions();
      assert.equal(beforeBind.length, 1);
      const provId = beforeBind[0].record.piSessionId;
      assert.ok(isProvisionalPiSessionId(provId));

      adapter.bindPiSessionId("real-sid-2");
      assert.equal(
        loadCliSessionId({
          cwd: work,
          agent: "cursor",
          model: "m1",
          piSessionId: "real-sid-2",
        }),
        "cli-123",
      );
      assert.equal(
        loadCliSessionId({
          cwd: work,
          agent: "cursor",
          model: "m1",
          piSessionId: provId,
        }),
        null,
      );
    })();
  });

  it("skips cli-sessions readdirSync on repeated bindPiSessionId after migration", async (t) => {
    await withFakeCursorHome(async (_home, work, fakeAgent) => {
      const adapter = createCursorCliAdapter(
        { binary: fakeAgent, enabled: true },
        work,
        "inst-3",
      );
      const handle = await adapter.startSession({ model: "m1", cwd: work });
      await adapter.sendTurn(handle, "hi");
      adapter.bindPiSessionId("real-sid-3");

      let readdirCalls = 0;
      const origReaddir = fs.readdirSync;
      t.mock.method(fs, "readdirSync", (target: any, ...args: any[]) => {
        if (String(target).includes("cli-sessions")) readdirCalls += 1;
        return (origReaddir as any)(target, ...args);
      });
      syncBuiltinESMExports();
      try {
        adapter.bindPiSessionId("real-sid-3");
        adapter.bindPiSessionId("real-sid-3");
        assert.equal(readdirCalls, 0);
      } finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      }
    })();
  });

  it("retries failed provisional marker migration on subsequent same-sid bindPiSessionId", async () => {
    await withFakeCursorHome(async (home, work, fakeAgent) => {
      const adapter = createCursorCliAdapter(
        { binary: fakeAgent, enabled: true },
        work,
        "inst-4",
      );
      const handle = await adapter.startSession({ model: "m1", cwd: work });
      await adapter.sendTurn(handle, "hi");

      const provId = listCliSessions()[0]!.record.piSessionId;
      const destHash = createHash("sha256")
        .update([work, "cursor", "m1", "real-sid-retry"].join("\0"))
        .digest("hex")
        .slice(0, 24);
      const destBlockingDir = join(home, ".pi", "cli-sessions", `${destHash}.json`);
      mkdirSync(destBlockingDir, { recursive: true });

      // First bind fails to write destination marker — provisional marker stays intact
      adapter.bindPiSessionId("real-sid-retry");
      assert.equal(
        loadCliSessionId({ cwd: work, agent: "cursor", model: "m1", piSessionId: provId }),
        "cli-123",
      );

      // Remove transient filesystem blocker and re-bind with the same sid
      rmSync(destBlockingDir, { recursive: true, force: true });
      adapter.bindPiSessionId("real-sid-retry");
      assert.equal(
        loadCliSessionId({ cwd: work, agent: "cursor", model: "m1", piSessionId: "real-sid-retry" }),
        "cli-123",
      );
      assert.equal(
        loadCliSessionId({ cwd: work, agent: "cursor", model: "m1", piSessionId: provId }),
        null,
      );
    })();
  });
});
