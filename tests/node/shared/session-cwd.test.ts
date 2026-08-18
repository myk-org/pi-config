/**
 * #768 — per-turn session cwd ALS (CLI/ACPX spawn).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  adapterMemoryKey,
  adapterMemoryKeyMatchesCwd,
  deleteKeysForCwd,
  enterSessionCwd,
  getSessionCwd,
  resolveAdapterCwd,
  resolveProviderStreamCwd,
  runWithSessionCwd,
} from "../../../extensions/shared/session-cwd.js";

describe("session cwd ALS (#768)", () => {
  it("runWithSessionCwd binds getSessionCwd for the callback", () => {
    assert.equal(getSessionCwd(), undefined);
    const inner = runWithSessionCwd("/tmp/job-a", () => getSessionCwd());
    assert.equal(inner, "/tmp/job-a");
    assert.equal(getSessionCwd(), undefined);
  });

  it("keeps concurrent runs isolated", async () => {
    const [a, b] = await Promise.all([
      runWithSessionCwd("/tmp/job-a", async () => {
        await Promise.resolve();
        return getSessionCwd();
      }),
      runWithSessionCwd("/tmp/job-b", async () => {
        await Promise.resolve();
        return getSessionCwd();
      }),
    ]);
    assert.equal(a, "/tmp/job-a");
    assert.equal(b, "/tmp/job-b");
  });

  it("resolveProviderStreamCwd prefers ALS over boot cwd", () => {
    assert.equal(resolveProviderStreamCwd("/app"), "/app");
    const resolved = runWithSessionCwd("/tmp/ws", () =>
      resolveProviderStreamCwd("/app"),
    );
    assert.equal(resolved, "/tmp/ws");
  });

  it("resolveAdapterCwd prefers handle.cwd", () => {
    assert.equal(resolveAdapterCwd({ cwd: "/tmp/ws" }, "/app"), "/tmp/ws");
    assert.equal(resolveAdapterCwd({}, "/app"), "/app");
    assert.equal(resolveAdapterCwd({ cwd: "" }, "/app"), "/app");
  });

  it("enterSessionCwd does not clobber an existing ALS store", () => {
    runWithSessionCwd("/tmp/outer", () => {
      enterSessionCwd("/tmp/entered");
      assert.equal(getSessionCwd(), "/tmp/outer");
    });
    assert.equal(getSessionCwd(), undefined);
  });

  it("adapterMemoryKey isolates model+cwd", () => {
    const a = adapterMemoryKey("auto", "/tmp/job-a");
    const b = adapterMemoryKey("auto", "/tmp/job-b");
    assert.notEqual(a, b);
    assert.equal(adapterMemoryKeyMatchesCwd(a, "/tmp/job-a"), true);
    assert.equal(adapterMemoryKeyMatchesCwd(a, "/tmp/job-b"), false);
    const map = new Map<string, string>([[a, "prompt-a"], [b, "prompt-b"]]);
    deleteKeysForCwd(map, "/tmp/job-a");
    assert.equal(map.has(a), false);
    assert.equal(map.get(b), "prompt-b");
  });
});
