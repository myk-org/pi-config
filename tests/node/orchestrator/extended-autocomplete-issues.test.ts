/**
 * Tests for fetchOpenIssues autocomplete in extended-autocomplete.ts.
 * Run with: npx tsx --test tests/node/orchestrator/extended-autocomplete-issues.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Since fetchOpenIssues is internal to registerExtendedAutocomplete,
// we test the same logic pattern standalone.

interface AutocompleteItem {
  value: string;
  label: string;
  description: string;
}

interface IssueCache {
  data: AutocompleteItem[] | null;
  timestamp: number;
  loading: boolean;
}

function isFresh(cache: IssueCache, ttlMs = 30_000): boolean {
  return cache.data !== null && Date.now() - cache.timestamp < ttlMs;
}

async function fetchOpenIssues(
  cache: IssueCache,
  execFn: (cmd: string, args: string[], opts: any) => Promise<{ code: number; stdout: string }>,
  cwd: string,
): Promise<void> {
  if (isFresh(cache) || cache.loading) return;
  cache.loading = true;
  try {
    const result = await execFn(
      "gh", ["issue", "list", "--state", "open", "--limit", "50", "--json", "number,title"],
      { cwd, timeout: 10_000 },
    );
    if (result.code === 0) {
      const issues = JSON.parse(result.stdout) as Array<{ number: number; title: string }>;
      cache.data = issues.map((issue) => ({
        value: String(issue.number),
        label: `#${issue.number}`,
        description: issue.title,
      }));
      cache.timestamp = Date.now();
    }
  } catch { /* ignore */ }
  cache.loading = false;
}

describe("fetchOpenIssues", () => {
  let cache: IssueCache;

  beforeEach(() => {
    cache = { data: null, timestamp: 0, loading: false };
  });

  it("populates cache from gh issue list output", async () => {
    const mockExec = async () => ({
      code: 0,
      stdout: JSON.stringify([
        { number: 42, title: "Fix the bug" },
        { number: 99, title: "Add feature" },
      ]),
    });

    await fetchOpenIssues(cache, mockExec, "/tmp");

    assert.equal(cache.data?.length, 2);
    assert.equal(cache.data![0].value, "42");
    assert.equal(cache.data![0].label, "#42");
    assert.equal(cache.data![0].description, "Fix the bug");
    assert.equal(cache.data![1].value, "99");
    assert.ok(cache.timestamp > 0);
    assert.equal(cache.loading, false);
  });

  it("skips fetch when cache is fresh", async () => {
    let callCount = 0;
    const mockExec = async () => {
      callCount++;
      return { code: 0, stdout: "[]" };
    };

    await fetchOpenIssues(cache, mockExec, "/tmp");
    assert.equal(callCount, 1);

    // Second call — cache is fresh
    await fetchOpenIssues(cache, mockExec, "/tmp");
    assert.equal(callCount, 1); // not called again
  });

  it("skips fetch when already loading", async () => {
    cache.loading = true;
    let callCount = 0;
    const mockExec = async () => {
      callCount++;
      return { code: 0, stdout: "[]" };
    };

    await fetchOpenIssues(cache, mockExec, "/tmp");
    assert.equal(callCount, 0);
  });

  it("handles non-zero exit code gracefully", async () => {
    const mockExec = async () => ({ code: 1, stdout: "" });

    await fetchOpenIssues(cache, mockExec, "/tmp");

    assert.equal(cache.data, null);
    assert.equal(cache.loading, false);
  });

  it("handles exec exception gracefully", async () => {
    const mockExec = async () => { throw new Error("network error"); };

    await fetchOpenIssues(cache, mockExec, "/tmp");

    assert.equal(cache.data, null);
    assert.equal(cache.loading, false);
  });

  it("handles empty issue list", async () => {
    const mockExec = async () => ({ code: 0, stdout: "[]" });

    await fetchOpenIssues(cache, mockExec, "/tmp");

    assert.deepEqual(cache.data, []);
    assert.ok(cache.timestamp > 0);
  });

  it("passes correct args to gh", async () => {
    let capturedArgs: string[] = [];
    let capturedOpts: any = {};
    const mockExec = async (_cmd: string, args: string[], opts: any) => {
      capturedArgs = args;
      capturedOpts = opts;
      return { code: 0, stdout: "[]" };
    };

    await fetchOpenIssues(cache, mockExec, "/my/project");

    assert.deepEqual(capturedArgs, ["issue", "list", "--state", "open", "--limit", "50", "--json", "number,title"]);
    assert.equal(capturedOpts.cwd, "/my/project");
    assert.equal(capturedOpts.timeout, 10_000);
  });
});
