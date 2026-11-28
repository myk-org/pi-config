import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  DEFAULT_BASE_IMAGE,
  MIN_PI_VERSION,
  acquireBuildLock,
  buildPeerContainerName,
  buildPeerImageTag,
  buildPodmanRunArgs,
  clearCachedHostPiVersion,
  computePeerImageHash,
  detectHostPiVersion,
  isBuildLockActive,
  isCliEntrypoint,
  isSelinuxEnforcing,
  isValidPeerContainerName,
  prepareSandboxWorkspace,
  pruneStalePeerImages,
  readBuildStatus,
  resolveImageForSpawn,
  resolveImageForSpawnAsync,
  resolveSandboxBaseDir,
  rewriteRemoteToHttps,
  startBackgroundPeerImageBuild,
  validateBaseImage,
} from "../../../scripts/podman-peer-image.mjs";
import { ComsRegistry, isRegistryRowAlive } from "../../../extensions/coms/coms-registry.ts";
import {
  buildPeerSpawn,
  formatPeerDetailLines,
  formatPeerTable,
  listStoppedSupervisedPeers,
  planPeerKills,
  selectKillTargets,
  supervisedPeerKeys,
  type RegistryRow,
} from "../../../extensions/coms/coms-peers.ts";
import { buildPeerInfoRow } from "../../../extensions/coms/coms-drilldown.ts";
import { buildComsPeersPayload } from "../../../extensions/coms/coms-shared.ts";
import { attachSupervisionMeta, executePeerKillEntry } from "../../../extensions/coms/coms-wrapper.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function initTempGitRepo(dir: string, filename = "a.txt", content = "v1\n"): string {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, filename), content);
  execFileSync("git", ["add", filename], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
}

afterEach(() => {
  clearCachedHostPiVersion();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Podman sandbox settings schema", () => {
  const settingsKeys = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "settings-keys.json"), "utf8"));
  const exampleSettings = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "pi-config-settings.example.json"), "utf8"));

  it("defaults coms_peer_sandbox to off", () => {
    assert.equal(settingsKeys.coms_peer_sandbox.default, "off");
  });

  it("marks coms_peer_sandbox as global_only", () => {
    assert.equal(settingsKeys.coms_peer_sandbox.global_only, true);
  });

  it("restricts coms_peer_sandbox enum to off or podman", () => {
    assert.deepEqual(settingsKeys.coms_peer_sandbox.enum, ["off", "podman"]);
  });

  it("defaults coms_peer_sandbox_cpus to 4", () => {
    assert.equal(settingsKeys.coms_peer_sandbox_cpus.default, 4);
    assert.equal(settingsKeys.coms_peer_sandbox_cpus.global_only, true);
  });

  it("defaults coms_peer_sandbox_memory to 4g", () => {
    assert.equal(settingsKeys.coms_peer_sandbox_memory.default, "4g");
    assert.equal(settingsKeys.coms_peer_sandbox_memory.global_only, true);
  });

  it("defaults coms_peer_sandbox_base_image to pinned Fedora 45", () => {
    assert.equal(settingsKeys.coms_peer_sandbox_base_image.default, "registry.fedoraproject.org/fedora:45");
    assert.equal(settingsKeys.coms_peer_sandbox_base_image.global_only, true);
  });

  it("declares coms_peer_sandbox as off in pi-config-settings.example.json", () => {
    assert.equal(exampleSettings.coms_peer_sandbox, "off");
  });
});

describe("Containerfile.peer 3-layer structure", () => {
  const content = fs.readFileSync(path.join(REPO_ROOT, "Containerfile.peer"), "utf8");
  const instructions = content
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");

  it("declares pinned Fedora 45 BASE_IMAGE default before FROM", () => {
    const argIdx = instructions.indexOf("ARG BASE_IMAGE=registry.fedoraproject.org/fedora:45");
    const fromIdx = instructions.indexOf("FROM ${BASE_IMAGE}");
    assert.ok(argIdx >= 0, "missing ARG BASE_IMAGE");
    assert.ok(fromIdx > argIdx, "FROM must follow ARG BASE_IMAGE");
  });

  it("never references a floating :latest tag", () => {
    assert.doesNotMatch(instructions, /:latest\b/i);
  });

  it("never hardcodes a default PI_VERSION value", () => {
    assert.match(instructions, /^ARG PI_VERSION\s*$/m);
    assert.doesNotMatch(instructions, /^ARG PI_VERSION=.+/m);
  });

  it("declares ARG PI_VERSION after scripts/install.py Layer 2", () => {
    const installIdx = instructions.indexOf("uv run /tmp/install.py --all");
    const piVersionIdx = instructions.indexOf("ARG PI_VERSION");
    assert.ok(installIdx > 0, "missing install.py Layer 2");
    assert.ok(piVersionIdx > installIdx, "ARG PI_VERSION must appear after Layer 2 for 3-layer caching");
  });

  it("folds /opt/node_modules move into the same RUN instruction as install.py", () => {
    const layer2Match = instructions.match(/uv run \/tmp\/install\.py --all[\s\S]*?ln -s \/opt\/node_modules/);
    assert.ok(layer2Match, "missing folded node_modules move");
    assert.doesNotMatch(layer2Match[0], /\nRUN\s/);
  });

  it("omits socat from installed packages", () => {
    assert.doesNotMatch(instructions, /\bsocat\b/);
  });

  it("omits sshd from installed packages", () => {
    assert.doesNotMatch(instructions, /\bopenssh-server\b|\bsshd\b/);
  });

  it("omits Fedora nodejs RPM to avoid libicu Intl.Segmenter SIGSEGV", () => {
    const dnfBlock = instructions.match(/dnf install[\s\S]*?dnf clean all/);
    assert.ok(dnfBlock, "missing dnf install block");
    assert.doesNotMatch(dnfBlock[0], /^\s+nodejs\s*\\?$/m);
    assert.doesNotMatch(dnfBlock[0], /^\s+npm\s*\\?$/m);
  });

  it("installs official upstream Node 22 tarball into /usr/local", () => {
    assert.match(instructions, /https:\/\/nodejs\.org\/dist\/v\$\{NODE_VERSION\}\/\$\{tarball\}/);
    assert.match(instructions, /tar -xJf "\$\{tarball\}" -C \/usr\/local --strip-components=1/);
    assert.match(instructions, /Intl\.Segmenter/);
  });

  it("does not persist UV_TOOL_BIN_DIR in runtime ENV", () => {
    const envBlocks = instructions.match(/^ENV[\s\S]*?(?=\n\n|\n[A-Z]+ )/gm) ?? [];
    for (const block of envBlocks) {
      assert.doesNotMatch(block, /UV_TOOL_BIN_DIR/);
    }
  });

  it("scopes UV_TOOL_BIN_DIR to the Layer 2 install.py RUN invocation", () => {
    assert.match(instructions, /UV_TOOL_BIN_DIR=\/home\/peer\/\.local\/bin uv run \/tmp\/install\.py --all/);
  });
});

