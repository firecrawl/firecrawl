import bodyParser from "body-parser";
import cors from "cors";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";

// The real file routes in front of a real stand-in for Exchange: bytes cross a socket both ways.
vi.mock("../../services/rate-limiter", () => ({
  redisRateLimitClient: {},
}));

import { config } from "../../config";
import {
  EXCHANGE_FILE_MAX_BYTES,
  registerExchangeFileRoutes,
} from "../../routes/exchange-files";

const TOKEN = "eyJ2IjoxLCJrIjoidSJ9abcdefgh.sig_nature-0123456789abcdef";

type Seen = {
  method?: string;
  url?: string;
  headers?: http.IncomingHttpHeaders;
  body?: Buffer;
};

let exchange: http.Server;
let seen: Seen;
let download = Buffer.from("city,rent\nAustin,2140\n");

beforeAll(async () => {
  exchange = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      seen = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      if (req.method === "PUT") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ success: true }));
      }
      res.writeHead(200, {
        "content-type": "text/csv",
        "content-length": String(download.length),
        "content-disposition": 'attachment; filename="rows.csv"',
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
        "x-goog-generation": "leak",
      });
      res.end(download);
    });
  });
  await new Promise<void>(resolve => exchange.listen(0, "127.0.0.1", resolve));
  config.FIRE_EXCHANGE_URL = `http://127.0.0.1:${(exchange.address() as AddressInfo).port}`;
  config.REDIS_RATE_LIMIT_URL = undefined;
});

afterAll(() => new Promise(resolve => exchange.close(resolve)));

beforeEach(() => {
  seen = {};
});

/** As index.ts wires it: the file routes first, then the global parsers and the open CORS. */
const app = express();
registerExchangeFileRoutes(app);
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json({ limit: "10mb" }));
app.use(cors());
app.use((_req, res) => res.status(404).json({ fell: "through" }));

describe("exchange file routes", () => {
  it("streams an upload to Exchange untouched, with no API key", async () => {
    // A JSON body would be parsed by the global parser if it ran: here it arrives as sent.
    const body = '{"a": 1,   "b": [2]}';
    const res = await request(app)
      .put(`/exchange/files/upload/${TOKEN}`)
      .set("Content-Type", "application/json")
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(seen.method).toBe("PUT");
    expect(seen.url).toBe(`/v1/files/upload/${TOKEN}`);
    expect(seen.body?.toString()).toBe(body);
    expect(seen.headers?.["content-type"]).toBe("application/json");
    expect(seen.headers?.["content-length"]).toBe(String(body.length));
    expect(seen.headers?.authorization).toBeUndefined();
  });

  it("streams a download back with Exchange's headers, and nothing else of upstream's", async () => {
    const res = await request(app)
      .get(`/exchange/files/download/${TOKEN}`)
      .buffer(true)
      .parse((response, done) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => done(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect((res.body as Buffer).equals(download)).toBe(true);
    expect(res.headers).toMatchObject({
      "content-type": "text/csv",
      "content-disposition": 'attachment; filename="rows.csv"',
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    });
    expect(res.headers["x-goog-generation"]).toBeUndefined();
    expect(seen.url).toBe(`/v1/files/download/${TOKEN}`);
  });

  it("refuses a token of the wrong shape before reaching Exchange", async () => {
    for (const bad of [
      "abc",
      "a.b",
      `${TOKEN}.extra`,
      "x".repeat(40),
      `${"a".repeat(3000)}.signature0123456789`,
    ]) {
      const res = await request(app)
        .put(`/exchange/files/upload/${bad}`)
        .set("Content-Type", "text/csv")
        .send("abc");
      expect(res.status, bad.slice(0, 20)).toBe(400);
      expect(
        (await request(app).get(`/exchange/files/download/${bad}`)).status,
      ).toBe(400);
    }
    expect(seen.method).toBeUndefined();
  });

  it("requires a Content-Length no larger than a listing file", async () => {
    const tooLarge = await request(app)
      .put(`/exchange/files/upload/${TOKEN}`)
      .set("Content-Type", "text/csv")
      .set("Content-Length", String(EXCHANGE_FILE_MAX_BYTES + 1))
      .send("x");
    expect(tooLarge.status).toBe(413);

    // Chunked, so no length at all.
    const port = await new Promise<number>(resolve => {
      const server = app.listen(0, () => {
        resolve((server.address() as AddressInfo).port);
        setTimeout(() => server.close(), 2000).unref();
      });
    });
    const status = await new Promise<number>((resolve, reject) => {
      const put = http.request(
        {
          host: "127.0.0.1",
          port,
          method: "PUT",
          path: `/exchange/files/upload/${TOKEN}`,
          headers: {
            "content-type": "text/csv",
            "transfer-encoding": "chunked",
          },
        },
        res => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      put.on("error", reject);
      put.write("abc");
      put.end();
    });
    expect(status).toBe(411);
    expect(seen.method).toBeUndefined();
  });

  it("answers a preflight only for the website and its previews", async () => {
    for (const origin of [
      "https://www.firecrawl.dev",
      "https://firecrawl.dev",
      "https://firecrawl-web-git-feature-x-side-guide.vercel.app",
    ]) {
      const res = await request(app)
        .options(`/exchange/files/upload/${TOKEN}`)
        .set("Origin", origin)
        .set("Access-Control-Request-Method", "PUT")
        .set("Access-Control-Request-Headers", "content-type");
      expect(res.status, origin).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBe(origin);
      expect(res.headers["access-control-allow-methods"]).toBe(
        "PUT,GET,OPTIONS",
      );
      expect(res.headers["access-control-allow-headers"]).toBe("Content-Type");
    }
    for (const origin of [
      "https://evil.example",
      "https://firecrawl.dev.evil.example",
      "https://evil.vercel.app",
    ]) {
      const res = await request(app)
        .options(`/exchange/files/download/${TOKEN}`)
        .set("Origin", origin)
        .set("Access-Control-Request-Method", "GET");
      expect(
        res.headers["access-control-allow-origin"],
        origin,
      ).toBeUndefined();
    }
    // A real request from another origin is not given the catch-all wildcard either.
    const other = await request(app)
      .get(`/exchange/files/download/${TOKEN}`)
      .set("Origin", "https://evil.example");
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("says plainly when Exchange is not configured", async () => {
    const before = config.FIRE_EXCHANGE_URL;
    config.FIRE_EXCHANGE_URL = undefined;
    try {
      expect(
        (await request(app).get(`/exchange/files/download/${TOKEN}`)).status,
      ).toBe(503);
    } finally {
      config.FIRE_EXCHANGE_URL = before;
    }
  });
});
