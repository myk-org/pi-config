/**
 * Drive the sidecar request handler without a socket (issue #1126).
 *
 * `request-handler.ts` reads only `method`, `url` and `headers` off the request
 * plus the readable stream events `parseBody` consumes, so a plain `Readable`
 * is enough. The response side needs the members the handler calls —
 * `writeHead`, `flushHeaders`, `write`, `end` — plus `writableLength` and a
 * `close` event, which is how a `GET /sessions/:id/events` feed is torn down.
 *
 * No network, no timers, no ports.
 */
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

export type RequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

type HeaderValue = string | number | string[];

/** Fake `ServerResponse`: captures status, headers and body; `close` is manual. */
export class FakeResponse extends EventEmitter {
  status = 200;
  /** Header names are lowercased, like Node's `res.getHeaders()`. */
  headers: Record<string, HeaderValue> = {};
  body = "";
  /** Times `end()` was called — a closed feed ends exactly once. */
  ended = 0;
  headersFlushed = false;

  writeHead(status: number, headers: Record<string, HeaderValue> = {}): this {
    this.status = status;
    for (const [key, value] of Object.entries(headers)) {
      this.headers[key.toLowerCase()] = value;
    }
    return this;
  }

  flushHeaders(): void {
    this.headersFlushed = true;
  }

  write(chunk: string | Buffer): boolean {
    this.body += chunk.toString();
    return true;
  }

  end(chunk?: string | Buffer): this {
    if (chunk) this.body += chunk.toString();
    this.ended++;
    return this;
  }

  get writableLength(): number {
    return 0;
  }

  /** Simulate the client going away (fires the handler's `close` teardown). */
  disconnect(): void {
    this.emit("close");
  }
}

export interface InvokeOptions {
  method: string;
  url: string;
  /** JSON string or object; omitted means an empty body. */
  body?: string | object;
  headers?: Record<string, string>;
}

export interface InvokeResult {
  /** Live views: a feed opened by the handler keeps writing after `invoke` returns. */
  readonly status: number;
  readonly headers: Record<string, HeaderValue>;
  readonly body: string;
  /** Parsed body, `undefined` when the body is not JSON (e.g. an SSE feed). */
  readonly json: any;
  /** The fake response, for stream tests that must inspect or close it. */
  res: FakeResponse;
  /** The fake request, for the test that closes it while the feed stays open. */
  req: IncomingMessage;
}

export async function invoke(
  handler: RequestHandler,
  { method, url, body, headers = {} }: InvokeOptions,
): Promise<InvokeResult> {
  const payload = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  const req = Object.assign(
    Readable.from(payload ? [Buffer.from(payload)] : []),
    { method, url, headers },
  ) as unknown as IncomingMessage;
  const res = new FakeResponse();

  await handler(req, res as unknown as ServerResponse);

  return {
    res,
    req,
    get status() { return res.status; },
    get headers() { return res.headers; },
    get body() { return res.body; },
    get json() {
      try {
        return JSON.parse(res.body);
      } catch {
        return undefined;
      }
    },
  };
}