describe("Peer image validation", () => {
  it("rejects floating :latest base image", () => {
    const res = validateBaseImage("registry.fedoraproject.org/fedora:latest");
    assert.equal(res.ok, false);
  });

  it("rejects untagged base image", () => {
    const res = validateBaseImage("registry.fedoraproject.org/fedora");
    assert.equal(res.ok, false);
  });

  it("accepts explicit version-tagged base image", () => {
    const res = validateBaseImage("registry.fedoraproject.org/fedora:45");
    assert.equal(res.ok, true);
  });

  it("accepts sha256 digest-pinned base image", () => {
    const digest = "a".repeat(64);
    const res = validateBaseImage(`registry.fedoraproject.org/fedora@sha256:${digest}`);
    assert.equal(res.ok, true);
  });

  it("detects semver from pi --version output", () => {
    const ver = detectHostPiVersion({ execFileSync: () => "1.8.2\n" });
    assert.equal(ver, "1.8.2");
  });

  it("rejects host Pi version below MIN_PI_VERSION with actionable pi update guidance", () => {
    assert.throws(
      () => detectHostPiVersion({ execFileSync: () => "1.6.1\n", minVersion: MIN_PI_VERSION }),
      /below required minimum.*pi update/,
    );
  });

  it("includes pi update guidance when Pi version output cannot be parsed", () => {
    assert.throws(
      () => detectHostPiVersion({ execFileSync: () => "unknown\n", minVersion: MIN_PI_VERSION }),
      /Could not parse.*pi update/,
    );
  });
});

describe("Content-hash peer image tags", () => {
  const baseInputs = {
    containerfileContent: "FROM fedora:45",
    installPyContent: "print('install')",
    installSourcesContent: "PI_CONFIG_NPM='x'",
    baseImage: DEFAULT_BASE_IMAGE,
    piVersion: "1.7.0",
  };

  it("computes a deterministic 12-char lowercase hex hash", () => {
    const hash = computePeerImageHash(baseInputs);
    assert.match(hash, /^[a-f0-9]{12}$/);
    assert.equal(hash, computePeerImageHash(baseInputs));
  });

  it("changes hash when piVersion changes", () => {
    const h1 = computePeerImageHash(baseInputs);
    const h2 = computePeerImageHash({ ...baseInputs, piVersion: "1.7.1" });
    assert.notEqual(h1, h2);
  });

  it("changes hash when installPyContent changes", () => {
    const h1 = computePeerImageHash(baseInputs);
    const h2 = computePeerImageHash({ ...baseInputs, installPyContent: "print('v2')" });
    assert.notEqual(h1, h2);
  });

  it("changes hash when baseImage changes", () => {
    const h1 = computePeerImageHash(baseInputs);
    const h2 = computePeerImageHash({ ...baseInputs, baseImage: "registry.fedoraproject.org/fedora:46" });
    assert.notEqual(h1, h2);
  });

  it("formats tags under localhost/pi-peer", () => {
    assert.equal(buildPeerImageTag("abcdef012345"), "localhost/pi-peer:abcdef012345");
  });
});

