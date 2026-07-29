import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("message boundary separator", () => {
  /**
   * Simulate the concatenation + post-processing logic from sessions.ts prompt().
   * Records boundary positions during streaming, then inserts \n\n only for non-JSON.
   */
  function concatenateDeltas(events: Array<{ message: object; delta: string }>): string {
    let responseText = "";
    let lastAssistantMessage: object | null = null;
    const messageBoundaries: number[] = [];
    // In tests, we use object identity to signal new messages (same as message_start in prod).
    // Each distinct object = a new logical assistant message.

    for (const event of events) {
      if (lastAssistantMessage !== null && event.message !== lastAssistantMessage && responseText.length > 0) {
        const lastBoundary = messageBoundaries.length > 0 ? messageBoundaries[messageBoundaries.length - 1] : -1;
        if (responseText.length !== lastBoundary) {
          messageBoundaries.push(responseText.length);
        }
      }
      lastAssistantMessage = event.message;
      responseText += event.delta;
    }

    // Post-process: insert \n\n only for non-JSON responses
    if (messageBoundaries.length > 0 && responseText.length > 0) {
      const trimmed = responseText.trim();
      const looksLikeJson = (trimmed.charCodeAt(0) === 123 && trimmed.charCodeAt(trimmed.length - 1) === 125) ||
                            (trimmed.charCodeAt(0) === 91 && trimmed.charCodeAt(trimmed.length - 1) === 93);
      let isJson = false;
      if (looksLikeJson) {
        try {
          JSON.parse(responseText);
          isJson = true;
        } catch {
          // Not valid JSON
        }
      }
      if (!isJson) {
        // Find JSON regions (forward scan, skip strings)
        const jsonRegions: Array<[number, number]> = [];
        let inStr2 = false, esc2 = false;
        for (let si = 0; si < responseText.length; si++) {
          const c = responseText.charCodeAt(si);
          if (esc2) { esc2 = false; continue; }
          if (c === 92) { esc2 = true; continue; }
          if (c === 34) { inStr2 = !inStr2; continue; }
          if (inStr2) continue;
          if (c === 123 || c === 91) {
            const close = c === 123 ? 125 : 93;
            let depth = 1, s2 = false, e2 = false;
            let ei = si + 1;
            for (; ei < responseText.length && depth > 0; ei++) {
              const ch = responseText.charCodeAt(ei);
              if (e2) { e2 = false; continue; }
              if (ch === 92) { e2 = true; continue; }
              if (ch === 34) { s2 = !s2; continue; }
              if (s2) continue;
              if (ch === c) depth++;
              else if (ch === close) depth--;
            }
            if (depth === 0) {
              const hasB = messageBoundaries.some(b => b > si && b < ei);
              if (hasB) {
                try {
                  JSON.parse(responseText.slice(si, ei));
                  jsonRegions.push([si, ei]);
                  si = ei - 1;
                } catch {
                  // Not valid JSON — don't skip, inner regions may be valid
                }
              } else {
                si = ei - 1;
              }
            }
          }
        }

        const parts: string[] = [];
        let prev = 0;
        for (const pos of messageBoundaries) {
          const inside = jsonRegions.some(([s, e]) => pos > s && pos < e);
          if (!inside) {
            parts.push(responseText.slice(prev, pos));
            prev = pos;
          }
        }
        parts.push(responseText.slice(prev));
        responseText = parts.join("\n\n");
      }
    }
    return responseText;
  }

  // ===== TEXT RESPONSES (separators inserted) =====

  it("single text message — no separator", () => {
    const msg = {};
    const result = concatenateDeltas([
      { message: msg, delta: "Hello " },
      { message: msg, delta: "world" },
    ]);
    assert.equal(result, "Hello world");
  });

  it("two text messages — separator inserted", () => {
    const msg1 = {};
    const msg2 = {};
    const result = concatenateDeltas([
      { message: msg1, delta: "First part." },
      { message: msg2, delta: "Second part." },
    ]);
    assert.equal(result, "First part.\n\nSecond part.");
  });

  it("three text messages — two separators", () => {
    const msg1 = {};
    const msg2 = {};
    const msg3 = {};
    const result = concatenateDeltas([
      { message: msg1, delta: "A." },
      { message: msg2, delta: "B." },
      { message: msg3, delta: "C." },
    ]);
    assert.equal(result, "A.\n\nB.\n\nC.");
  });

  it("same message reference reused — no separator", () => {
    const msg = {};
    const result = concatenateDeltas([
      { message: msg, delta: "chunk1 " },
      { message: msg, delta: "chunk2 " },
      { message: msg, delta: "chunk3" },
    ]);
    assert.equal(result, "chunk1 chunk2 chunk3");
  });

  it("text with braces in middle — separator inserted", () => {
    const msg1 = {};
    const msg2 = {};
    const result = concatenateDeltas([
      { message: msg1, delta: "Here is a result." },
      { message: msg2, delta: "It has {braces} in it." },
    ]);
    assert.equal(result, "Here is a result.\n\nIt has {braces} in it.");
  });

  it("malformed JSON with braces — separator inserted", () => {
    const msg1 = {};
    const msg2 = {};
    const result = concatenateDeltas([
      { message: msg1, delta: "{invalid" },
      { message: msg2, delta: " json}" },
    ]);
    assert.equal(result, "{invalid\n\n json}");
  });

  it("text starting with [ but not JSON — separator inserted", () => {
    const msg1 = {};
    const msg2 = {};
    const result = concatenateDeltas([
      { message: msg1, delta: "[INFO] Starting process." },
      { message: msg2, delta: "Process complete." },
    ]);
    assert.equal(result, "[INFO] Starting process.\n\nProcess complete.");
  });

  it("markdown with JSON fence — separator inserted (not valid JSON)", () => {
    const msg1 = {};
    const msg2 = {};
    const result = concatenateDeltas([
      { message: msg1, delta: '```json\n{"key": "value"}\n```' },
      { message: msg2, delta: "Here is the explanation." },
    ]);
    assert.equal(result, '```json\n{"key": "value"}\n```\n\nHere is the explanation.');
  });

  it("text with square brackets wrapping — separator inserted (not valid JSON array)", () => {
    const msg1 = {};
    const msg2 = {};
    const result = concatenateDeltas([
      { message: msg1, delta: "[note: this is" },
      { message: msg2, delta: " not json]" },
    ]);
    assert.equal(result, "[note: this is\n\n not json]");
  });

  // ===== JSON RESPONSES (no separators) =====

  it("JSON object — no separator inserted", () => {
    const msg1 = {};
    const msg2 = {};
    const result = concatenateDeltas([
      { message: msg1, delta: '{"project_' },
      { message: msg2, delta: 'name": "test"}' },
    ]);
    assert.equal(result, '{"project_name": "test"}');
    // Verify it's actually valid JSON
    assert.doesNotThrow(() => JSON.parse(result));
  });

  it("JSON array — no separator inserted", () => {
    const msg1 = {};
    const msg2 = {};
    const result = concatenateDeltas([
      { message: msg1, delta: '[{"id":' },
      { message: msg2, delta: ' 1}]' },
    ]);
    assert.equal(result, '[{"id": 1}]');
    assert.doesNotThrow(() => JSON.parse(result));
  });

  it("JSON with leading/trailing whitespace — no separator inserted", () => {
    const msg1 = {};
    const msg2 = {};
    const result = concatenateDeltas([
      { message: msg1, delta: '  {"key":' },
      { message: msg2, delta: ' "value"}  ' },
    ]);
    assert.equal(result, '  {"key": "value"}  ');
    assert.doesNotThrow(() => JSON.parse(result));
  });

  it("nested JSON object — no separator inserted", () => {
    const msg1 = {};
    const msg2 = {};
    const msg3 = {};
    const result = concatenateDeltas([
      { message: msg1, delta: '{"nav": [{"group":' },
      { message: msg2, delta: ' "Overview", "pages":' },
      { message: msg3, delta: ' []}]}' },
    ]);
    assert.equal(result, '{"nav": [{"group": "Overview", "pages": []}]}');
    assert.doesNotThrow(() => JSON.parse(result));
  });

  it("empty JSON object — no separator inserted", () => {
    const msg1 = {};
    const msg2 = {};
    const result = concatenateDeltas([
      { message: msg1, delta: "{" },
      { message: msg2, delta: "}" },
    ]);
    assert.equal(result, "{}");
    assert.doesNotThrow(() => JSON.parse(result));
  });

  it("JSON array of strings — no separator inserted", () => {
    const msg1 = {};
    const msg2 = {};
    const result = concatenateDeltas([
      { message: msg1, delta: '["hello",' },
      { message: msg2, delta: ' "world"]' },
    ]);
    assert.equal(result, '["hello", "world"]');
    assert.doesNotThrow(() => JSON.parse(result));
  });

  it("JSON with newlines inside — no separator inserted", () => {
    const msg1 = {};
    const msg2 = {};
    const result = concatenateDeltas([
      { message: msg1, delta: '{\n  "key":' },
      { message: msg2, delta: ' "value"\n}' },
    ]);
    assert.equal(result, '{\n  "key": "value"\n}');
    assert.doesNotThrow(() => JSON.parse(result));
  });

  // ===== EDGE CASES =====

  it("single-message JSON — no boundaries, passes through unchanged", () => {
    const msg = {};
    const result = concatenateDeltas([
      { message: msg, delta: '{"name": "test", "version": "1.0.0"}' },
    ]);
    assert.equal(result, '{"name": "test", "version": "1.0.0"}');
    assert.doesNotThrow(() => JSON.parse(result));
  });

  it("empty response — no processing", () => {
    const result = concatenateDeltas([]);
    assert.equal(result, "");
  });

  it("no leading separator when first message has no prior text", () => {
    const msg = {};
    const result = concatenateDeltas([
      { message: msg, delta: "Only message" },
    ]);
    assert.equal(result, "Only message");
  });

  it("multi-chunk text with many boundaries — all separators inserted", () => {
    const msgs = [{}, {}, {}, {}, {}];
    const result = concatenateDeltas([
      { message: msgs[0], delta: "One." },
      { message: msgs[1], delta: "Two." },
      { message: msgs[2], delta: "Three." },
      { message: msgs[3], delta: "Four." },
      { message: msgs[4], delta: "Five." },
    ]);
    assert.equal(result, "One.\n\nTwo.\n\nThree.\n\nFour.\n\nFive.");
  });

  // ===== PROSE + JSON (boundary must not corrupt JSON) =====

  it("prose preamble then JSON — \\n\\n must not corrupt JSON content", () => {
    const msg1 = {};
    const msg2 = {};
    const msg3 = {};
    // AI reads files (msg1), writes preamble (msg2), then outputs JSON (msg3)
    const result = concatenateDeltas([
      { message: msg1, delta: "I'll explore the repo." },
      { message: msg2, delta: 'Here is the plan: ' },
      { message: msg3, delta: '{"project_name": "docsfy", "pages": ["overview"]}' },
    ]);
    // The JSON portion must remain parseable
    const jsonMatch = result.match(/\{.*\}/s);
    assert.ok(jsonMatch, "should contain a JSON object");
    assert.doesNotThrow(() => JSON.parse(jsonMatch![0]), "JSON inside response must be valid");
  });

  it("prose + JSON with boundary mid-JSON-key — must not split key", () => {
    const msg1 = {};
    const msg2 = {};
    // Boundary falls inside a JSON key: {"project_ | name": ...}
    const result = concatenateDeltas([
      { message: msg1, delta: '{"project_' },
      { message: msg2, delta: 'name": "test"}' },
    ]);
    // This is pure JSON — must not be corrupted
    assert.doesNotThrow(() => JSON.parse(result), "JSON must remain valid");
    assert.ok(!result.includes('\n\n'), "no \\n\\n should be inside JSON");
  });

  it("multi-tool response: prose then JSON plan (docsfy scenario)", () => {
    const msg1 = {};
    const msg2 = {};
    const msg3 = {};
    const msg4 = {};
    const jsonPlan = '{"project_name": "pi-sidecar", "navigation": [{"group": "Overview", "pages": [{"slug": "intro"}]}]}';
    const result = concatenateDeltas([
      { message: msg1, delta: "Let me analyze the codebase." },
      { message: msg2, delta: "I've read the main files." },
      { message: msg3, delta: "Here is the documentation plan:\n" },
      { message: msg4, delta: jsonPlan },
    ]);
    // Extract JSON from the response and verify it's valid
    const jsonMatch = result.match(/\{.*\}/s);
    assert.ok(jsonMatch, "should contain JSON");
    assert.doesNotThrow(() => JSON.parse(jsonMatch![0]), "JSON plan must be parseable");
    // Verify the JSON content is intact
    const parsed = JSON.parse(jsonMatch![0]);
    assert.equal(parsed.project_name, "pi-sidecar");
  });

  it("boundary splits JSON key mid-word across messages (docsfy real bug)", () => {
    // Real scenario: AI streams JSON across messages, boundary falls mid-token
    // msg1 ends with '{"project_' and msg2 starts with 'name": "docsfy"}'
    // With prose before JSON, the whole response doesn't start with { so
    // looksLikeJson is false, and \n\n gets injected at the boundary
    const msg1 = {};
    const msg2 = {};
    const msg3 = {};
    const result = concatenateDeltas([
      { message: msg1, delta: "Here is the plan: " },
      { message: msg2, delta: '{"project_' },
      { message: msg3, delta: 'name": "docsfy", "pages": ["overview"]}' },
    ]);
    // The JSON must NOT have \n\n injected inside it
    const jsonMatch = result.match(/\{.*\}/s);
    assert.ok(jsonMatch, "should contain JSON");
    assert.doesNotThrow(() => JSON.parse(jsonMatch![0]),
      `JSON must be valid, got: ${jsonMatch![0]}`);
  });

  it("boundary inside JSON value mid-word (corrupts string content)", () => {
    // Boundary falls inside a JSON string value: "do | csfy"
    const msg1 = {};
    const msg2 = {};
    const result = concatenateDeltas([
      { message: msg1, delta: '{"name": "do' },
      { message: msg2, delta: 'csfy"}' },
    ]);
    // Pure JSON — should not be corrupted
    assert.doesNotThrow(() => JSON.parse(result), `JSON must be valid, got: ${result}`);
    const parsed = JSON.parse(result);
    assert.equal(parsed.name, "docsfy", "value must not be split");
  });
});
