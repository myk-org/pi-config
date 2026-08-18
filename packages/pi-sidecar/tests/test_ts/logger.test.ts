import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createLogger, logger } from "../../src/logger.js";

function stubLogger(): {
  calls: { level: string; args: unknown[] }[];
  restore: () => void;
} {
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
  return {
    calls,
    restore: () => {
      logger.debug = orig.debug;
      logger.info = orig.info;
      logger.warn = orig.warn;
      logger.error = orig.error;
    },
  };
}

describe("sidecar createLogger", () => {
  it("createLogger prefixes the logger name", () => {
    const stub = stubLogger();
    try {
      createLogger("unit");
      assert.deepEqual(stub.calls[0], {
        level: "debug",
        args: ["[sidecar] createLogger name=unit"],
      });
    } finally {
      stub.restore();
    }
  });

  it("createLogger delegates debug", () => {
    const stub = stubLogger();
    try {
      const named = createLogger("unit");
      named.debug("d1");
      assert.deepEqual(
        stub.calls.find((c) => c.level === "debug" && c.args[0] === "[unit]"),
        { level: "debug", args: ["[unit]", "d1"] },
      );
    } finally {
      stub.restore();
    }
  });

  it("createLogger delegates info", () => {
    const stub = stubLogger();
    try {
      const named = createLogger("unit");
      named.info("i1");
      assert.deepEqual(
        stub.calls.find((c) => c.level === "info" && c.args[0] === "[unit]"),
        { level: "info", args: ["[unit]", "i1"] },
      );
    } finally {
      stub.restore();
    }
  });

  it("createLogger delegates warn", () => {
    const stub = stubLogger();
    try {
      const named = createLogger("unit");
      named.warn("w1");
      assert.deepEqual(
        stub.calls.find((c) => c.level === "warn" && c.args[0] === "[unit]"),
        { level: "warn", args: ["[unit]", "w1"] },
      );
    } finally {
      stub.restore();
    }
  });

  it("createLogger delegates error", () => {
    const stub = stubLogger();
    try {
      const named = createLogger("unit");
      named.error("e1");
      assert.deepEqual(
        stub.calls.find((c) => c.level === "error" && c.args[0] === "[unit]"),
        { level: "error", args: ["[unit]", "e1"] },
      );
    } finally {
      stub.restore();
    }
  });
});