describe("Host-agnostic Podman run argv builder", () => {
  const expectedContainer = buildPeerContainerName("my-project", "worker-1");
  const baseRunOpts = {
    imageTag: "localhost/pi-peer:abcdef012345",
    uid: 12345,
    gid: 12345,
    selinuxEnforcing: false,
    cpus: 4,
    memory: "4g",
    piConfigDir: "/opt/host/pi-orchestrator-config",
    agentDir: "/tmp/peer-agent-dir",
    hostAuthJsonPath: "/tmp/host-agent/auth.json",
    hostModelsJsonPath: "/tmp/host-agent/models.json",
    entrypointPath: "/opt/host/scripts/podman-peer-entrypoint.sh",
    gitconfigSeedPath: "/tmp/peer-sandbox/gitconfig.seed",
    workspacePath: "/tmp/peer-sandbox/workspace",
    comsDir: "/tmp/host-coms",
    cname: "worker-1",
    project: "my-project",
    purpose: "Run tests",
    env: { GITHUB_TOKEN: "ghp_secret_value" },
  };

  it("builds deterministic identity-hashed pi-peer names", () => {
    const n1 = buildPeerContainerName("My_Project", "Worker_01");
    assert.match(n1, /^pi-peer-my_project-worker_01-[a-f0-9]{8}$/);
    assert.equal(n1, buildPeerContainerName("My_Project", "Worker_01"));
  });

  it("assigns distinct container names when peer identities differ only in case", () => {
    const lower = buildPeerContainerName("proj", "worker");
    const upper = buildPeerContainerName("Proj", "Worker");
    assert.notEqual(lower, upper);
  });

  it("assigns distinct container names when long peer names share a 26-char prefix", () => {
    const a = buildPeerContainerName("my-project", "very-long-worker-name-prefix-alpha");
    const b = buildPeerContainerName("my-project", "very-long-worker-name-prefix-beta");
    assert.notEqual(a, b);
  });

  it("rejects non-peer or flag-like container names in isValidPeerContainerName", () => {
    assert.equal(isValidPeerContainerName("-a"), false);
    assert.equal(isValidPeerContainerName("--all"), false);
    assert.equal(isValidPeerContainerName("other-container"), false);
    assert.equal(isValidPeerContainerName(expectedContainer), true);
  });

  it("rewrites SCP-style SSH git remotes to HTTPS", () => {
    assert.equal(rewriteRemoteToHttps("git@github.com:myk-org/pi-config.git"), "https://github.com/myk-org/pi-config.git");
  });

  it("rewrites ssh:// git remotes to HTTPS", () => {
    assert.equal(rewriteRemoteToHttps("ssh://git@github.com/myk-org/pi-config.git"), "https://github.com/myk-org/pi-config.git");
  });

  it("strips embedded credentials from HTTPS git remotes", () => {
    assert.equal(
      rewriteRemoteToHttps("https://user:secret-token@github.com/myk-org/pi-config.git"), // pragma: allowlist secret
      "https://github.com/myk-org/pi-config.git",
    );
  });

  it("detects SELinux enforcing state from /sys/fs/selinux/enforce", () => {
    assert.equal(isSelinuxEnforcing(() => "1\n"), true);
    assert.equal(isSelinuxEnforcing(() => "0\n"), false);
  });

  it("includes --init for zombie reaping", () => {
    const argv = buildPodmanRunArgs(baseRunOpts);
    assert.ok(argv.includes("--init"));
  });

  it("includes --userns=keep-id:uid=1000,gid=1000 for non-root host UIDs", () => {
    const argv = buildPodmanRunArgs(baseRunOpts);
    assert.ok(argv.includes("--userns=keep-id:uid=1000,gid=1000"));
  });

  it("passes --security-opt label=disable when SELinux is enforcing", () => {
    const argv = buildPodmanRunArgs({ ...baseRunOpts, selinuxEnforcing: true });
    const idx = argv.indexOf("--security-opt");
    assert.ok(idx >= 0);
    assert.equal(argv[idx + 1], "label=disable");
  });

  it("omits --security-opt label=disable when SELinux is not enforcing", () => {
    const argv = buildPodmanRunArgs({ ...baseRunOpts, selinuxEnforcing: false });
    assert.equal(argv.includes("--security-opt"), false);
  });

  it("never passes :Z or :z mount relabel suffixes", () => {
    const argv = buildPodmanRunArgs({ ...baseRunOpts, selinuxEnforcing: true });
    for (const arg of argv) {
      assert.doesNotMatch(arg, /:[zZ](?:,|$)/);
    }
  });

  it("never mounts host ~/.ssh", () => {
    const argv = buildPodmanRunArgs(baseRunOpts);
    for (const arg of argv) {
      assert.equal(arg.includes(".ssh"), false);
    }
  });

  it("mounts only the peer project registry with sockets dir instead of full coms root", () => {
    const argv = buildPodmanRunArgs(baseRunOpts);
    assert.equal(argv.includes(`${baseRunOpts.comsDir}:${baseRunOpts.comsDir}:rw`), false);
    assert.ok(argv.includes(`${path.join(baseRunOpts.comsDir, "projects", "my-project")}:${path.join(baseRunOpts.comsDir, "projects", "my-project")}:rw`));
    assert.ok(argv.includes(`${path.join(baseRunOpts.comsDir, "sockets")}:${path.join(baseRunOpts.comsDir, "sockets")}:rw`));
  });

  it("places sandbox directories outside ~/.pi/coms", () => {
    const base = resolveSandboxBaseDir("/tmp/fake-home");
    assert.equal(base, path.join("/tmp/fake-home", ".pi", "sandboxes"));
    assert.equal(base.includes("coms"), false);
  });

  it("sets PI_PIDASH_HOST to host.containers.internal", () => {
    const argv = buildPodmanRunArgs(baseRunOpts);
    assert.ok(argv.includes("PI_PIDASH_HOST=host.containers.internal"));
  });

  it("sets PI_PIDIFF_HOST to host.containers.internal", () => {
    const argv = buildPodmanRunArgs(baseRunOpts);
    assert.ok(argv.includes("PI_PIDIFF_HOST=host.containers.internal"));
  });

  it("sets PI_COMS_CONTAINER_NAME to deterministic container name", () => {
    const argv = buildPodmanRunArgs(baseRunOpts);
    assert.ok(argv.includes(`PI_COMS_CONTAINER_NAME=${expectedContainer}`));
  });

  it("mounts host pi-orchestrator-config read-only at /opt/pi-config", () => {
    const argv = buildPodmanRunArgs(baseRunOpts);
    assert.ok(argv.includes(`${baseRunOpts.piConfigDir}:/opt/pi-config:ro`));
  });

  it("mounts workspace at identical host path", () => {
    const argv = buildPodmanRunArgs(baseRunOpts);
    assert.ok(argv.includes(`${baseRunOpts.workspacePath}:${baseRunOpts.workspacePath}:rw`));
  });

  it("passes secret env vars by key name without exposing values in argv", () => {
    const argv = buildPodmanRunArgs(baseRunOpts);
    assert.ok(argv.includes("GITHUB_TOKEN"));
    for (const arg of argv) {
      assert.equal(arg.includes("ghp_secret_value"), false);
    }
  });

  it("omits auth.json mount when host auth.json path is null", () => {
    const argv = buildPodmanRunArgs({ ...baseRunOpts, hostAuthJsonPath: null });
    assert.equal(argv.some((a) => a.includes("auth.json")), false);
  });
});

