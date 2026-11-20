import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { escapeRegExp, sanitizeModelId } from "../../../extensions/orchestrator/utils.js";
import { matchHeredocOpener, skipHeredocBody } from "../../../extensions/orchestrator/git-helpers.js";

describe("orchestrator utils helpers (#1233)", () => {
  it("escapeRegExp escapes all RegExp metacharacters", () => {
    const raw = "a.b+c*d?^e$f(g)h[i]j{k}|l\\m";
    const escaped = escapeRegExp(raw);
    const re = new RegExp(`^${escaped}$`);
    assert.equal(re.test(raw), true);
    assert.equal(re.test("axb"), false);
    assert.equal(escapeRegExp(""), "");
  });

  it("sanitizeModelId preserves valid IDs while stripping unsafe characters", () => {
    assert.equal(sanitizeModelId("  anthropic/claude-opus-4-6:latest  "), "anthropic/claude-opus-4-6:latest");
    assert.equal(sanitizeModelId("gpt-5;rm -rf /$(id)"), "gpt-5rm -rf /id");
    assert.equal(sanitizeModelId(null), "");
    assert.equal(sanitizeModelId("   "), "");
  });
});

describe("shared heredoc scanner helpers (#1233)", () => {
  it("matchHeredocOpener parses quoted, unquoted, and strip-tab delimiters", () => {
    assert.deepEqual(matchHeredocOpener("<<EOF\nhello\nEOF", "executable"), {
      delim: "EOF",
      expand: true,
      stripTabs: false,
      length: 5,
    });
    assert.deepEqual(matchHeredocOpener("<<-'END_TAG' ignored\n", "comments"), {
      delim: "END_TAG",
      expand: false,
      stripTabs: true,
      length: 12,
    });
    assert.deepEqual(matchHeredocOpener("<<\\EOF\n", "comments"), {
      delim: "EOF",
      expand: true,
      stripTabs: false,
      length: 6,
    });
  });

  it("matchHeredocOpener preserves grammar differences for <<EOF>out.txt and <<\\nEOF", () => {
    assert.equal(matchHeredocOpener("<<EOF>out.txt\n", "executable")?.delim, "EOF>out.txt");
    assert.equal(matchHeredocOpener("<<EOF>out.txt\n", "piped-commit")?.delim, "EOF");
    assert.equal(matchHeredocOpener("<<\nEOF\n", "executable")?.delim, "EOF");
    assert.equal(matchHeredocOpener("<<\nEOF\n", "piped-commit"), null);
    assert.equal(matchHeredocOpener("<<\nEOF\n", "comments"), null);
  });

  it("skipHeredocBody consumes multiple heredocs and strips tabs for <<-", () => {
    const cmd = "cat <<A <<-'B'\nline1\nA\n\t\tline2\n\tB\necho after";
    const start = cmd.indexOf("\n") + 1;
    const collected: Array<{ line: string; index: number }> = [];
    const res = skipHeredocBody(
      cmd,
      start,
      [
        { delim: "A", stripTabs: false },
        { delim: "B", stripTabs: true },
      ],
      {
        stripCr: true,
        onBodyLine: (line, index) => collected.push({ line, index }),
      },
    );
    assert.equal(res.closed, true);
    assert.equal(cmd.slice(res.next), "echo after");
    assert.deepEqual(collected, [
      { line: "line1", index: 0 },
      { line: "\t\tline2", index: 1 },
    ]);
  });

  it("skipHeredocBody reports unclosed heredocs at EOF", () => {
    const cmd = "cat <<EOF\nnever closed";
    const start = cmd.indexOf("\n") + 1;
    const res = skipHeredocBody(cmd, start, [{ delim: "EOF", stripTabs: false }]);
    assert.equal(res.closed, false);
    assert.equal(res.next, cmd.length);
  });
});
