/**
 * Opt-in zero-mock end-to-end test for rootless Podman COMS peer sandboxing (#1512).
 *
 * Skips cleanly in standard CI environments without Podman or without `PI_PODMAN_E2E=1`.
 * Run manually when rootless Podman and a built `localhost/pi-peer:*` image are available:
 *   npm run test:podman-e2e
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  buildPeerContainerName,
  isPodmanAvailable,
  listCachedPeerImageTags,
} from "../../../scripts/podman-peer-image.mjs";
import { ComsRegistry, isRegistryRowAlive } from "../../../extensions/coms/coms-registry.ts";

const E2E_ENABLED = process.env.PI_PODMAN_E2E === "1";
const PODMAN_OK = E2E_ENABLED && isPodmanAvailable();
const CACHED_IMAGES = PODMAN_OK ? listCachedPeerImageTags() : [];
const SKIP_REASON = !E2E_ENABLED
  ? "Set PI_PODMAN_E2E=1 to run live rootless Podman E2E tests"
  : !PODMAN_OK
    ? "rootless podman is not available on PATH"
    : CACHED_IMAGES.length === 0
      ? "no cached localhost/pi-peer:* image built yet"
      : false;

describe("Rootless Podman COMS peer zero-mock E2E (#1512)", { skip: SKIP_REASON }, () => {
  it("boots a real rootless Podman peer, stays alive past 60s, isolates host fs, and tears down cleanly", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-podman-e2e-"));
    const comsDir = path.join(tmpRoot, "coms");
    const repoDir = path.join(tmpRoot, "repo");
    const project = `e2e-${Date.now()}`;
    const cname = "podman-e2e-peer";
    const containerName = buildPeerContainerName(project, cname);
    const supervisorScript = path.resolve("scripts", "coms-peer-supervisor.mjs");

    fs.mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "E2E Tester"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "e2e@example.com"], { cwd: repoDir, stdio: "ignore" });
    fs.writeFileSync(path.join(repoDir, "README.md"), "# e2e\n");
    execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "ignore" });

    const supervisor = spawn(
      process.execPath,
      [
        supervisorScript,
        cname,
        "--project", project,
        "--cwd", repoDir,
        "--purpose", "Zero-mock Podman E2E verification",
        "--sandbox", "podman",
        "--image", CACHED_IMAGES[0]!,
      ],
      {
        env: { ...process.env, PI_COMS_DIR: comsDir },
        stdio: "ignore",
      },
    );

    try {
      const registry = new ComsRegistry(comsDir);
      let row = null;
      for (let i = 0; i < 60; i++) {
        const live = registry.readLiveRows();
        row = live.find((r) => r.name === cname && r.project === project) ?? null;
        if (row) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      assert.ok(row, "expected containerized peer to register in COMS registry");
      assert.equal(row.container, containerName);

      // Verify host isolation inside container: ~/.ssh absent and /opt/pi-config read-only
      const sshCheck = execFileSync(
        "podman",
        ["exec", containerName, "bash", "-c", "test ! -e /home/peer/.ssh && test ! -w /opt/pi-config && echo OK"],
        { encoding: "utf8", timeout: 10_000 },
      ).trim();
      assert.equal(sshCheck, "OK");

      // Stay alive past 60s heartbeat window
      await new Promise((r) => setTimeout(r, 62_000));
      const refreshed = registry.readRows().find((r) => r.name === cname && r.project === project);
      assert.ok(refreshed, "peer registry row missing after 60s");
      assert.equal(isRegistryRowAlive(refreshed), true);

      // Graceful stop via supervisor SIGTERM removes container cleanly
      supervisor.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 15_000);
        supervisor.once("exit", () => { clearTimeout(t); resolve(); });
      });

      const inspectRunning = (() => {
        try {
          execFileSync("podman", ["inspect", "--", containerName], { stdio: "ignore", timeout: 5000 });
          return true;
        } catch {
          return false;
        }
      })();
      assert.equal(inspectRunning, false, "container should be removed after supervisor stop");
    } finally {
      try { supervisor.kill("SIGKILL"); } catch { /* ignore */ }
      try { execFileSync("podman", ["rm", "-f", "--", containerName], { stdio: "ignore", timeout: 10_000 }); } catch { /* ignore */ }
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