describe("Sandbox workspace isolation", () => {
  it("rejects non-Git host directories instead of mounting them writable", () => {
    const nonGit = makeTempDir("pi-nongit-");
    const sandboxDir = makeTempDir("pi-sandbox-");
    assert.throws(
      () => prepareSandboxWorkspace({ sandboxDir, sourceCwd: nonGit, project: "proj", cname: "w1" }),
      /requires a Git repository/,
    );
  });

  it("clones Git objects with distinct inodes via --no-hardlinks", () => {
    const srcRepo = makeTempDir("pi-src-repo-");
    const sandboxDir = makeTempDir("pi-sb-clone-");
    initTempGitRepo(srcRepo);
    const { workspaceDir } = prepareSandboxWorkspace({ sandboxDir, sourceCwd: srcRepo, project: "proj", cname: "w1" });

    const findFirstLooseObject = (repoPath: string): string => {
      const objRoot = path.join(repoPath, ".git", "objects");
      for (const entry of fs.readdirSync(objRoot)) {
        if (!/^[a-f0-9]{2}$/.test(entry)) continue;
        const sub = path.join(objRoot, entry);
        for (const file of fs.readdirSync(sub)) {
          return path.join(sub, file);
        }
      }
      throw new Error("no loose git object found");
    };

    const srcObj = findFirstLooseObject(srcRepo);
    const relObj = path.relative(path.join(srcRepo, ".git", "objects"), srcObj);
    const dstObj = path.join(workspaceDir, ".git", "objects", relObj);
    assert.ok(fs.existsSync(dstObj), "cloned loose object should exist");
    assert.notEqual(fs.statSync(srcObj).ino, fs.statSync(dstObj).ino);
  });

  it("re-clones when source repository path changes for the same peer name", () => {
    const repoA = makeTempDir("pi-repo-a-");
    const repoB = makeTempDir("pi-repo-b-");
    const sandboxDir = makeTempDir("pi-sb-switch-");
    initTempGitRepo(repoA, "only-a.txt", "A\n");
    initTempGitRepo(repoB, "only-b.txt", "B\n");

    const first = prepareSandboxWorkspace({ sandboxDir, sourceCwd: repoA, project: "proj", cname: "w1" });
    assert.equal(fs.existsSync(path.join(first.workspaceDir, "only-a.txt")), true);

    const second = prepareSandboxWorkspace({ sandboxDir, sourceCwd: repoB, project: "proj", cname: "w1" });
    assert.equal(second.cloned, true);
    assert.equal(fs.existsSync(path.join(second.workspaceDir, "only-b.txt")), true);
    assert.equal(fs.existsSync(path.join(second.workspaceDir, "only-a.txt")), false);
  });

  it("reuses the existing sandbox clone on revive when cwd equals workspaceDir", () => {
    const srcRepo = makeTempDir("pi-repo-revive-");
    const sandboxDir = makeTempDir("pi-sb-revive-");
    initTempGitRepo(srcRepo);

    const first = prepareSandboxWorkspace({ sandboxDir, sourceCwd: srcRepo, project: "proj", cname: "w1" });
    fs.writeFileSync(path.join(first.workspaceDir, "uncommitted.txt"), "keep-me\n");

    const revived = prepareSandboxWorkspace({
      sandboxDir,
      sourceCwd: first.workspaceDir,
      project: "proj",
      cname: "w1",
    });
    assert.equal(revived.revived, true);
    assert.equal(revived.cloned, false);
    assert.equal(fs.readFileSync(path.join(revived.workspaceDir, "uncommitted.txt"), "utf8"), "keep-me\n");
  });

  it("preserves existing workspace intact when replacement git clone fails", () => {
    const repoA = makeTempDir("pi-repo-keep-a-");
    const repoB = makeTempDir("pi-repo-keep-b-");
    const sandboxDir = makeTempDir("pi-sb-keep-");
    initTempGitRepo(repoA, "existing.txt", "keep\n");
    initTempGitRepo(repoB, "new.txt", "new\n");

    const first = prepareSandboxWorkspace({ sandboxDir, sourceCwd: repoA, project: "proj", cname: "w1" });
    assert.throws(() => {
      prepareSandboxWorkspace({
        sandboxDir,
        sourceCwd: repoB,
        project: "proj",
        cname: "w1",
        execFileSync: (cmd: string, args: string[], opts: any) => {
          if (args[0] === "clone") throw new Error("simulated clone failure");
          return execFileSync(cmd, args, opts);
        },
      });
    }, /simulated clone failure/);
    assert.equal(fs.readFileSync(path.join(first.workspaceDir, "existing.txt"), "utf8"), "keep\n");
  });

  it("backs up existing workspace to .bak when source HEAD moves over uncommitted edits", () => {
    const repo = makeTempDir("pi-repo-dirty-");
    const sandboxDir = makeTempDir("pi-sb-dirty-");
    initTempGitRepo(repo, "file.txt", "v1\n");

    const first = prepareSandboxWorkspace({ sandboxDir, sourceCwd: repo, project: "proj", cname: "w1" });
    fs.writeFileSync(path.join(first.workspaceDir, "peer-wip.txt"), "unsaved-work\n");

    // Advance source repo HEAD
    fs.writeFileSync(path.join(repo, "file.txt"), "v2\n");
    execFileSync("git", ["add", "file.txt"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "v2"], { cwd: repo, stdio: "ignore" });

    const second = prepareSandboxWorkspace({ sandboxDir, sourceCwd: repo, project: "proj", cname: "w1" });
    assert.equal(second.cloned, true);
    assert.ok(second.backupPath && second.backupPath.endsWith(".bak"));
    assert.equal(fs.readFileSync(path.join(second.backupPath!, "peer-wip.txt"), "utf8"), "unsaved-work\n");
    assert.equal(fs.readFileSync(path.join(second.workspaceDir, "file.txt"), "utf8"), "v2\n");
  });

  it("never executes peer-configured core.fsmonitor commands during host workspace inspection", () => {
    const repo = makeTempDir("pi-repo-fsm-");
    const sandboxDir = makeTempDir("pi-sb-fsm-");
    const markerFile = path.join(sandboxDir, "pwned-by-fsmonitor");
    initTempGitRepo(repo, "file.txt", "v1\n");

    const first = prepareSandboxWorkspace({ sandboxDir, sourceCwd: repo, project: "proj", cname: "w1" });
    // Simulate a hostile peer configuring core.fsmonitor inside its writable clone .git/config
    execFileSync("git", ["config", "core.fsmonitor", `touch "${markerFile}"`], { cwd: first.workspaceDir, stdio: "ignore" });

    // Advance source HEAD to trigger host-side inspection + re-clone
    fs.writeFileSync(path.join(repo, "file.txt"), "v2\n");
    execFileSync("git", ["add", "file.txt"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "v2"], { cwd: repo, stdio: "ignore" });

    prepareSandboxWorkspace({ sandboxDir, sourceCwd: repo, project: "proj", cname: "w1" });
    assert.equal(fs.existsSync(markerFile), false, "host must never execute peer core.fsmonitor");
  });

  it("backs up existing workspace when peer created only a gitignored file", () => {
    const repo = makeTempDir("pi-repo-ign-");
    const sandboxDir = makeTempDir("pi-sb-ign-");
    initTempGitRepo(repo, ".gitignore", "*.local\n");

    const first = prepareSandboxWorkspace({ sandboxDir, sourceCwd: repo, project: "proj", cname: "w1" });
    fs.writeFileSync(path.join(first.workspaceDir, "notes.local"), "ignored-peer-output\n");

    fs.writeFileSync(path.join(repo, "next.txt"), "v2\n");
    execFileSync("git", ["add", "next.txt"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "v2"], { cwd: repo, stdio: "ignore" });

    const second = prepareSandboxWorkspace({ sandboxDir, sourceCwd: repo, project: "proj", cname: "w1" });
    assert.ok(second.backupPath && second.backupPath.endsWith(".bak"));
    assert.equal(fs.readFileSync(path.join(second.backupPath!, "notes.local"), "utf8"), "ignored-peer-output\n");
  });

  it("does not create spurious backups for a clean origin-less clone when source HEAD advances", () => {
    const repo = makeTempDir("pi-repo-noorigin-");
    const sandboxDir = makeTempDir("pi-sb-noorigin-");
    initTempGitRepo(repo, "file.txt", "v1\n");

    prepareSandboxWorkspace({ sandboxDir, sourceCwd: repo, project: "proj", cname: "w1" });

    fs.writeFileSync(path.join(repo, "file.txt"), "v2\n");
    execFileSync("git", ["add", "file.txt"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "v2"], { cwd: repo, stdio: "ignore" });

    const second = prepareSandboxWorkspace({ sandboxDir, sourceCwd: repo, project: "proj", cname: "w1" });
    assert.equal(second.cloned, true);
    assert.equal(second.backupPath, null);
  });

  it("prunes older workspace backups beyond maxBackups", () => {
    const repo = makeTempDir("pi-repo-prune-");
    const sandboxDir = makeTempDir("pi-sb-prune-");
    initTempGitRepo(repo, "file.txt", "v1\n");

    // Pre-seed 3 older backup directories
    fs.mkdirSync(path.join(sandboxDir, "workspace.1000.bak"), { recursive: true });
    fs.mkdirSync(path.join(sandboxDir, "workspace.2000.bak"), { recursive: true });
    fs.mkdirSync(path.join(sandboxDir, "workspace.3000.bak"), { recursive: true });

    const first = prepareSandboxWorkspace({ sandboxDir, sourceCwd: repo, project: "proj", cname: "w1", maxBackups: 2 });
    assert.equal(first.cloned, true);
    const remaining = fs.readdirSync(sandboxDir).filter((n) => /^workspace\.\d+\.bak$/.test(n));
    assert.equal(remaining.length, 2);
  });
});

