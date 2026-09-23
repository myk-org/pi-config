import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../..");

it("declares the minimum supported Node version in tracked package metadata", () => {
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));

  assert.equal(pkg.engines?.node, ">=22.19.0");
});
