/**
 * Inbound attachments are copied into the workspace so the agent can use its own
 * file tools on what a phone sent. The path rules matter: a filename from
 * Discord is attacker-controlled.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, readdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { saveInboundAttachment } from "../../../extensions/shared/chat/chat-attachments.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "discord-inbox-"));
}

describe("saving an inbound attachment", () => {
  it("writes the file and returns its path", () => {
    const dir = join(tempDir(), "nested", "inbox");
    const saved = saveInboundAttachment(dir, "screenshot.png", Buffer.from("png-bytes"));
    assert.ok(saved);
    assert.equal(readFileSync(saved!, "utf-8"), "png-bytes");
  });

  it("keeps the name as a leaf inside the directory", () => {
    const dir = tempDir();
    const saved = saveInboundAttachment(dir, "shot.png", Buffer.from("x"));
    assert.equal(basename(saved!), "shot.png");
    assert.equal(readdirSync(dir).length, 1);
  });

  it("does not escape the directory", () => {
    const dir = tempDir();
    const saved = saveInboundAttachment(dir, "../../../etc/passwd", Buffer.from("x"));
    assert.ok(saved);
    assert.equal(basename(saved!), "_.._.._etc_passwd", "separators are flattened, leading dots stripped");
    assert.ok(saved!.startsWith(dir), "the write stays inside the inbox");
    assert.equal(existsSync("/etc/passwd"), true, "and nothing outside was touched");
  });

  it("never starts with a dot", () => {
    const dir = tempDir();
    const saved = saveInboundAttachment(dir, "...hidden.txt", Buffer.from("x"));
    assert.equal(basename(saved!).startsWith("."), false);
  });

  it("falls back to a name when the filename is empty", () => {
    const dir = tempDir();
    const saved = saveInboundAttachment(dir, "", Buffer.from("x"));
    assert.equal(basename(saved!), "attachment");
  });

  it("caps absurdly long names", () => {
    const dir = tempDir();
    const saved = saveInboundAttachment(dir, `${"a".repeat(400)}.png`, Buffer.from("x"));
    assert.ok(basename(saved!).length <= 120);
  });
});

describe("saved attachments are never reused or redirected", () => {
  it("keeps both files when the same name is sent twice", () => {
    const dir = tempDir();
    const first = saveInboundAttachment(dir, "photo.png", Buffer.from("one"));
    const second = saveInboundAttachment(dir, "photo.png", Buffer.from("two"));
    assert.notEqual(first, second, "a path handed to the agent must keep its bytes");
    assert.equal(readFileSync(first!, "utf-8"), "one");
    assert.equal(readFileSync(second!, "utf-8"), "two");
    assert.deepEqual(readdirSync(dir).sort(), ["photo-1.png", "photo.png"]);
  });

  it("does not follow an existing symlink out of the inbox", () => {
    const outside = join(tempDir(), "secret.txt");
    writeFileSync(outside, "original");
    const dir = tempDir();
    symlinkSync(outside, join(dir, "photo.png"));
    const saved = saveInboundAttachment(dir, "photo.png", Buffer.from("payload"));
    assert.ok(saved);
    assert.notEqual(saved, join(dir, "photo.png"));
    assert.equal(readFileSync(outside, "utf-8"), "original", "the link target was not truncated");
    assert.equal(readFileSync(saved!, "utf-8"), "payload");
  });
});
