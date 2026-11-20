/**
 * `ask_user` options: the caller's list plus the TUI-only free-input row, nothing else.
 *
 * The discuss-first row (`__discuss__`) is gone — it consumed a slot in every select menu and the
 * tool never answers with it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  browserAskOptions,
  buildAskOptions,
  registerAskUser,
} from "../../../extensions/orchestrator/ask-user.js";
import { withSubagentChildEnv } from "../helpers/subagent-env.js";

const FREE_INPUT = "__free_input__";

describe("buildAskOptions", () => {
  it("appends only the free-input row after the caller's options", () => {
    const items = buildAskOptions(["Yes", "No"]);
    assert.deepStrictEqual(items.map((i) => i.value), ["Yes", "No", FREE_INPUT]);
  });

  it("never builds a discuss row", () => {
    for (const options of [["Yes"], ["a", "b", "c", "d"]]) {
      const items = buildAskOptions(options);
      assert.ok(!items.some((i) => /discuss/i.test(i.label) || /discuss/i.test(i.value)));
      assert.equal(items.length, options.length + 1);
    }
  });

  it("leaves free-input-only mode empty", () => {
    assert.deepStrictEqual(buildAskOptions(undefined), []);
    assert.deepStrictEqual(buildAskOptions([]), []);
  });
});

describe("browserAskOptions", () => {
  it("excludes the free-input control", () => {
    assert.deepStrictEqual(browserAskOptions(buildAskOptions(["Yes", "No"])), ["Yes", "No"]);
  });

  // Regression: the row used to be special-cased into a sentinel, so a caller who asked for it got
  // a value the tool never returned.
  it("passes a caller-supplied 'Discuss with AI first' option through as a plain option", () => {
    const items = buildAskOptions(["Yes", "Discuss with AI first", "No"]);
    assert.deepStrictEqual(items.map((i) => i.value), ["Yes", "Discuss with AI first", "No", FREE_INPUT]);
    assert.deepStrictEqual(
      browserAskOptions(items),
      ["Yes", "Discuss with AI first", "No"],
    );
  });
});

describe("ask_user result", () => {
  /** Drives registerAskUser's tool with a fake pi (capturing emitted events) and a fixed answer. */
  async function runAsk(params: any, answer: string | null) {
    let tool: any;
    const events: Array<{ name: string; payload: any }> = [];
    const pi = {
      registerTool: (t: any) => {
        tool = t;
      },
      events: {
        emit: (name: string, payload: any) => events.push({ name, payload }),
        on: () => () => {},
      },
    };
    withSubagentChildEnv(undefined, () => {
      registerAskUser(pi as any, () => {});
    });
    assert.ok(tool);
    const ctx = {
      hasUI: true,
      ui: {
        // Fake dialog: build the component, then answer as the TUI would.
        custom: (factory: any) => {
          const theme = new Proxy({}, { get: () => (s: string) => s });
          factory({ requestRender: () => {} }, theme, {}, () => {});
          return Promise.resolve(answer);
        },
      },
    };
    const result = await tool.execute("id", params, undefined, undefined, ctx);
    return { result, events, tool };
  }

  it("has no allowDiscuss parameter", async () => {
    const { tool } = await runAsk({ question: "Ship it?", options: ["Yes"] }, "Yes");
    const properties = Object.keys(tool.parameters.properties ?? {});
    assert.deepStrictEqual(properties, ["question", "options"]);
  });

  it("returns the picked option", async () => {
    const { result } = await runAsk({ question: "Ship it?", options: ["Yes", "No"] }, "Yes");
    assert.deepStrictEqual(result.content, [{ type: "text", text: "Yes" }]);
    assert.equal(result.terminate, undefined);
  });

  it("still terminates on cancel", async () => {
    const { result } = await runAsk({ question: "Ship it?", options: ["Yes", "No"] }, null);
    assert.equal(result.terminate, true);
  });

  it("skips registration in PI_SUBAGENT_CHILD=1 processes (#1163)", () => {
    let registered: any;
    const pi = {
      registerTool: (t: any) => {
        registered = t;
      },
    };
    withSubagentChildEnv("1", () => {
      registerAskUser(pi as any, () => {});
    });
    assert.equal(registered, undefined);
  });

  it("emits a pidash payload without the free-input row", async () => {
    const options = ["Yes", "No"];
    const { events } = await runAsk({ question: "Ship it?", options }, "Yes");
    const request = events.find((e) => e.name === "pidash:ui-request")?.payload;
    assert.ok(request, "pidash:ui-request emitted");
    assert.equal(request.method, "select");
    assert.deepStrictEqual(request.options, ["Yes", "No"]);
  });

  it("emits input mode with no options for free-input-only prompts", async () => {
    const { events } = await runAsk({ question: "Name?", options: [] }, "custom");
    const request = events.find((e) => e.name === "pidash:ui-request")?.payload;
    assert.equal(request.method, "input");
    assert.equal(request.options, undefined);
  });
});