describe("File-locked background pre-warm", () => {
  it("prevents duplicate lock acquisition while owner PID is alive", () => {
    const dir = makeTempDir("pi-lock-");
    const lockPath = path.join(dir, "podman-peer-build.lock");
    const first = acquireBuildLock(lockPath, { pid: 4242, targetTag: "localhost/pi-peer:aaaa11112222" }, (p) => p === 4242);
    assert.equal(first.acquired, true);
    const second = acquireBuildLock(lockPath, { pid: 9999, targetTag: "localhost/pi-peer:bbbb11112222" }, (p) => p === 4242);
    assert.equal(second.acquired, false);
    assert.equal(second.owner?.pid, 4242);
    first.release();
    assert.equal(fs.existsSync(lockPath), false);
  });

  it("recovers stale lockfile when owner PID is dead", () => {
    const dir = makeTempDir("pi-lock-stale-");
    const lockPath = path.join(dir, "podman-peer-build.lock");
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 777777, targetTag: "localhost/pi-peer:old" }));
    assert.equal(isBuildLockActive(lockPath, () => false).active, false);
    const acquired = acquireBuildLock(lockPath, { pid: process.pid, targetTag: "localhost/pi-peer:new" }, () => true);
    assert.equal(acquired.acquired, true);
    acquired.release();
  });

  it("writes building status before spawning worker so fast worker ready status is preserved", () => {
    const dir = makeTempDir("pi-race-");
    const statusPath = path.join(dir, "build.status.json");
    const lockPath = path.join(dir, "build.lock");
    const logPath = path.join(dir, "podman-build.log");
    startBackgroundPeerImageBuild({
      homeDir: dir,
      lockPath,
      statusPath,
      logPath,
      packageRoot: REPO_ROOT,
      piVersion: "1.7.0",
      execFileSync: (_cmd: string, args: string[]) => {
        if (args[0] === "--version") return "podman version 6.2.0";
        if (args[0] === "image" && args[1] === "exists") throw new Error("not found");
        return "";
      },
      spawn: () => {
        // Simulate fast worker finishing immediately and publishing ready before spawn returns
        fs.writeFileSync(statusPath, JSON.stringify({ state: "ready", targetTag: "localhost/pi-peer:fast", logPath }));
        return { pid: 55551, unref() {} };
      },
    });
    const finalSnap = readBuildStatus({ lockPath, statusPath, logPath, pidAliveFn: () => false });
    assert.equal(finalSnap.state, "ready");
  });

  it("boots immediately on prior cached tag while target tag builds in background", () => {
    const dir = makeTempDir("pi-fallback-");
    let spawned = 0;
    const res = resolveImageForSpawn({
      homeDir: dir,
      packageRoot: REPO_ROOT,
      piVersion: "1.7.0",
      execFileSync: (_cmd: string, args: string[]) => {
        if (args[0] === "--version") return "podman version 6.2.0";
        if (args[0] === "image" && args[1] === "exists") throw new Error("not found");
        if (args[0] === "images") return "localhost/pi-peer:000011112222\n";
        return "";
      },
      spawn: () => {
        spawned += 1;
        return { pid: 55555, unref() {} };
      },
    });
    assert.equal(res.action, "run");
    assert.equal(res.usingFallback, true);
    assert.equal(res.imageTag, "localhost/pi-peer:000011112222");
    assert.equal(spawned, 1);
  });

  it("resolves target image asynchronously via resolveImageForSpawnAsync", async () => {
    const dir = makeTempDir("pi-async-");
    const res = await resolveImageForSpawnAsync({
      homeDir: dir,
      packageRoot: REPO_ROOT,
      piVersion: "1.7.0",
      execFile: async (_cmd: string, args: string[]) => {
        if (args[0] === "--version") return { stdout: "podman version 6.2.0" };
        if (args[0] === "image" && args[1] === "exists") return { stdout: "" };
        return { stdout: "" };
      },
    });
    assert.equal(res.action, "run");
    assert.equal(res.usingFallback, false);
    assert.match(res.imageTag ?? "", /^localhost\/pi-peer:[a-f0-9]{12}$/);
  });

  it("returns non-blocking building status on cold first build with no cached image", () => {
    const dir = makeTempDir("pi-cold-");
    const res = resolveImageForSpawn({
      homeDir: dir,
      packageRoot: REPO_ROOT,
      piVersion: "1.7.0",
      execFileSync: (_cmd: string, args: string[]) => {
        if (args[0] === "--version") return "podman version 6.2.0";
        if (args[0] === "image" && args[1] === "exists") throw new Error("not found");
        if (args[0] === "images") return "";
        return "";
      },
      spawn: () => ({ pid: 55556, unref() {} }),
    });
    assert.equal(res.action, "building");
    assert.equal(res.imageTag, null);
    assert.ok(res.logPath.endsWith("podman-build.log"));
  });

  it("prunes older localhost/pi-peer tags while keeping the newly built tag", () => {
    const removed: string[] = [];
    const pruned = pruneStalePeerImages("localhost/pi-peer:newtag123456", {
      execFileSync: (_cmd: string, args: string[]) => {
        if (args[0] === "images") return "localhost/pi-peer:newtag123456\nlocalhost/pi-peer:oldtag654321\n";
        if (args[0] === "rmi") removed.push(args[1]);
        return "";
      },
      logger: { debug() {}, info() {}, warn() {}, error() {}, isDebugEnabled: () => false },
    });
    assert.deepEqual(pruned, ["localhost/pi-peer:oldtag654321"]);
    assert.deepEqual(removed, ["localhost/pi-peer:oldtag654321"]);
  });

  it("reports building state in readBuildStatus while lock owner PID is alive", () => {
    const dir = makeTempDir("pi-status-");
    const lockPath = path.join(dir, "build.lock");
    const statusPath = path.join(dir, "build.status.json");
    const logPath = path.join(dir, "podman-build.log");
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 4321, targetTag: "localhost/pi-peer:111122223333", logPath }));
    const snap = readBuildStatus({ lockPath, statusPath, logPath, pidAliveFn: (p: number) => p === 4321 });
    assert.equal(snap.state, "building");
    assert.equal(snap.targetTag, "localhost/pi-peer:111122223333");
  });
});

