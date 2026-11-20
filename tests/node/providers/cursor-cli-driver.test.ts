/**
 * Cursor CLI driver — per-cwd history reseed (#768 Qodo) and
 * bindPiSessionId provisional-marker migration (#1167).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
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
  it("migrates provisional marker once on bindPiSessionId and skips redundant re-scans", async () => {
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
      const adapter = createCursorCliAdapter(
        { binary: fakeAgent, enabled: true },
        work,
        "inst-1",
      );

      // Early bind calls before any provisional marker was written are no-ops on disk
      adapter.bindPiSessionId("real-sid-1");
      adapter.bindPiSessionId("real-sid-1");
      assert.equal(listCliSessions().length, 0);

      // Unbound adapter writes provisional marker on turn, then migrates once bound
      const unbound = createCursorCliAdapter(
        { binary: fakeAgent, enabled: true },
        work,
        "inst-2",
      );
      const handle = await unbound.startSession({ model: "m1", cwd: work });
      await unbound.sendTurn(handle, "hi");

      const beforeBind = listCliSessions();
      assert.equal(beforeBind.length, 1);
      const provId = beforeBind[0].record.piSessionId;
      assert.ok(isProvisionalPiSessionId(provId));

      unbound.bindPiSessionId("real-sid-2");
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

      // Subsequent bind with same sid returns early without altering anything
      unbound.bindPiSessionId("real-sid-2");
      assert.equal(listCliSessions().length, 1);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });
});
