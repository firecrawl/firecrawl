import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
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

import { createFreshFeedRouter } from "../../routes/fresh-feed";

const PAGE =
  '{"feed":"local","events":[{"n":1.0,"t":"\\u00e9"}],"next_after":7,"more":false}';

const upstream = {
  requests: [] as { url?: string; authorization?: string }[],
  status: 200,
  body: PAGE,
  silent: false,
};

const upstreamServer = http.createServer((req, res) => {
  upstream.requests.push({
    url: req.url,
    authorization: req.headers.authorization,
  });
  if (upstream.silent) return;
  res.writeHead(upstream.status, { "content-type": "application/json" });
  res.end(upstream.body);
});

const app = express();
app.use((req: any, _res, next) => {
  req.auth = { team_id: "team-1" };
  req.acuc = { flags: mocks.flags };
  next();
});

const latest = (query = "") =>
  request(app)
    .get("/v2/fresh-vertical-feed/local/latest" + query)
    .set("Authorization", "Bearer fc-caller-key");

beforeAll(async () => {
  await new Promise<void>(resolve =>
    upstreamServer.listen(0, "127.0.0.1", resolve),
  );
  const { port } = upstreamServer.address() as AddressInfo;
  app.use(
    "/v2/fresh-vertical-feed",
    createFreshFeedRouter(`http://127.0.0.1:${port}/`),
  );
});

afterAll(async () => {
  upstreamServer.closeAllConnections();
  await new Promise(resolve => upstreamServer.close(resolve));
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.logRequest.mockResolvedValue(undefined);
  mocks.flags = { freshFeed: true };
  upstream.requests.length = 0;
  upstream.status = 200;
  upstream.body = PAGE;
  upstream.silent = false;
});

describe("GET /v2/fresh-vertical-feed/local/latest", () => {
  it("calls the feed with the caller's raw query and without the caller's key, and returns its body byte for byte", async () => {
    const query = "?limit=5&after=12&host=b+c&host=caf%C3%A9.example&x=";

    const response = await latest(query);

    expect(upstream.requests).toEqual([
      {
        url: "/fresh-vertical-feed/local/latest" + query,
        authorization: undefined,
      },
    ]);
    expect(response.status).toBe(200);
    expect(response.text).toBe(PAGE);
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

  it("refuses a Safe Mode organization before the feed is called", async () => {
    mocks.flags = { freshFeed: true, safeMode: true };

    const response = await latest("?after=0");

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      success: false,
      error:
        "Safe Mode is enabled for your organization, which does not support this endpoint.",
    });
    expect(upstream.requests).toEqual([]);
    expect(mocks.logRequest).not.toHaveBeenCalled();
  });

  it("returns the feed's 400 unchanged", async () => {
    upstream.status = 400;
    upstream.body = '{"error":  "unknown parameter: colour"}';

    const response = await latest("?colour=red");

    expect(response.status).toBe(400);
    expect(response.text).toBe(upstream.body);
  });

  it.each([401, 500])(
    "answers 502 without the feed's body when the feed answers %i",
    async status => {
      upstream.status = status;
      upstream.body = '{"error":"upstream detail"}';

      const response = await latest();

      expect(response.status).toBe(502);
      expect(response.body).toEqual({
        success: false,
        error: "The request could not be completed.",
      });
    },
  );

  it("answers 504 when the feed does not answer in time", async () => {
    upstream.silent = true;
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const shortened = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation(() => timeout(50));

    try {
      const response = await latest();

      expect(response.status).toBe(504);
      expect(response.body).toEqual({
        success: false,
        error: "The request timed out.",
      });
    } finally {
      shortened.mockRestore();
    }
  });

  it.each([
    [{ freshFeed: true }, false],
    [{ freshFeed: true, searchZDR: "forced-zdr" }, true],
    [{ freshFeed: true, scrapeZDR: "forced" }, true],
  ])(
    "logs a fresh_feed request without the query for flags %j with zeroDataRetention %s",
    async (flags, zeroDataRetention) => {
      mocks.flags = flags;

      await latest("?after=3&host=example.org");

      expect(mocks.logRequest).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          kind: "fresh_feed",
          team_id: "team-1",
          target_hint: "/fresh-vertical-feed/local/latest",
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
});
