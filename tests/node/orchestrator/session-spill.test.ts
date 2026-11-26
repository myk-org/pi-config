/**
 * Unit tests for session JSONL spill & content-addressed blob externalization (issue #1420).
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  clearSettingsCache,
  SETTINGS_KEYS,
} from "../../../extensions/orchestrator/project-settings.js";
import {
  extractSpillCountsFromText,
  extractSpillPathFromDetails,
  extractSpillPathFromText,
  formatSpillPreview,
  mimeToExt,
  registerSessionSpill,
  resolveSessionSpillDir,
  writeContentBlob,
  writeSessionSpill,
} from "../../../extensions/orchestrator/session-spill.js";
import type { Logger } from "../../../extensions/shared/logger.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

type Handler = (...args: any[]) => any;

interface RecordedLog {
  level: "debug" | "info" | "warn" | "error";
  args: any[];
}

function createFakeLogger(): { logger: Logger; entries: RecordedLog[] } {
  const entries: RecordedLog[] = [];
  const logger: Logger = {
    debug: (...args: any[]) => entries.push({ level: "debug", args }),
    info: (...args: any[]) => entries.push({ level: "info", args }),
    warn: (...args: any[]) => entries.push({ level: "warn", args }),
    error: (...args: any[]) => entries.push({ level: "error", args }),
    isDebugEnabled: () => true,
  };
  return { logger, entries };
}

function createHarness(opts?: { blobDir?: string; imageThresholdBytes?: number; logger?: Logger }) {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  } as any;

  registerSessionSpill(pi, {
    blobDir: opts?.blobDir,
    imageThresholdBytes: opts?.imageThresholdBytes,
    log: opts?.logger,
  });

  function emit(event: string, payload: any, ctx?: any): any {
    let last: any;
    for (const handler of handlers.get(event) ?? []) {
      last = handler(payload, ctx);
    }
    return last;
  }

  return { emit };
}

function writeProjectSettings(cwd: string, settings: Record<string, unknown>): void {
  const piDir = path.join(cwd, ".pi");
  fs.mkdirSync(piDir, { recursive: true });
  fs.writeFileSync(path.join(piDir, "pi-config-settings.json"), JSON.stringify(settings), "utf-8");
  clearSettingsCache();
}

const ENV_VARS = [
  "PI_SESSION_SPILL_ENABLED",
  "PI_SESSION_SPILL_THRESHOLD_CHARS",
  "PI_SESSION_BLOB_EXTERNALIZE",
];
const savedEnv = new Map<string, string | undefined>();
for (const key of ENV_VARS) savedEnv.set(key, process.env[key]);

afterEach(() => {
  for (const key of ENV_VARS) {
    const val = savedEnv.get(key);
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
  clearSettingsCache();
});

describe("session-spill (#1420)", () => {
  it("declares spill and blob settings in settings-keys.json with expected defaults", () => {
    assert.equal(SETTINGS_KEYS.session_spill_enabled?.default, true);
    assert.equal(SETTINGS_KEYS.session_spill_threshold_chars?.default, 50000);
    assert.equal(SETTINGS_KEYS.session_blob_externalize?.default, true);
    assert.equal(SETTINGS_KEYS.session_spill_enabled?.group, "Session");
  });

  it("resolves session-scoped spill dir next to .jsonl and falls back to .pi/tmp for --no-session", () => {
    const work = makeTempDir("spill-dir-");
    const sessionFile = path.join(work, "sessions", "abc-123.jsonl");

    const persistent = resolveSessionSpillDir({ sessionFile, sessionId: "abc-123", cwd: work });
    assert.equal(persistent.persistent, true);
    assert.equal(persistent.dir, path.join(work, "sessions", "abc-123", "local"));

    const ephemeral = resolveSessionSpillDir({ sessionFile: undefined, sessionId: "../escape/id", cwd: work });
    assert.equal(ephemeral.persistent, false);
    assert.equal(ephemeral.dir, path.join(work, ".pi", "tmp", "session-local", "___escape_id"));
  });

  it("writes sequential atomic spill files without clobbering pre-existing IDs or leaving temp files", () => {
    const dir = path.join(makeTempDir("spill-write-"), "local");
    fs.mkdirSync(dir, { recursive: true });
    // Simulate a pre-existing 1.log from an earlier run or concurrent writer.
    fs.writeFileSync(path.join(dir, "1.log"), "pre-existing", "utf-8");

    const first = writeSessionSpill("payload-A\nline-2", dir);
    const second = writeSessionSpill("payload-B", dir);

    assert.equal(path.basename(first.path), "2.log");
    assert.equal(path.basename(second.path), "3.log");
    assert.equal(fs.readFileSync(path.join(dir, "1.log"), "utf-8"), "pre-existing");
    assert.equal(fs.readFileSync(first.path, "utf-8"), "payload-A\nline-2");
    assert.equal(first.lines, 2);
    assert.equal(fs.readFileSync(second.path, "utf-8"), "payload-B");

    const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  });

  it("formats bounded head/tail previews that round-trip spill path and counts", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line-${i}: ${"x".repeat(30)}`);
    const payload = lines.join("\n");
    const spillPath = "/tmp/example-session/local/7.log";

    const preview = formatSpillPreview(payload, spillPath, 1500);
    assert.ok(preview.length < payload.length, "preview must be strictly shorter than original");
    assert.ok(preview.includes("line-0:"), "preview must include head");
    assert.ok(preview.includes("line-199:"), "preview must include tail");
    assert.equal(extractSpillPathFromText(preview), spillPath);
    assert.deepEqual(extractSpillCountsFromText(preview), { chars: payload.length, lines: 200 });
  });

  it("deduplicates content-addressed blobs by SHA-256 and creates typed sidecars for known MIME types", () => {
    const blobDir = makeTempDir("blob-store-");
    const pngBytes = Buffer.from("fake-png-binary-payload-1234567890");
    const expectedHash = createHash("sha256").update(pngBytes).digest("hex");

    const first = writeContentBlob(pngBytes, "image/png; charset=binary", blobDir);
    assert.equal(first.sha256, expectedHash);
    assert.equal(first.deduplicated, false);
    assert.equal(first.blobPath, path.join(blobDir, expectedHash));
    assert.equal(first.sidecarPath, path.join(blobDir, `${expectedHash}.png`));
    assert.deepEqual(fs.readFileSync(first.blobPath), pngBytes);
    assert.deepEqual(fs.readFileSync(first.sidecarPath!), pngBytes);

    // Second write of identical bytes deduplicates cleanly.
    const second = writeContentBlob(pngBytes, "image/png", blobDir);
    assert.equal(second.deduplicated, true);
    assert.equal(second.sha256, expectedHash);
    assert.equal(second.sidecarPath, first.sidecarPath);

    // Unknown MIME creates only the bare hash blob (no sidecar).
    const rawBytes = Buffer.from("opaque-binary-data");
    const unknown = writeContentBlob(rawBytes, "application/x-custom-bin", blobDir);
    assert.equal(unknown.sidecarPath, null);
    assert.equal(fs.existsSync(unknown.blobPath), true);
    assert.equal(mimeToExt("image/jpeg"), ".jpg");
    assert.equal(mimeToExt("application/octet-stream"), null);
  });

  it("spills text above threshold in tool_result, clears structuredContent, and skips below threshold", () => {
    const cwd = makeTempDir("spill-hook-");
    const sessionFile = path.join(cwd, "sess.jsonl");
    writeProjectSettings(cwd, {
      session_spill_enabled: true,
      session_spill_threshold_chars: 1200,
    });
    const { logger } = createFakeLogger();
    const { emit } = createHarness({ blobDir: makeTempDir("spill-hook-blobs-"), logger });
    const ctx = {
      cwd,
      sessionManager: {
        getSessionId: () => "sess-1",
        getSessionFile: () => sessionFile,
      },
    };

    // Below threshold: complete no-op (preserves structuredContent untouched).
    const smallResult = emit(
      "tool_result",
      {
        type: "tool_result",
        toolName: "bash",
        toolCallId: "tc-small",
        input: {},
        content: [{ type: "text", text: "short output" }],
        details: { exitCode: 0 },
        structuredContent: { ok: true },
        isError: false,
      },
      ctx,
    );
    assert.equal(smallResult, undefined);

    // Above threshold: spills full text to <session-dir>/local/1.log and omits structuredContent.
    const bigPayload = Array.from({ length: 120 }, (_, i) => `row-${i} ${"A".repeat(25)}`).join("\n");
    const bigResult = emit(
      "tool_result",
      {
        type: "tool_result",
        toolName: "bash",
        toolCallId: "tc-big",
        input: {},
        content: [{ type: "text", text: bigPayload }],
        details: { exitCode: 0 },
        structuredContent: { raw: bigPayload },
        isError: false,
      },
      ctx,
    );

    assert.ok(bigResult, "expected modified tool_result patch");
    assert.equal("structuredContent" in bigResult, false, "must omit structuredContent when content changes");
    assert.equal(bigResult.content.length, 1);
    assert.equal(bigResult.content[0].type, "text");
    assert.ok(bigResult.content[0].text.length < bigPayload.length);
    assert.equal(bigResult.details.exitCode, 0, "existing details fields must be preserved");

    const spillPath = extractSpillPathFromDetails(bigResult.details, 0);
    assert.ok(spillPath, "spill path must be recorded in details");
    assert.equal(spillPath, path.join(cwd, "sess", "local", "1.log"));
    assert.equal(extractSpillPathFromText(bigResult.content[0].text), spillPath);
    assert.equal(fs.readFileSync(spillPath, "utf-8"), bigPayload);
  });

  it("externalizes oversized and repeated images to blob store while keeping normal first-time images inline", () => {
    const cwd = makeTempDir("blob-hook-");
    const blobDir = makeTempDir("blob-hook-store-");
    writeProjectSettings(cwd, {
      session_spill_enabled: true,
      session_blob_externalize: true,
    });
    const { logger } = createFakeLogger();
    const { emit } = createHarness({ blobDir, imageThresholdBytes: 64, logger });
    const ctx = {
      cwd,
      sessionManager: {
        getSessionId: () => "sess-img",
        getSessionFile: () => undefined, // also exercises --no-session path
      },
    };

    const smallImgBytes = Buffer.from("small-png-32-bytes-0123456789abc");
    const smallImgB64 = smallImgBytes.toString("base64");

    // 1. First-time small image: stays inline so the model can view it.
    const firstSmall = emit(
      "tool_result",
      {
        type: "tool_result",
        toolName: "read",
        toolCallId: "tc-img-1",
        input: {},
        content: [{ type: "image", data: smallImgB64, mimeType: "image/png" }],
        details: {},
        isError: false,
      },
      ctx,
    );
    assert.equal(firstSmall, undefined);

    // 2. Repeated identical image in the same session: externalized & deduplicated.
    const secondSmall = emit(
      "tool_result",
      {
        type: "tool_result",
        toolName: "read",
        toolCallId: "tc-img-2",
        input: {},
        content: [{ type: "image", data: smallImgB64, mimeType: "image/png" }],
        details: {},
        structuredContent: { image: true },
        isError: false,
      },
      ctx,
    );
    assert.ok(secondSmall);
    assert.equal("structuredContent" in secondSmall, false);
    assert.equal(secondSmall.content[0].type, "text");
    assert.match(secondSmall.content[0].text, /image externalized \(duplicate\)/);
    assert.equal(secondSmall.details.__piExternalizedBlobs.length, 1);
    const dupBlob = secondSmall.details.__piExternalizedBlobs[0];
    assert.equal(dupBlob.reason, "duplicate");
    assert.ok(dupBlob.sidecarPath?.endsWith(".png"));
    assert.deepEqual(fs.readFileSync(dupBlob.sidecarPath), smallImgBytes);

    // 3. Oversized image on first sight (> 64 bytes threshold): immediately externalized.
    const largeImgBytes = Buffer.alloc(128, 0x42);
    const largeRes = emit(
      "tool_result",
      {
        type: "tool_result",
        toolName: "screenshot",
        toolCallId: "tc-img-3",
        input: {},
        content: [{ type: "image", data: largeImgBytes.toString("base64"), mimeType: "image/webp" }],
        details: undefined,
        isError: false,
      },
      ctx,
    );
    assert.ok(largeRes);
    assert.equal(largeRes.content[0].type, "text");
    assert.match(largeRes.content[0].text, /image externalized \(oversized\)/);
    assert.ok(largeRes.details.__piExternalizedBlobs[0].sidecarPath?.endsWith(".webp"));
    assert.deepEqual(fs.readFileSync(largeRes.details.__piExternalizedBlobs[0].blobPath), largeImgBytes);

    // 4. Session reset clears seen image hashes so small image is inline again in a fresh session.
    emit("session_start", { reason: "new" }, ctx);
    const afterReset = emit(
      "tool_result",
      {
        type: "tool_result",
        toolName: "read",
        toolCallId: "tc-img-4",
        input: {},
        content: [{ type: "image", data: smallImgB64, mimeType: "image/png" }],
        details: {},
        isError: false,
      },
      ctx,
    );
    assert.equal(afterReset, undefined);
  });

  it("respects session_spill_enabled=false and session_blob_externalize=false settings", () => {
    const cwd = makeTempDir("spill-disabled-");
    writeProjectSettings(cwd, {
      session_spill_enabled: false,
      session_spill_threshold_chars: 1000,
      session_blob_externalize: false,
    });
    const { emit } = createHarness({ blobDir: makeTempDir("spill-disabled-blobs-"), imageThresholdBytes: 10 });
    const ctx = {
      cwd,
      sessionManager: { getSessionId: () => "s-off", getSessionFile: () => undefined },
    };

    const res = emit(
      "tool_result",
      {
        type: "tool_result",
        toolName: "bash",
        toolCallId: "tc-off",
        input: {},
        content: [
          { type: "text", text: "Z".repeat(5000) },
          { type: "image", data: Buffer.alloc(64, 1).toString("base64"), mimeType: "image/png" },
        ],
        details: {},
        isError: false,
      },
      ctx,
    );
    assert.equal(res, undefined);
  });

  it("preserves original content and logs warning when spill write fails on disk", () => {
    const cwd = makeTempDir("spill-fail-");
    // Place a regular file where the spill directory would be created so mkdirSync fails with EEXIST/ENOTDIR.
    const blockingFile = path.join(cwd, "blocked-session");
    fs.writeFileSync(blockingFile, "not a dir", "utf-8");
    const sessionFile = `${blockingFile}.jsonl`;

    writeProjectSettings(cwd, {
      session_spill_enabled: true,
      session_spill_threshold_chars: 1000,
    });
    const { logger, entries } = createFakeLogger();
    const { emit } = createHarness({ blobDir: makeTempDir("spill-fail-blobs-"), logger });
    const ctx = {
      cwd,
      sessionManager: { getSessionId: () => "s-fail", getSessionFile: () => sessionFile },
    };

    const res = emit(
      "tool_result",
      {
        type: "tool_result",
        toolName: "bash",
        toolCallId: "tc-fail",
        input: {},
        content: [{ type: "text", text: "X".repeat(3000) }],
        details: {},
        isError: false,
      },
      ctx,
    );
    assert.equal(res, undefined, "must not drop content when spill write fails");
    assert.ok(entries.some((e) => e.level === "warn" && e.args[0] === "session_spill_write_failed"));
  });
});
