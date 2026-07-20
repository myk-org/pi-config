/**
 * Tests for cli-provider session directory + reaper.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  clearCliSessionId,
  isCliResumeFailure,
  loadCliSessionId,
  loadCliSessionRecord,
  saveCliSessionId,
  touchCliSession,
  type CliSessionKey,
} from "../../../extensions/cli-provider/sessions.js";
import { reapStaleCliSessions } from "../../../extensions/cli-provider/session-reaper.js";

describe("cli-provider sessions", () => {
  it("detects resume failure messages", () => {
    assert.equal(isCliResumeFailure("Session not found: abc"), true);
    assert.equal(isCliResumeFailure("cannot resume session"), true);
    assert.equal(isCliResumeFailure("model overloaded"), false);
  });

  it("retries without resume on empty non-zero exit", async () => {
    const { shouldRetryWithoutResume } = await import(
      "../../../extensions/cli-provider/sessions.js"
    );
    assert.equal(
      shouldRetryWithoutResume("CLI agent exited 1: no output"),
      true,
    );
    assert.equal(shouldRetryWithoutResume("CLI agent exited 1: auth failed"), false);
  });

  it("does not treat SIGTERM/abort exits as dead resume (issue #661)", async () => {
    const { shouldRetryWithoutResume } = await import(
      "../../../extensions/cli-provider/sessions.js"
    );
    assert.equal(
      shouldRetryWithoutResume("CLI agent exited 143: no output"),
      false,
    );
    assert.equal(
      shouldRetryWithoutResume("CLI agent exited 130: no output"),
      false,
    );
    assert.equal(
      shouldRetryWithoutResume("CLI agent exited 137: no output"),
      false,
    );
    assert.equal(shouldRetryWithoutResume("CLI call aborted"), false);
  });

  it("adoptLegacyCliSessionMarker moves default bucket onto real sid", async () => {
    const { adoptLegacyCliSessionMarker } = await import(
      "../../../extensions/cli-provider/sessions.js"
    );
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    const home = mkdtempSync(join(tmpdir(), "cli-sess-adopt-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const legacy: CliSessionKey = {
        cwd: "/proj",
        agent: "cursor",
        model: "m",
        piSessionId: "default",
      };
      const real: CliSessionKey = {
        cwd: "/proj",
        agent: "cursor",
        model: "m",
        piSessionId: "real-sid",
      };
      saveCliSessionId(legacy, "legacy-cli");
      assert.equal(adoptLegacyCliSessionMarker(real), true);
      assert.equal(loadCliSessionId(real), "legacy-cli");
      assert.equal(loadCliSessionId(legacy), null);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("clearCliSessionsForPiSession removes only matching sid (keeps other sessions)", async () => {
    const { clearCliSessionsForPiSession } = await import(
      "../../../extensions/cli-provider/sessions.js"
    );
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    const home = mkdtempSync(join(tmpdir(), "cli-sess-scoped-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const keyMine: CliSessionKey = {
        cwd: "/proj",
        agent: "cursor",
        model: "m",
        piSessionId: "mine",
      };
      const keyOther: CliSessionKey = {
        cwd: "/proj",
        agent: "cursor",
        model: "m",
        piSessionId: "other",
      };
      const keyLegacy: CliSessionKey = {
        cwd: "/proj",
        agent: "cursor",
        model: "m",
        piSessionId: "default",
      };
      saveCliSessionId(keyMine, "id-mine");
      saveCliSessionId(keyOther, "id-other");
      saveCliSessionId(keyLegacy, "id-legacy");
      assert.equal(
        clearCliSessionsForPiSession("/proj", "mine", {
          includeLegacyDefault: true,
        }),
        2,
      );
      assert.equal(loadCliSessionId(keyMine), null);
      assert.equal(loadCliSessionId(keyLegacy), null);
      assert.equal(loadCliSessionId(keyOther), "id-other");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("clearCliSessionsForCwd removes all markers for that cwd", async () => {
    const { clearCliSessionsForCwd } = await import(
      "../../../extensions/cli-provider/sessions.js"
    );
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    const home = mkdtempSync(join(tmpdir(), "cli-sess-cwd-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const keyA: CliSessionKey = {
        cwd: "/proj-a",
        agent: "cursor",
        model: "m",
        piSessionId: "s1",
      };
      const keyB: CliSessionKey = {
        cwd: "/proj-b",
        agent: "cursor",
        model: "m",
        piSessionId: "s1",
      };
      saveCliSessionId(keyA, "id-a");
      saveCliSessionId(keyB, "id-b");
      assert.equal(clearCliSessionsForCwd("/proj-a"), 1);
      assert.equal(loadCliSessionId(keyA), null);
      assert.equal(loadCliSessionId(keyB), "id-b");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("resolveCliHistorySeed forces seed when forceHistorySeed is set", async () => {
    const { resolveCliHistorySeed } = await import(
      "../../../extensions/cli-provider/sessions.js"
    );
    assert.deepEqual(
      resolveCliHistorySeed({ hasCliSession: true, forceHistorySeed: true }),
      { useCliSession: false, seedHistory: true },
    );
  });

  it("resolveCliHistorySeed resumes CLI session when forceHistorySeed is false", async () => {
    const { resolveCliHistorySeed } = await import(
      "../../../extensions/cli-provider/sessions.js"
    );
    assert.deepEqual(
      resolveCliHistorySeed({ hasCliSession: true, forceHistorySeed: false }),
      { useCliSession: true, seedHistory: false },
    );
  });

  it("resolveCliHistorySeed seeds history when no CLI session exists", async () => {
    const { resolveCliHistorySeed } = await import(
      "../../../extensions/cli-provider/sessions.js"
    );
    assert.deepEqual(
      resolveCliHistorySeed({ hasCliSession: false, forceHistorySeed: false }),
      { useCliSession: false, seedHistory: true },
    );
  });

  it("saves then loads session id", () => {
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    const home = mkdtempSync(join(tmpdir(), "cli-sess-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const key: CliSessionKey = {
        cwd: "/proj",
        agent: "cursor",
        model: "composer-2",
        piSessionId: "sess-a",
      };
      saveCliSessionId(key, "cli-uuid-1");
      assert.equal(loadCliSessionId(key), "cli-uuid-1");
      const before = loadCliSessionRecord(key)!;
      assert.equal(before.status, "running");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("touchCliSession advances lastSeenAt", () => {
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    const home = mkdtempSync(join(tmpdir(), "cli-sess-touch-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const key: CliSessionKey = {
        cwd: "/proj",
        agent: "cursor",
        model: "composer-2",
        piSessionId: "sess-a",
      };
      saveCliSessionId(key, "cli-uuid-1");
      const oldSeen = loadCliSessionRecord(key)!.lastSeenAt;
      touchCliSession(key);
      assert.ok(loadCliSessionRecord(key)!.lastSeenAt >= oldSeen);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("clearCliSessionId removes the marker", () => {
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    const home = mkdtempSync(join(tmpdir(), "cli-sess-clear-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const key: CliSessionKey = {
        cwd: "/proj",
        agent: "cursor",
        model: "composer-2",
        piSessionId: "sess-a",
      };
      saveCliSessionId(key, "cli-uuid-1");
      clearCliSessionId(key);
      assert.equal(loadCliSessionId(key), null);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("loadCliSessionId returns null on malformed JSON", () => {
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    const home = mkdtempSync(join(tmpdir(), "cli-sess-bad-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const key: CliSessionKey = {
        cwd: "/proj",
        agent: "cursor",
        model: "composer-2",
        piSessionId: "bad",
      };
      saveCliSessionId(key, "ok");
      const rec = loadCliSessionRecord(key)!;
      const dir = join(home, ".pi", "cli-sessions");
      const files = readdirSync(dir);
      writeFileSync(join(dir, files[0]), "{not-json");
      assert.equal(loadCliSessionId(key), null);
      assert.equal(rec.sessionId, "ok");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not reap idle running markers for the active pi session (issue #661)", () => {
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    const home = mkdtempSync(join(tmpdir(), "cli-reap-running-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const key: CliSessionKey = {
        cwd: "/proj",
        agent: "gemini",
        model: "flash",
        piSessionId: "s1",
      };
      saveCliSessionId(key, "live-id");
      const rec = loadCliSessionRecord(key)!;
      const path = join(home, ".pi", "cli-sessions");
      const files = readdirSync(path);
      writeFileSync(
        join(path, files[0]),
        JSON.stringify({
          ...rec,
          status: "running",
          lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      );
      const n = reapStaleCliSessions({
        inactivityThresholdMs: 1_000,
        activePiSessionId: "s1",
      });
      assert.equal(n, 0);
      assert.equal(loadCliSessionId(key), "live-id");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reaps idle stopped session markers", () => {
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    const home = mkdtempSync(join(tmpdir(), "cli-reap-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const key: CliSessionKey = {
        cwd: "/proj",
        agent: "gemini",
        model: "flash",
        piSessionId: "s1",
      };
      saveCliSessionId(key, "old-id");
      const rec = loadCliSessionRecord(key)!;
      const path = join(home, ".pi", "cli-sessions");
      const files = readdirSync(path);
      assert.equal(files.length, 1);
      writeFileSync(
        join(path, files[0]),
        JSON.stringify({
          ...rec,
          status: "stopped",
          lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      );
      const n = reapStaleCliSessions({ inactivityThresholdMs: 1_000 });
      assert.equal(n, 1);
      assert.equal(loadCliSessionId(key), null);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
