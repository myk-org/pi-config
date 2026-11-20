import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createDaemonServer, resolveUiDir } from "../../../scripts/daemon-shared.ts";
import { buildUiDist } from "../../../scripts/serve-ui.ts";
import { makeTempDir } from "../helpers/temp-dirs.js";

describe("resolveUiDir", () => {
  const uiPath = ["..", "extensions", "pidash", "pidash-ui", "dist"];

  it("prefers the process program path", () => {
    assert.equal(
      resolveUiDir("/installed/scripts/pidash-server.ts", "file:///source/scripts/pidash-server.ts", ...uiPath),
      path.normalize("/installed/extensions/pidash/pidash-ui/dist"),
    );
  });

  it("falls back to the ESM module URL for programmatic imports", () => {
    assert.equal(
      resolveUiDir(undefined, "file:///source/scripts/pidash-server.ts", ...uiPath),
      path.normalize("/source/extensions/pidash/pidash-ui/dist"),
    );
  });
});

describe("daemon browser fanout helpers (#1265, #1283)", () => {
  it("sendToMatchingBrowsers filters, accepts raw strings, and removes broken sockets", () => {
    const daemon = createDaemonServer({
      port: 0,
      uiDir: "/nonexistent",
      uiName: "test",
      log: () => {},
      onPiMessage: () => {},
      onPiClose: () => {},
    });

    const receivedA: string[] = [];
    const receivedB: string[] = [];
    const wsA = { send: (data: string) => receivedA.push(data) };
    const wsB = { send: (data: string) => receivedB.push(data) };
    const wsBroken = { send: () => { throw new Error("closed"); } };

    daemon.browserClients.add(wsA);
    daemon.browserClients.add(wsB);
    daemon.browserClients.add(wsBroken);
    daemon.browserWatchMap.set(wsA, "s1");
    daemon.browserWatchMap.set(wsB, "s2");
    daemon.browserWatchMap.set(wsBroken, "s1");

    daemon.sendToMatchingBrowsers((_ws, watch) => watch === "s1", { type: "ping" });
    assert.deepEqual(receivedA, ['{"type":"ping"}']);
    assert.deepEqual(receivedB, []);
    assert.equal(daemon.browserClients.has(wsBroken), false, "broken socket removed");

    daemon.sendToMatchingBrowsers((_ws, watch) => watch === "s2", '{"raw":true}');
    assert.deepEqual(receivedB, ['{"raw":true}']);

    daemon.broadcastToBrowsers('{"broadcast":1}');
    assert.deepEqual(receivedA, ['{"type":"ping"}', '{"broadcast":1}']);
    assert.deepEqual(receivedB, ['{"raw":true}', '{"broadcast":1}']);
  });
});

describe("buildUiDist (#1289)", () => {
  it("returns false when package.json is absent", () => {
    const dir = makeTempDir("serve-ui-empty-");
    const logs: string[] = [];
    try {
      const ok = buildUiDist(dir, "test-ui", (m) => logs.push(m), (() => {
        throw new Error("should not execute");
      }) as any);
      assert.equal(ok, false);
      assert.deepEqual(logs, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs npm install && build and reports success or failure", () => {
    const dir = makeTempDir("serve-ui-pkg-");
    const logs: string[] = [];
    const cmds: string[] = [];
    try {
      writeFileSync(path.join(dir, "package.json"), "{}");
      const ok = buildUiDist(dir, "test-ui", (m) => logs.push(m), ((cmd: string) => {
        cmds.push(cmd);
        return Buffer.from("");
      }) as any);
      assert.equal(ok, true);
      assert.deepEqual(cmds, ["npm install --production=false && npm run build"]);
      assert.ok(logs.some((m) => m.includes("build complete")));

      const failLogs: string[] = [];
      const fail = buildUiDist(dir, "test-ui", (m) => failLogs.push(m), (() => {
        throw new Error("boom");
      }) as any);
      assert.equal(fail, false);
      assert.ok(failLogs.some((m) => m.includes("boom")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