describe("COMS registry container liveness", () => {
  function makeRow(overrides: Partial<RegistryRow> = {}): RegistryRow {
    const dir = makeTempDir("pi-sock-");
    const sock = path.join(dir, "peer.sock");
    fs.writeFileSync(sock, "");
    return {
      project: "proj",
      name: "ctr-peer",
      pid: 0,
      cwd: "/tmp/work",
      purpose: "test",
      endpoint: sock,
      busy: false,
      queueDepth: 0,
      contextUsedPct: 10,
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      container: buildPeerContainerName("proj", "ctr-peer"),
      hostPid: null,
      ...overrides,
    };
  }

  it("treats containerized row with pid 0 as alive when heartbeat is fresh", () => {
    const row = makeRow();
    assert.equal(isRegistryRowAlive(row), true);
  });

  it("treats containerized row with live hostPid as alive", () => {
    const row = makeRow({ hostPid: process.pid });
    assert.equal(isRegistryRowAlive(row), true);
  });

  it("treats containerized row with dead hostPid as dead", () => {
    const row = makeRow({ hostPid: 99999999 });
    assert.equal(isRegistryRowAlive(row), false);
  });

  it("reads container field from registry JSON via ComsRegistry", () => {
    const dir = makeTempDir("pi-reg-");
    const reg = new ComsRegistry(dir);
    const ctrName = buildPeerContainerName("demo", "box-peer");
    reg.writeEntryAtomic({
      coms_session_id: "sess-1",
      name: "box-peer",
      purpose: "sandbox",
      model: "test-model",
      color: "#ffffff",
      pid: 0,
      endpoint: path.join(dir, "sockets", "sess-1.sock"),
      cwd: "/tmp/work",
      started_at: new Date().toISOString(),
      explicit: false,
      version: 1,
      container: ctrName,
      host_pid: process.pid,
    }, "demo");
    const rows = reg.readRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].container, ctrName);
    assert.equal(rows[0].hostPid, process.pid);
  });
});

