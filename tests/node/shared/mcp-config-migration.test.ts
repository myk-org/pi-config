/**
 * MCP config migration (#848) — a pre-existing install must end up with its
 * servers where `builtin:mcp` reads them, or MCP silently stops working.
 * Run with: npx tsx --test tests/node/shared/mcp-config-migration.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateMcpConfig, mcpConfigPaths } from "../../../extensions/shared/mcp-config-migration.js";

let home: string;
let legacy: string;
let current: string;

const SERVERS = JSON.stringify({ mcpServers: { jira: { command: "npx", args: ["-y", "mcp-jira"] } } });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mcp-migrate-"));
  ({ legacy, current } = mcpConfigPaths(home));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeLegacy(contents = SERVERS): void {
  mkdirSync(join(home, ".pi", "pi-config"), { recursive: true });
  writeFileSync(legacy, contents);
}

describe("mcpConfigPaths", () => {
  it("maps the old mcpc location to the builtin:mcp one", () => {
    assert.equal(legacy, join(home, ".pi", "pi-config", "mcp.json"));
    assert.equal(current, join(home, ".pi", "agent", "mcp.json"));
  });
});

describe("migrateMcpConfig", () => {
  it("copies the legacy config so builtin:mcp can find it", () => {
    writeLegacy();
    const written = migrateMcpConfig(home);
    assert.equal(written, current);
    assert.equal(readFileSync(current, "utf8"), SERVERS);
  });

  it("leaves the original in place for the user to remove", () => {
    writeLegacy();
    migrateMcpConfig(home);
    assert.equal(existsSync(legacy), true);
  });

  it("never overwrites an existing ~/.pi/agent/mcp.json", () => {
    writeLegacy();
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    const mine = JSON.stringify({ mcpServers: { searxng: { url: "https://search.internal/mcp" } } });
    writeFileSync(current, mine);

    assert.equal(migrateMcpConfig(home), undefined);
    assert.equal(readFileSync(current, "utf8"), mine, "the user's own config must win");
  });

  it("does nothing when there is no legacy config", () => {
    assert.equal(migrateMcpConfig(home), undefined);
    assert.equal(existsSync(current), false, "must not create an empty file that would shadow nothing");
  });

  it("is idempotent", () => {
    writeLegacy();
    migrateMcpConfig(home);
    assert.equal(migrateMcpConfig(home), undefined, "second run is a no-op");
    assert.equal(readFileSync(current, "utf8"), SERVERS);
  });

  it("does not throw when the destination cannot be written", () => {
    writeLegacy();
    // A file where the .pi/agent directory should be makes mkdirSync fail.
    mkdirSync(join(home, ".pi"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent"), "not a directory");

    assert.doesNotThrow(() => migrateMcpConfig(home));
  });
});
