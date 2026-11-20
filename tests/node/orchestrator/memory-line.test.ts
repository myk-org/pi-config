import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalTopicLine,
  findTopicLine,
  formatTopicLine,
  parseTopicLine,
  stripTopicMarkers,
} from "../../../extensions/orchestrator/memory-line.js";

describe("memory-line helpers (#1201)", () => {
  it("parses plain, pinned, enforced, and id-suffixed lines", () => {
    assert.deepEqual(parseTopicLine("- [lesson] Use uv run"), {
      category: "lesson",
      text: "Use uv run",
      pinned: false,
    });
    assert.deepEqual(parseTopicLine("- [preference] Prefer concise output *(pinned)*"), {
      category: "preference",
      text: "Prefer concise output",
      pinned: true,
    });
    assert.deepEqual(
      parseTopicLine("- [mistake] Never git add . *(pinned)* *(enforced)* {#deadbeef}   "),
      {
        category: "mistake",
        text: "Never git add .",
        pinned: true,
        id: "deadbeef",
      },
    );
  });

  it("handles duplicated or reordered markers", () => {
    assert.deepEqual(
      parseTopicLine("- [lesson] Stay sharp *(enforced)* *(pinned)* *(pinned)* {#0123abcd}"),
      {
        category: "lesson",
        text: "Stay sharp",
        pinned: true,
        id: "0123abcd",
      },
    );
    assert.equal(stripTopicMarkers("Stay sharp *(pinned)* *(enforced)* {#0123abcd}"), "Stay sharp");
  });

  it("returns null for headings, blanks, and invalid categories", () => {
    assert.equal(parseTopicLine("# Lessons"), null);
    assert.equal(parseTopicLine(""), null);
    assert.equal(parseTopicLine("- [unknown] Some text"), null);
  });

  it("formats and canonicalizes topic lines", () => {
    const entry = { category: "lesson" as const, text: "Check logs", pinned: true, id: "a1b2" };
    assert.equal(canonicalTopicLine(entry), "- [lesson] Check logs");
    assert.equal(formatTopicLine(entry, true), "- [lesson] Check logs *(pinned)* *(enforced)* {#a1b2}");
    assert.equal(formatTopicLine(entry, false), "- [lesson] Check logs *(pinned)* {#a1b2}");
  });

  it("findTopicLine matches regex metacharacters and marker variations", () => {
    const content = [
      "# Patterns",
      "",
      "- [pattern] Use foo[0] + bar.* (baz)? *(enforced)* *(pinned)* {#cafe1234}",
      "- [pattern] Other",
    ].join("\n");
    const found = findTopicLine(content, "pattern", "Use foo[0] + bar.* (baz)?");
    assert.deepEqual(found, {
      line: "- [pattern] Use foo[0] + bar.* (baz)? *(enforced)* *(pinned)* {#cafe1234}",
      index: 2,
      pinned: true,
      enforced: true,
      id: "cafe1234",
    });
    assert.equal(findTopicLine(content, "lesson", "Use foo[0] + bar.* (baz)?"), null);
    assert.equal(findTopicLine(content, "pattern", "Use foo[0]"), null);
  });
});