describe("Container-aware peer kill", () => {
  const verifiedBoxContainer = buildPeerContainerName("proj", "box");

  it("selects containerized live peers even when pid is 0", () => {
    const row: RegistryRow = {
      project: "proj",
      name: "box",
      pid: 0,
      cwd: "/tmp/work",
      purpose: "",
      endpoint: "/tmp/a.sock",
      busy: false,
      queueDepth: 0,
      contextUsedPct: 0,
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      container: verifiedBoxContainer,
    };
    const sel = selectKillTargets([row], { name: "box" }, () => true);
    assert.equal(sel.targets.length, 1);
  });

  it("attaches verified container name from host supervision record in planPeerKills", () => {
    const records = [{ cname: "box", project: "proj", pid: 4000, childPid: 4001, container: verifiedBoxContainer }];
    const row: RegistryRow = {
      project: "proj",
      name: "box",
      pid: 0,
      cwd: "/tmp/work",
      purpose: "",
      endpoint: "/tmp/a.sock",
      busy: false,
      queueDepth: 0,
      contextUsedPct: 0,
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      container: verifiedBoxContainer,
    };
    const plan = planPeerKills({
      rows: [row],
      supervisedKeys: supervisedPeerKeys(records),
      records,
      request: { name: "box", project: "proj" },
      isAlive: () => true,
    });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].reason, "supervisor");
    assert.equal(plan[0].signalPid, 4000);
    assert.equal(plan[0].container, verifiedBoxContainer);
  });

  it("ignores tampered registry container flags like -a in planPeerKills", () => {
    const records = [{ cname: "box", project: "proj", pid: 4000, childPid: 4001, container: verifiedBoxContainer }];
    const row: RegistryRow = {
      project: "proj",
      name: "box",
      pid: 0,
      hostPid: 1,
      cwd: "/tmp/work",
      purpose: "",
      endpoint: "/tmp/a.sock",
      busy: false,
      queueDepth: 0,
      contextUsedPct: 0,
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      container: "-a",
    };
    const plan = planPeerKills({
      rows: [row],
      supervisedKeys: supervisedPeerKeys(records),
      records,
      request: { name: "box", project: "proj" },
      isAlive: () => true,
    });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].container, verifiedBoxContainer);
    assert.equal(plan[0].signalPid, 4000);
  });

  it("signals host supervisor first for graceful shutdown in executePeerKillEntry", () => {
    const removed: string[] = [];
    const killed: Array<[number, string]> = [];
    const ok = executePeerKillEntry(
      { name: "box", project: "proj", signalPid: 4000, container: verifiedBoxContainer, reason: "supervisor" },
      {
        isSupervisorProcess: () => true,
        removeContainer: (c) => removed.push(c),
        killPid: (pid, sig) => killed.push([pid, sig]),
      },
    );
    assert.equal(ok, true);
    assert.deepEqual(killed, [[4000, "SIGTERM"]]);
    assert.deepEqual(removed, []);
  });

  it("falls back to container removal without signalling a reused non-supervisor PID", () => {
    const removed: string[] = [];
    const killed: Array<[number, string]> = [];
    const ok = executePeerKillEntry(
      { name: "box", project: "proj", signalPid: 4000, container: verifiedBoxContainer, reason: "supervisor" },
      {
        isSupervisorProcess: () => false,
        removeContainer: (c) => removed.push(c),
        killPid: (pid, sig) => killed.push([pid, sig]),
      },
    );
    assert.equal(ok, true);
    assert.deepEqual(killed, []);
    assert.deepEqual(removed, [verifiedBoxContainer]);
  });

  it("never attaches stale Podman container or hostPid onto a live native peer row", () => {
    const nativeRow: RegistryRow = {
      project: "proj",
      name: "box",
      pid: process.pid,
      cwd: "/tmp/work",
      purpose: "native",
      endpoint: "/tmp/a.sock",
      busy: false,
      queueDepth: 0,
      contextUsedPct: 0,
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      container: null,
      hostPid: null,
    };
    const stalePodmanRecord = {
      cname: "box",
      project: "proj",
      createdBy: "agent",
      pid: 999999,
      childPid: 888888,
      container: verifiedBoxContainer,
      sandbox: "podman",
      startedAt: new Date().toISOString(),
    };
    attachSupervisionMeta([nativeRow], [stalePodmanRecord]);
    assert.equal(nativeRow.container, null);
    assert.equal(nativeRow.hostPid, null);
  });

  it("attaches hostPid when peer itself reports matching container identity", () => {
    const ctrRow: RegistryRow = {
      project: "proj",
      name: "box",
      pid: 0,
      cwd: "/tmp/work",
      purpose: "sandbox",
      endpoint: "/tmp/a.sock",
      busy: false,
      queueDepth: 0,
      contextUsedPct: 0,
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      container: verifiedBoxContainer,
      hostPid: null,
    };
    const podmanRecord = {
      cname: "box",
      project: "proj",
      createdBy: "agent",
      pid: 4000,
      childPid: 4001,
      container: verifiedBoxContainer,
      sandbox: "podman",
      startedAt: new Date().toISOString(),
    };
    attachSupervisionMeta([ctrRow], [podmanRecord]);
    assert.equal(ctrRow.hostPid, 4001);
  });

  it("falls back to container removal when no live supervisor is available", () => {
    const removed: string[] = [];
    const ok = executePeerKillEntry(
      { name: "box", project: "proj", signalPid: null, container: verifiedBoxContainer, reason: "peer" },
      { removeContainer: (c) => removed.push(c) },
    );
    assert.equal(ok, true);
    assert.deepEqual(removed, [verifiedBoxContainer]);
  });

  it("refuses flag-like container names in executePeerKillEntry", () => {
    const removed: string[] = [];
    const ok = executePeerKillEntry(
      { name: "box", project: "proj", signalPid: null, container: "-a", reason: "peer" },
      { removeContainer: (c) => removed.push(c) },
    );
    assert.equal(ok, false);
    assert.deepEqual(removed, []);
  });

  it("appends podman sandbox flags in buildPeerSpawn", () => {
    const res = buildPeerSpawn("/opt/sup/coms-peer-supervisor.mjs", {
      cname: "box",
      project: "proj",
      sandbox: "podman",
      image: "localhost/pi-peer:abcdef012345",
      cpus: 2,
      memory: "2g",
    });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.ok(res.command.includes("--sandbox"));
      assert.ok(res.command.includes("podman"));
      assert.ok(res.command.includes("--image"));
      assert.ok(res.command.includes("localhost/pi-peer:abcdef012345"));
    }
  });

  it("rejects buildPeerSpawn with podman sandbox when image is missing", () => {
    const res = buildPeerSpawn("/opt/sup/coms-peer-supervisor.mjs", {
      cname: "box",
      project: "proj",
      sandbox: "podman",
    });
    assert.equal(res.ok, false);
  });

  it("renders container badge in formatPeerTable", () => {
    const table = formatPeerTable([{
      project: "proj",
      name: "box",
      pid: 0,
      hostPid: 5150,
      cwd: "/tmp/work",
      purpose: "test",
      endpoint: "/tmp/a.sock",
      busy: false,
      queueDepth: 0,
      contextUsedPct: 12,
      startedAt: null,
      heartbeatAt: null,
      container: verifiedBoxContainer,
    }]);
    assert.ok(table.includes(`🐳 ${verifiedBoxContainer}`));
  });

  it("renders container line in formatPeerDetailLines", () => {
    const lines = formatPeerDetailLines({
      project: "proj",
      name: "box",
      pid: 0,
      hostPid: 5150,
      cwd: "/tmp/work",
      purpose: "test",
      endpoint: "/tmp/a.sock",
      busy: false,
      queueDepth: 0,
      contextUsedPct: 12,
      startedAt: null,
      heartbeatAt: null,
      container: verifiedBoxContainer,
    });
    assert.ok(lines.some((line) => line.includes(`container ${verifiedBoxContainer}`)));
  });

  it("renders Container detail row in buildPeerInfoRow", () => {
    const row = buildPeerInfoRow({
      name: "box",
      project: "proj",
      busy: false,
      container: verifiedBoxContainer,
    });
    assert.ok(row.items[0].detail.some(([k, v]) => k === "Container" && v === verifiedBoxContainer));
    assert.ok(row.items[0].detail.some(([k, v]) => k === "Shell" && v === `podman exec -it ${verifiedBoxContainer} bash`));
  });

  it("records explicit sandbox mode on stopped supervised peer rows", () => {
    const stopped = listStoppedSupervisedPeers(
      [
        { cname: "box", project: "proj", container: verifiedBoxContainer, sandbox: "podman", exitedAt: "2026-11-28T00:00:02.000Z" },
        { cname: "native", project: "proj", exitedAt: "2026-11-28T00:00:01.000Z" },
      ],
      [],
    );
    assert.equal(stopped.length, 2);
    assert.equal(stopped[0].sandbox, "podman");
    assert.equal(stopped[1].sandbox, "off");
  });

  it("propagates container field in buildComsPeersPayload", () => {
    const payload = buildComsPeersPayload(
      [{ name: "box", purpose: "test", model: "m", color: "#ffffff", busy: false, queue_depth: 0, context_used_pct: 5, container: verifiedBoxContainer, staleCount: 0 }],
      { name: "main", project: "proj" },
    );
    assert.equal(payload.peers[0].container, verifiedBoxContainer);
  });
});

