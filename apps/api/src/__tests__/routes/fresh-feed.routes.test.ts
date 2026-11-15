import express from "express";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import request from "supertest";

const mocks = vi.hoisted(() => ({
  flags: {} as Record<string, unknown>,
  logRequest: vi.fn(),
}));

vi.mock("../../lib/logger", () => {
  const logger = {
    child: () => logger,
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  };
  return { logger };
});

vi.mock("../../services/logging/log_job", () => ({
  logRequest: mocks.logRequest,
}));

vi.mock("../../routes/shared", () => ({ wrap: (fn: any) => fn }));

import { httpRequestDurationSeconds } from "../../lib/http-metrics";
import { logger } from "../../lib/logger";
import { createFreshFeedRouter } from "../../routes/fresh-feed";

const ROUTE = "/v2/fresh-vertical-feed/local/latest";
const SHORT_TIMEOUT_ROUTE = "/short-timeout/local/latest";

const PAGE =
  '{"feed":"local","events":[{"n":1.0,"t":"\\u00e9"}],"next_after":7,"more":false}';

const upstream = {
  requests: [] as {
    method?: string;
    url?: string;
    authorization?: string;
    acceptEncoding?: string;
  }[],
  status: 200,
  headers: {} as http.OutgoingHttpHeaders,
  body: PAGE as string | Buffer,
  silent: false,
  stallAfter: undefined as number | undefined,
};

const upstreamServer = http.createServer((req, res) => {
  upstream.requests.push({
    method: req.method,
    url: req.url,
    authorization: req.headers.authorization,
    acceptEncoding: req.headers["accept-encoding"],
  });
  if (upstream.silent) return;
  res.writeHead(req.url === "/moved" ? 200 : upstream.status, {
    "content-type": "application/json",
    ...upstream.headers,
  });
  if (upstream.stallAfter !== undefined) {
    res.write(upstream.body.slice(0, upstream.stallAfter));
    return;
  }
  res.end(upstream.body);
});

const app = express();
app.use((req: any, _res, next) => {
  req.auth = { team_id: "team-1" };
  req.acuc = { flags: mocks.flags };
  next();
});

const latest = (query = "", route = ROUTE) =>
  request(app)
    .get(route + query)
    .set("Authorization", "Bearer fc-caller-key");

const apiServer = http.createServer(app);

function undecoded(call: {
  method?: string;
  route?: string;
  query?: string;
  headers?: http.OutgoingHttpHeaders;
}) {
  return new Promise<{ response: http.IncomingMessage; body: Buffer }>(
    (resolve, reject) => {
      http
        .request(
          {
            host: "127.0.0.1",
            port: (apiServer.address() as AddressInfo).port,
            path: (call.route ?? ROUTE) + (call.query ?? ""),
            method: call.method,
            headers: call.headers,
          },
          response => {
            const chunks: Buffer[] = [];
            response.on("data", chunk => chunks.push(chunk));
            response.on("error", () => {});
            response.on("close", () =>
              resolve({ response, body: Buffer.concat(chunks) }),
            );
          },
        )
        .on("error", reject)
        .end();
    },
  );
}

beforeAll(async () => {
  await new Promise<void>(resolve =>
    upstreamServer.listen(0, "127.0.0.1", resolve),
  );
  const { port } = upstreamServer.address() as AddressInfo;
  const feedUrl = `http://127.0.0.1:${port}/`;
  app.use("/v2/fresh-vertical-feed", createFreshFeedRouter(feedUrl));
  app.use("/short-timeout", createFreshFeedRouter(feedUrl, 50));
  await new Promise<void>(resolve => apiServer.listen(0, "127.0.0.1", resolve));
});

afterAll(async () => {
  for (const server of [apiServer, upstreamServer]) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.logRequest.mockResolvedValue(undefined);
  mocks.flags = { freshFeed: true };
  upstream.requests.length = 0;
  upstream.status = 200;
  upstream.headers = {};
  upstream.body = PAGE;
  upstream.silent = false;
  upstream.stallAfter = undefined;
});

