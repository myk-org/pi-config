import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { interpolate, createHttpToolExecutor, normalizeHttpToolConfig, type HttpToolConfig } from "../../src/http-tool-executor.js";

// ---------------------------------------------------------------------------
// 1. interpolate()
// ---------------------------------------------------------------------------

describe("interpolate", () => {
  it("replaces single placeholder", () => {
    assert.equal(interpolate("Hello {name}", { name: "World" }), "Hello World");
  });

  it("replaces multiple placeholders", () => {
    assert.equal(
      interpolate("{greeting} {name}!", { greeting: "Hi", name: "Alice" }),
      "Hi Alice!",
    );
  });

  it("leaves unmatched placeholders as-is", () => {
    assert.equal(interpolate("{known} and {unknown}", { known: "yes" }), "yes and {unknown}");
  });

  it("handles empty params", () => {
    assert.equal(interpolate("{a} {b}", {}), "{a} {b}");
  });

  it("handles no placeholders", () => {
    assert.equal(interpolate("no placeholders here", { foo: "bar" }), "no placeholders here");
  });

  it("stringifies non-string values", () => {
    assert.equal(interpolate("count={n}", { n: 42 }), "count=42");
  });

  it("stringifies object values as JSON", () => {
    assert.equal(
      interpolate("data={obj}", { obj: { key: "val" } }),
      'data={"key":"val"}',
    );
  });

  it("replaces same placeholder multiple times", () => {
    assert.equal(interpolate("{x}+{x}={y}", { x: "1", y: "2" }), "1+1=2");
  });
});

// ---------------------------------------------------------------------------
// 2. normalizeHttpToolConfig()
// ---------------------------------------------------------------------------

describe("normalizeHttpToolConfig", () => {
  it("passes through camelCase properties as-is", () => {
    const config = normalizeHttpToolConfig({
      method: "POST",
      url: "https://example.com",
      headers: { "X-Key": "val" },
      queryParams: { q: "test" },
      bodyTemplate: { key: "{val}" },
      timeoutMs: 5000,
    });
    assert.equal(config.method, "POST");
    assert.equal(config.url, "https://example.com");
    assert.deepEqual(config.queryParams, { q: "test" });
    assert.deepEqual(config.bodyTemplate, { key: "{val}" });
    assert.equal(config.timeoutMs, 5000);
  });

  it("converts snake_case wire format to camelCase", () => {
    const config = normalizeHttpToolConfig({
      method: "GET",
      url: "https://example.com",
      query_params: { q: "test" },
      body_template: '{"key": "val"}',
      timeout_ms: 10000,
    });
    assert.deepEqual(config.queryParams, { q: "test" });
    assert.equal(config.bodyTemplate, '{"key": "val"}');
    assert.equal(config.timeoutMs, 10000);
  });

  it("prefers camelCase over snake_case when both provided", () => {
    const config = normalizeHttpToolConfig({
      method: "GET",
      url: "https://example.com",
      queryParams: { camel: "wins" },
      query_params: { snake: "loses" },
      bodyTemplate: "camel body",
      body_template: "snake body",
    });
    assert.deepEqual(config.queryParams, { camel: "wins" });
    assert.equal(config.bodyTemplate, "camel body");
  });

  it("handles missing optional properties", () => {
    const config = normalizeHttpToolConfig({
      method: "DELETE",
      url: "https://example.com/item",
    });
    assert.equal(config.method, "DELETE");
    assert.equal(config.queryParams, undefined);
    assert.equal(config.bodyTemplate, undefined);
    assert.equal(config.timeoutMs, undefined);
  });
});

// ---------------------------------------------------------------------------
// 3. createHttpToolExecutor()
// ---------------------------------------------------------------------------