describe("Podman supervisor container ID lifecycle", () => {
  it("removes exited container by immutable containerId on natural podman wait exit", async () => {
    const tmpHome = makeTempDir("pi-sup-home-");
    const repoDir = makeTempDir("pi-sup-repo-");
    const binDir = makeTempDir("pi-sup-bin-");
    const comsDir = path.join(tmpHome, ".pi", "coms");
    const podmanLog = path.join(tmpHome, "podman-calls.log");
    initTempGitRepo(repoDir);

    const fakeCid = "deadbeef".repeat(8);
    const fakePodman = path.join(binDir, "podman");
    fs.writeFileSync(
      fakePodman,
      `#!/usr/bin/env bash
echo "$@" >> "${podmanLog}"
if [ "$1" = "run" ]; then
  echo "${fakeCid}"
  exit 0
fi
if [ "$1" = "inspect" ]; then
  echo "$$"
  exit 0
fi
if [ "$1" = "wait" ]; then
  echo "0"
  exit 0
fi
exit 0
`,
      { mode: 0o755 },
    );

    const supervisorScript = path.join(REPO_ROOT, "scripts", "coms-peer-supervisor.mjs");
    execFileSync(
      process.execPath,
      [supervisorScript, "exit-peer", "--project", "demo", "--cwd", repoDir, "--sandbox", "podman", "--image", "localhost/pi-peer:111122223333"],
      {
        env: { ...process.env, HOME: tmpHome, PI_COMS_DIR: comsDir, PATH: `${binDir}:${process.env.PATH}` },
        timeout: 15_000,
      },
    );

    const calls = fs.readFileSync(podmanLog, "utf8");
    assert.match(calls, new RegExp(`rm -f -- ${fakeCid}`));
    const state = JSON.parse(fs.readFileSync(path.join(comsDir, "peers", "exit-peer@demo.json"), "utf8"));
    assert.equal(state.exitCode, 0);
    assert.equal(state.containerId, fakeCid);
  });

  it("targets only its own containerId when an older supervisor receives SIGTERM after replacement", async () => {
    const tmpHome = makeTempDir("pi-sup-race-home-");
    const repoDir = makeTempDir("pi-sup-race-repo-");
    const binDir = makeTempDir("pi-sup-race-bin-");
    const comsDir = path.join(tmpHome, ".pi", "coms");
    const podmanLog = path.join(tmpHome, "podman-race.log");
    initTempGitRepo(repoDir);

    const oldCid = "1111111111111111111111111111111111111111111111111111111111111111";
    const fakePodman = path.join(binDir, "podman");
    fs.writeFileSync(
      fakePodman,
      `#!/usr/bin/env bash
echo "$@" >> "${podmanLog}"
if [ "$1" = "run" ]; then
  echo "${oldCid}"
  exit 0
fi
if [ "$1" = "inspect" ]; then
  echo "${process.pid}"
  exit 0
fi
if [ "$1" = "wait" ]; then
  sleep 30
  exit 0
fi
exit 0
`,
      { mode: 0o755 },
    );

    const { spawn } = await import("node:child_process");
    const supervisorScript = path.join(REPO_ROOT, "scripts", "coms-peer-supervisor.mjs");
    const child = spawn(
      process.execPath,
      [supervisorScript, "race-peer", "--project", "demo", "--cwd", repoDir, "--sandbox", "podman", "--image", "localhost/pi-peer:111122223333"],
      {
        env: { ...process.env, HOME: tmpHome, PI_COMS_DIR: comsDir, PATH: `${binDir}:${process.env.PATH}` },
        stdio: "ignore",
      },
    );

    const statePath = path.join(comsDir, "peers", "race-peer@demo.json");
    for (let i = 0; i < 40; i++) {
      if (fs.existsSync(statePath)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(fs.existsSync(statePath), true, "expected initial supervisor state file");

    // Simulate a replacement supervisor taking ownership of the state file
    const replacementRecord = { cname: "race-peer", project: "demo", pid: 999999, containerId: "222222222222" };
    fs.writeFileSync(statePath, JSON.stringify(replacementRecord, null, 2));

    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 10_000);
      child.once("exit", () => { clearTimeout(t); resolve(); });
    });

    const calls = fs.readFileSync(podmanLog, "utf8");
    // Older supervisor cleaned up ONLY its own oldCid, never invoked stop/rm on the reusable name after replacement
    assert.match(calls, new RegExp(`rm -f -- ${oldCid}`));
    const afterRecord = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(afterRecord.pid, 999999);
    assert.equal(afterRecord.containerId, "222222222222");
  });

  it("retries failed podman rm -f while recording cleanupError when exhausted", () => {
    const tmpHome = makeTempDir("pi-sup-failrm-home-");
    const repoDir = makeTempDir("pi-sup-failrm-repo-");
    const binDir = makeTempDir("pi-sup-failrm-bin-");
    const comsDir = path.join(tmpHome, ".pi", "coms");
    const podmanLog = path.join(tmpHome, "podman-failrm.log");
    initTempGitRepo(repoDir);

    const failCid = "cafebabe".repeat(8);
    const fakePodman = path.join(binDir, "podman");
    fs.writeFileSync(
      fakePodman,
      `#!/usr/bin/env bash
echo "$@" >> "${podmanLog}"
if [ "$1" = "run" ]; then
  echo "${failCid}"
  exit 0
fi
if [ "$1" = "inspect" ]; then
  echo "$$"
  exit 0
fi
if [ "$1" = "wait" ]; then
  echo "0"
  exit 0
fi
if [ "$1" = "rm" ]; then
  exit 1
fi
exit 0
`,
      { mode: 0o755 },
    );

    const supervisorScript = path.join(REPO_ROOT, "scripts", "coms-peer-supervisor.mjs");
    execFileSync(
      process.execPath,
      [supervisorScript, "failrm-peer", "--project", "demo", "--cwd", repoDir, "--sandbox", "podman", "--image", "localhost/pi-peer:111122223333"],
      {
        env: { ...process.env, HOME: tmpHome, PI_COMS_DIR: comsDir, PATH: `${binDir}:${process.env.PATH}` },
        timeout: 15_000,
      },
    );

    const calls = fs.readFileSync(podmanLog, "utf8").split(/\r?\n/).filter((l) => l.startsWith(`rm -f -- ${failCid}`));
    assert.equal(calls.length, 2, "expected bounded retry of failed podman rm -f");
    const state = JSON.parse(fs.readFileSync(path.join(comsDir, "peers", "failrm-peer@demo.json"), "utf8"));
    assert.ok(typeof state.cleanupError === "string" && state.cleanupError.length > 0);
  });
});

describe("CLI symlink entrypoint detection", () => {
  it("recognizes symlinked invocation paths in isCliEntrypoint", () => {
    const tmpDir = makeTempDir("pi-cli-symlink-");
    const realScript = path.join(REPO_ROOT, "scripts", "podman-peer-image.mjs");
    const linkedScript = path.join(tmpDir, "podman-peer-image-link.mjs");
    fs.symlinkSync(realScript, linkedScript);
    assert.equal(isCliEntrypoint(linkedScript, `file://${realScript}`), true);
  });

  it("executes the build CLI handler when invoked through a symlinked directory", () => {
    const tmpDir = makeTempDir("pi-cli-dir-link-");
    const linkedRepo = path.join(tmpDir, "linked-repo");
    fs.symlinkSync(REPO_ROOT, linkedRepo);
    const linkedScript = path.join(linkedRepo, "scripts", "podman-peer-image.mjs");
    const statusPath = path.join(tmpDir, "status.json");
    const lockPath = path.join(tmpDir, "build.lock");
    const logPath = path.join(tmpDir, "build.log");
    let exitCode = 0;
    try {
      // Passing invalid floating :latest base image forces an immediate worker error (exit 1)
      // ONLY if the symlinked CLI entrypoint actually executed instead of silently no-oping (exit 0).
      execFileSync(
        process.execPath,
        [
          linkedScript,
          "build",
          "--base-image", "registry.fedoraproject.org/fedora:latest",
          "--pi-version", "1.7.0",
          "--lock-path", lockPath,
          "--status-path", statusPath,
          "--log-path", logPath,
        ],
        { stdio: "ignore", timeout: 10_000 },
      );
    } catch (err: any) {
      exitCode = err?.status ?? 1;
    }
    assert.notEqual(exitCode, 0, "symlinked CLI invocation must execute build handler instead of silently exiting 0");
  });
});