describe("GET /v2/fresh-vertical-feed/local/latest", () => {
  it("calls the feed with the caller's raw query and without the caller's key, and returns its body byte for byte", async () => {
    const query = "?limit=5&after=12&host=b+c&host=caf%C3%A9.example&x=";

    const { response, body } = await undecoded({
      query,
      headers: { authorization: "Bearer fc-caller-key" },
    });

    expect(upstream.requests).toEqual([
      {
        method: "GET",
        url: "/fresh-vertical-feed/local/latest" + query,
        authorization: undefined,
        acceptEncoding: undefined,
      },
    ]);
    expect(response.statusCode).toBe(200);
    expect(body.toString()).toBe(PAGE);
  });

  it("refuses a team without the flag before the feed is called", async () => {
    mocks.flags = {};

    const response = await latest("?after=0");

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      success: false,
      error: "This endpoint is not enabled for this team.",
    });
    expect(upstream.requests).toEqual([]);
  });

  it("refuses a team whose flag is not the boolean true", async () => {
    mocks.flags = { freshFeed: "false" };

    const response = await latest("?after=0");

    expect(response.status).toBe(403);
    expect(upstream.requests).toEqual([]);
  });

  it.each([400, 406])("returns the feed's %i unchanged", async status => {
    upstream.status = status;
    upstream.body = '{"error":  "unknown parameter: colour"}';

    const response = await latest("?colour=red");

    expect(response.status).toBe(status);
    expect(response.text).toBe(upstream.body);
  });

  it("answers 502 without the feed's body when the feed answers 401", async () => {
    upstream.status = 401;
    upstream.body = '{"error":"upstream detail"}';

    const response = await latest();

    expect(response.status).toBe(502);
    expect(response.headers["retry-after"]).toBeUndefined();
    expect(response.body).toEqual({
      success: false,
      error: "The request could not be completed.",
    });
  });

  it.each([500, 503])(
    "answers 503 with Retry-After and without the feed's body when the feed answers %i",
    async status => {
      upstream.status = status;
      upstream.body = '{"error":"upstream detail"}';

      const response = await latest();

      expect(response.status).toBe(503);
      expect(response.headers["retry-after"]).toBe("5");
      expect(response.body).toEqual({
        success: false,
        error: "The feed is temporarily unavailable. Retry the same request.",
      });
    },
  );

  it("answers 503 without waiting for the rest of the feed's error body", async () => {
    upstream.status = 500;
    upstream.stallAfter = 5;

    const response = await latest();

    expect(response.status).toBe(503);
  });

  it("answers 502 to a redirect from the feed without following it", async () => {
    upstream.status = 302;
    upstream.headers = { location: "/moved" };

    const response = await latest();

    expect(response.status).toBe(502);
    expect(upstream.requests).toHaveLength(1);
  });

  it("answers 504 when the feed sends no headers within the timeout", async () => {
    upstream.silent = true;

    const response = await latest("", SHORT_TIMEOUT_ROUTE);

    expect(response.status).toBe(504);
    expect(response.body).toEqual({
      success: false,
      error: "The request timed out.",
    });
  }, 10_000);

  it("stops the feed call without logging an error when the caller hangs up before the feed answers", async () => {
    upstream.silent = true;
    const reachedFeed = once(upstreamServer, "request");
    const call = http
      .get({
        host: "127.0.0.1",
        port: (apiServer.address() as AddressInfo).port,
        path: ROUTE,
      })
      .on("error", () => {});
    const [feedRequest] = (await reachedFeed) as [http.IncomingMessage];
    const feedCallStopped = once(feedRequest.socket, "close");

    call.destroy();
    await feedCallStopped;

    expect(logger.error).not.toHaveBeenCalled();
  }, 10_000);

  it.each([
    [{ freshFeed: true }, false],
    [{ freshFeed: true, searchZDR: "forced-zdr" }, true],
  ])(
    "logs a fresh_feed request for flags %j with zeroDataRetention %s",
    async (flags, zeroDataRetention) => {
      mocks.flags = flags;

      await latest("?after=3");

      expect(mocks.logRequest).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          kind: "fresh_feed",
          team_id: "team-1",
          zeroDataRetention,
        }),
      );
    },
  );

  it("compresses a large page for a caller that accepts gzip", async () => {
    upstream.body = JSON.stringify({
      feed: "local",
      events: [{ text: "<p>fresh</p>".repeat(500) }],
    });

    const response = await latest().set("Accept-Encoding", "gzip");

    expect(response.headers["content-encoding"]).toBe("gzip");
    expect(response.text).toBe(upstream.body);
  });

  it("passes the caller's Accept-Encoding to the feed and relays the feed's encoded bytes untouched", async () => {
    const encoded = gzipSync("<p>fresh</p>".repeat(500), { level: 1 });
    upstream.body = encoded;
    upstream.headers = {
      "content-encoding": "gzip",
      "content-length": encoded.length,
      vary: "Accept-Encoding, Origin",
      "set-cookie": "feed=1",
      "x-feed-only": "1",
    };

    const { response, body } = await undecoded({
      headers: { "accept-encoding": "gzip;q=0.9, zstd" },
    });

    expect(body.equals(encoded)).toBe(true);
    expect(upstream.requests[0].acceptEncoding).toBe("gzip;q=0.9, zstd");
    expect(response.headers).toMatchObject({
      "content-encoding": "gzip",
      "content-length": String(encoded.length),
      vary: "Accept-Encoding, Origin",
    });
    expect(response.headers).not.toHaveProperty("set-cookie");
    expect(response.headers).not.toHaveProperty("x-feed-only");
  });

  it("answers 405 to a HEAD before the request is logged or the feed is called", async () => {
    const { response } = await undecoded({ method: "HEAD" });

    expect(response.statusCode).toBe(405);
    expect(response.headers.allow).toBe("GET");
    expect(upstream.requests).toEqual([]);
    expect(mocks.logRequest).not.toHaveBeenCalled();
  });

  it("breaks the caller's transfer when the feed goes silent partway through the body, and still records its duration", async () => {
    upstream.stallAfter = 20;
    httpRequestDurationSeconds.reset();

    const { response, body } = await undecoded({ route: SHORT_TIMEOUT_ROUTE });

    expect(body.toString()).toBe(PAGE.slice(0, 20));
    expect(response.complete).toBe(false);
    await vi.waitFor(async () => {
      const { values } = await httpRequestDurationSeconds.get();
      expect(
        values.filter(
          v => v.metricName === "http_request_duration_seconds_count",
        ),
      ).toHaveLength(1);
    });
  }, 10_000);

  it("records a relayed response in the request duration histogram", async () => {
    httpRequestDurationSeconds.reset();

    await latest();

    await vi.waitFor(async () => {
      const { values } = await httpRequestDurationSeconds.get();
      expect(
        values
          .filter(v => v.metricName === "http_request_duration_seconds_count")
          .map(v => [v.labels, v.value]),
      ).toEqual([
        [
          {
            version: "v2",
            method: "GET",
            route: "/local/latest",
            status: "200",
          },
          1,
        ],
      ]);
    });
  });
});
