import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import { resolveUiDir } from "../../../scripts/daemon-shared.ts";

describe("resolveUiDir", () => {
  const uiPath = ["..", "extensions", "pidash", "pidash-ui", "dist"];

  it("prefers the process program path", () => {
    assert.equal(
      resolveUiDir("/installed/scripts/pidash-server.ts", "file:///source/scripts/pidash-server.ts", ...uiPath),
      path.normalize("/installed/extensions/pidash/pidash-ui/dist"),
    );
  });

  it("falls back to the ESM module URL for programmatic imports", () => {
    assert.equal(
      resolveUiDir(undefined, "file:///source/scripts/pidash-server.ts", ...uiPath),
      path.normalize("/source/extensions/pidash/pidash-ui/dist"),
    );
  });
});