describe("createHttpToolExecutor", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** Helper to create a mock fetch that returns a readable Response */
  function mockFetch(body: string, status: number = 200): void {
    globalThis.fetch = mock.fn(async () => {
      return new Response(body, { status });
    }) as any;
  }

  function getFetchCall(index: number = 0): { url: string; options: any } {
    const fetchMock = globalThis.fetch as ReturnType<typeof mock.fn>;
    const [url, options] = fetchMock.mock.calls[index].arguments;
    return { url, options };
  }

  // -- Basic requests --

  it("makes GET request with interpolated URL", async () => {
    mockFetch("response body");

    const config: HttpToolConfig = {
      method: "GET",
      url: "https://api.example.com/users/{userId}",
    };
    const executor = createHttpToolExecutor(config);
    const result = await executor({ userId: "123" });

    assert.equal(result, "response body");

    const { url, options } = getFetchCall();
    assert.equal(url, "https://api.example.com/users/123");
    assert.equal(options.method, "GET");
  });

  it("appends interpolated query parameters", async () => {
    mockFetch("ok");

    const config: HttpToolConfig = {
      method: "GET",
      url: "https://api.example.com/search",
      queryParams: { q: "{query}", limit: "{limit}" },
    };
    const executor = createHttpToolExecutor(config);
    await executor({ query: "test term", limit: "10" });

    const { url } = getFetchCall();
    assert.ok(url.includes("q=test+term") || url.includes("q=test%20term"), `URL should contain encoded query: ${url}`);
    assert.ok(url.includes("limit=10"), `URL should contain limit: ${url}`);
  });

  it("sends interpolated headers", async () => {
    mockFetch("ok");

    const config: HttpToolConfig = {
      method: "GET",
      url: "https://api.example.com/data",
      headers: { Authorization: "Bearer {token}", "X-Request-Id": "{reqId}" },
    };
    const executor = createHttpToolExecutor(config);
    await executor({ token: "abc123", reqId: "req-42" });

    const { options } = getFetchCall();
    assert.equal(options.headers.Authorization, "Bearer abc123");
    assert.equal(options.headers["X-Request-Id"], "req-42");
  });

  it("sends interpolated string body template", async () => {
    mockFetch("created");

    const config: HttpToolConfig = {
      method: "POST",
      url: "https://api.example.com/items",
      bodyTemplate: '{"name": "{itemName}", "count": {itemCount}}',
    };
    const executor = createHttpToolExecutor(config);
    await executor({ itemName: "widget", itemCount: 5 });

    const { options } = getFetchCall();
    assert.equal(options.body, '{"name": "widget", "count": 5}');
  });

  it("sends interpolated object body template", async () => {
    mockFetch("ok");

    const config: HttpToolConfig = {
      method: "PUT",
      url: "https://api.example.com/items/{id}",
      bodyTemplate: { name: "{itemName}", active: true },
    };
    const executor = createHttpToolExecutor(config);
    await executor({ id: "42", itemName: "updated-widget" });

    const { url, options } = getFetchCall();
    assert.equal(url, "https://api.example.com/items/42");
    const body = JSON.parse(options.body);
    assert.equal(body.name, "updated-widget");
    assert.equal(body.active, true);
  });

  // -- Content-Type handling --

  it("sets Content-Type to application/json when body is present and no Content-Type header", async () => {
    mockFetch("ok");

    const config: HttpToolConfig = {
      method: "POST",
      url: "https://api.example.com/items",
      bodyTemplate: '{"key": "value"}',
    };
    const executor = createHttpToolExecutor(config);
    await executor({});

    const { options } = getFetchCall();
    assert.equal(options.headers["Content-Type"], "application/json");
  });

  it("does not override existing Content-Type header", async () => {
    mockFetch("ok");

    const config: HttpToolConfig = {
      method: "POST",
      url: "https://api.example.com/items",
      headers: { "Content-Type": "text/plain" },
      bodyTemplate: "raw text {data}",
    };
    const executor = createHttpToolExecutor(config);
    await executor({ data: "hello" });

    const { options } = getFetchCall();
    assert.equal(options.headers["Content-Type"], "text/plain");
  });

  // -- Error handling --

  it("returns error string on HTTP error status", async () => {
    mockFetch("Not Found", 404);

    const config: HttpToolConfig = {
      method: "GET",
      url: "https://api.example.com/missing",
    };
    const executor = createHttpToolExecutor(config);
    const result = await executor({});

    assert.equal(result, "HTTP 404: Not Found");
  });

  it("returns error string on network failure (does not throw)", async () => {
    globalThis.fetch = mock.fn(async () => {
      throw new Error("Connection refused");
    }) as any;

    const config: HttpToolConfig = {
      method: "GET",
      url: "https://api.example.com/down",
    };
    const executor = createHttpToolExecutor(config);
    const result = await executor({});

    assert.equal(result, "HTTP request failed: Connection refused");
  });

  it("handles DELETE request without body", async () => {
    mockFetch("");

    const config: HttpToolConfig = {
      method: "DELETE",
      url: "https://api.example.com/items/{id}",
    };
    const executor = createHttpToolExecutor(config);
    const result = await executor({ id: "99" });

    assert.equal(result, "");

    const { url, options } = getFetchCall();
    assert.equal(url, "https://api.example.com/items/99");
    assert.equal(options.method, "DELETE");
    assert.equal(options.body, undefined);
  });

  it("appends query params to URL that already has a query string", async () => {
    mockFetch("ok");

    const config: HttpToolConfig = {
      method: "GET",
      url: "https://api.example.com/search?base=true",
      queryParams: { q: "{query}" },
    };
    const executor = createHttpToolExecutor(config);
    await executor({ query: "hello" });

    const { url } = getFetchCall();
    assert.ok(url.startsWith("https://api.example.com/search?base=true&"), `URL should use & separator: ${url}`);
    assert.ok(url.includes("q=hello"), `URL should contain q=hello: ${url}`);
  });

  it("inserts query params before URL fragment", async () => {
    mockFetch("ok");

    const config: HttpToolConfig = {
      method: "GET",
      url: "https://api.example.com/docs#section",
      queryParams: { q: "{query}" },
    };
    const executor = createHttpToolExecutor(config);
    await executor({ query: "test" });

    const { url } = getFetchCall();
    assert.ok(url.includes("?q=test#section"), `Query should come before fragment: ${url}`);
    assert.ok(!url.includes("#section?"), `Fragment should not come before query: ${url}`);
  });

  // -- Security: SSRF / path traversal prevention --

  it("URI-encodes path parameters to prevent path traversal", async () => {
    mockFetch("ok");

    const config: HttpToolConfig = {
      method: "GET",
      url: "https://api.example.com/users/{userId}/profile",
    };
    const executor = createHttpToolExecutor(config);
    await executor({ userId: "../../admin" });

    const { url } = getFetchCall();
    assert.equal(url, "https://api.example.com/users/..%2F..%2Fadmin/profile");
    assert.ok(!url.includes("../../"), "URL must not contain raw path traversal");
  });

  it("URI-encodes special URL characters in path parameters", async () => {
    mockFetch("ok");

    const config: HttpToolConfig = {
      method: "GET",
      url: "https://api.example.com/items/{name}",
    };
    const executor = createHttpToolExecutor(config);
    await executor({ name: "foo bar/baz?x=1&y=2#frag" });

    const { url } = getFetchCall();
    assert.ok(!url.includes(" "), "URL must not contain raw spaces");
    assert.ok(url.includes("foo%20bar"), `URL should encode spaces: ${url}`);
    assert.ok(url.includes("%2Fbaz"), `URL should encode slashes: ${url}`);
  });

  // -- Security: CRLF header injection prevention --

  it("strips CR/LF from interpolated header values", async () => {
    mockFetch("ok");

    const config: HttpToolConfig = {
      method: "GET",
      url: "https://api.example.com/data",
      headers: { "X-Custom": "value-{injected}" },
    };
    const executor = createHttpToolExecutor(config);
    await executor({ injected: "legit\r\nX-Evil: injected" });

    const { options } = getFetchCall();
    assert.equal(options.headers["X-Custom"], "value-legitX-Evil: injected");
    assert.ok(!options.headers["X-Custom"].includes("\r"), "Header must not contain CR");
    assert.ok(!options.headers["X-Custom"].includes("\n"), "Header must not contain LF");
  });

  // -- Security: JSON injection prevention in object body templates --

  it("JSON-escapes string values in object body templates to prevent injection", async () => {
    mockFetch("ok");

    const config: HttpToolConfig = {
      method: "POST",
      url: "https://api.example.com/items",
      bodyTemplate: { name: "{itemName}", type: "widget" },
    };
    const executor = createHttpToolExecutor(config);
    await executor({ itemName: 'foo"bar' });

    const { options } = getFetchCall();
    // The body should be valid JSON despite the quote in the value
    const parsed = JSON.parse(options.body);
    assert.equal(parsed.name, 'foo"bar');
    assert.equal(parsed.type, "widget");
  });

  it("handles backslashes and special chars in object body template values", async () => {
    mockFetch("ok");

    const config: HttpToolConfig = {
      method: "POST",
      url: "https://api.example.com/items",
      bodyTemplate: { path: "{filePath}" },
    };
    const executor = createHttpToolExecutor(config);
    await executor({ filePath: 'C:\\Users\\test\t"hello"\nnewline' });

    const { options } = getFetchCall();
    const parsed = JSON.parse(options.body);
    assert.equal(parsed.path, 'C:\\Users\\test\t"hello"\nnewline');
  });

  // -- Security: URL scheme validation --

  it("blocks non-http/https URL schemes", async () => {
    mockFetch("should not reach");

    const config: HttpToolConfig = {
      method: "GET",
      url: "file:///etc/passwd",
    };
    const executor = createHttpToolExecutor(config);
    const result = await executor({});

    assert.ok(result.includes("Unsupported URL scheme"), `Should block file: scheme: ${result}`);
    const fetchMock = globalThis.fetch as ReturnType<typeof mock.fn>;
    assert.equal(fetchMock.mock.callCount(), 0, "fetch should not be called for blocked schemes");
  });

  it("allows https URLs", async () => {
    mockFetch("ok");

    const config: HttpToolConfig = {
      method: "GET",
      url: "https://api.example.com/data",
    };
    const executor = createHttpToolExecutor(config);
    const result = await executor({});

    assert.equal(result, "ok");
  });

  it("allows http URLs", async () => {
    mockFetch("ok");

    const config: HttpToolConfig = {
      method: "GET",
      url: "http://internal-api.local/data",
    };
    const executor = createHttpToolExecutor(config);
    const result = await executor({});

    assert.equal(result, "ok");
  });

  it("returns error for invalid URLs", async () => {
    mockFetch("should not reach");

    const config: HttpToolConfig = {
      method: "GET",
      url: "not-a-url",
    };
    const executor = createHttpToolExecutor(config);
    const result = await executor({});

    assert.ok(result.includes("Invalid URL"), `Should reject invalid URL: ${result}`);
  });

  // -- Timeout --

  it("returns timeout error when request exceeds timeoutMs", async () => {
    globalThis.fetch = mock.fn(async (_url: string, init: any) => {
      // Simulate a slow request — listen for abort signal
      return new Promise<Response>((_resolve, reject) => {
        if (init?.signal) {
          init.signal.addEventListener("abort", () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
      });
    }) as any;

    const config: HttpToolConfig = {
      method: "GET",
      url: "https://api.example.com/slow",
      timeoutMs: 50,
    };
    const executor = createHttpToolExecutor(config);
    const result = await executor({});

    assert.ok(result.includes("timed out"), `Should contain timeout message: ${result}`);
    assert.ok(result.includes("50ms"), `Should mention timeout duration: ${result}`);
  });

  it("uses default 30s timeout when timeoutMs not specified", async () => {
    // Just verify the signal is set (don't wait for actual timeout)
    globalThis.fetch = mock.fn(async (_url: string, init: any) => {
      assert.ok(init.signal, "AbortController signal should be passed to fetch");
      return new Response("ok", { status: 200 });
    }) as any;

    const config: HttpToolConfig = {
      method: "GET",
      url: "https://api.example.com/fast",
    };
    const executor = createHttpToolExecutor(config);
    await executor({});
  });

  // -- External signal (SDK abort) --

  it("aborts immediately when external signal is already aborted", async () => {
    mockFetch("should not reach");

    const config: HttpToolConfig = {
      method: "GET",
      url: "https://api.example.com/data",
    };
    const executor = createHttpToolExecutor(config);
    const controller = new AbortController();
    controller.abort();

    const result = await executor({}, controller.signal);

    assert.equal(result, "HTTP request failed: Request aborted");
    // fetch should not have been called
    const fetchMock = globalThis.fetch as ReturnType<typeof mock.fn>;
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  it("sanitizes url_template in error log to prevent log injection", async () => {
    const loggedMessages: string[] = [];
    const originalError = console.error;
    console.error = (...args: any[]) => {
      loggedMessages.push(args.map(String).join(" "));
    };

    try {
      const httpConfig: HttpToolConfig = {
        method: "GET",
        url: "not-a-valid-url\r\n[sidecar] FAKE: injected=true",
      };
      const executor = createHttpToolExecutor(httpConfig);
      const result = await executor({});

      // The executor should return an error string (not throw)
      assert.ok(result.includes("HTTP request failed"), `Expected error message, got: ${result}`);

      // Verify the log was emitted
      const blockLog = loggedMessages.find((m) => m.includes("HTTP_TOOL_BLOCKED") && m.includes("invalid_url"));
      assert.ok(blockLog, `Expected HTTP_TOOL_BLOCKED log, got: ${JSON.stringify(loggedMessages)}`);

      // Verify CR/LF was stripped from the logged message
      assert.ok(!blockLog.includes("\r"), "Log should not contain CR");
      assert.ok(!blockLog.includes("\n"), "Log should not contain LF");

      // Verify the injected fake log line is not present as a separate log line
      // (CR/LF stripped means the injected text is concatenated, not on its own line)
      const separateLines = loggedMessages.filter((m) => m.includes("[sidecar] FAKE") && !m.includes("HTTP_TOOL_BLOCKED"));
      assert.equal(separateLines.length, 0, "Injected content should not appear as a separate log line");

      // Verify sanitized template is still included (without CR/LF)
      assert.ok(blockLog.includes("url_template="), "Log should include url_template field");
    } finally {
      console.error = originalError;
    }
  });

  it("aborts when external signal fires during request", async () => {
    const externalController = new AbortController();

    globalThis.fetch = mock.fn(async (_url: string, init: any) => {
      return new Promise<Response>((_resolve, reject) => {
        if (init?.signal) {
          init.signal.addEventListener("abort", () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
        // Trigger external abort after a short delay
        setTimeout(() => externalController.abort(), 10);
      });
    }) as any;

    const config: HttpToolConfig = {
      method: "GET",
      url: "https://api.example.com/slow",
      timeoutMs: 60_000, // Long timeout so it doesn't interfere
    };
    const executor = createHttpToolExecutor(config);
    const result = await executor({}, externalController.signal);

    assert.ok(result.includes("Request aborted"), `Should mention abort: ${result}`);
  });
});
