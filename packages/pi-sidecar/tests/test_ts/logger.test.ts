import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createLogger, logger } from "../../src/logger.js";

describe("sidecar createLogger", () => {
  it("prefixes the logger name and delegates debug/info/warn/error", () => {
    const orig = {
      debug: logger.debug,
      info: logger.info,
      warn: logger.warn,
      error: logger.error,
    };
    const calls: { level: string; args: unknown[] }[] = [];
    logger.debug = (...args: unknown[]) => {
      calls.push({ level: "debug", args });
    };
    logger.info = (...args: unknown[]) => {
      calls.push({ level: "info", args });
    };
    logger.warn = (...args: unknown[]) => {
      calls.push({ level: "warn", args });
    };
    logger.error = (...args: unknown[]) => {
      calls.push({ level: "error", args });
    };
    try {
      const named = createLogger("unit");
      assert.deepEqual(calls[0], {
        level: "debug",
        args: ["[sidecar] createLogger name=unit"],
      });
      named.debug("d1");
      named.info("i1");
      named.warn("w1");
      named.error("e1");
      assert.deepEqual(
        calls.filter((c) => c.args[0] === "[unit]"),
        [
          { level: "debug", args: ["[unit]", "d1"] },
          { level: "info", args: ["[unit]", "i1"] },
          { level: "warn", args: ["[unit]", "w1"] },
          { level: "error", args: ["[unit]", "e1"] },
        ],
      );
    } finally {
      logger.debug = orig.debug;
      logger.info = orig.info;
      logger.warn = orig.warn;
      logger.error = orig.error;
    }
  });
});
