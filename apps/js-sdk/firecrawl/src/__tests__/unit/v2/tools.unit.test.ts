import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { createServer, type Server } from "node:http";
import { FirecrawlClient } from "../../../v2/client";

const tool = {
  id: "particle/podcasts/episodes/search",
  provider: "particle",
  capability: "podcasts/episodes/search",
  name: "Episode search",
  description: "Find episodes",
  creditsCost: 15,
  perRecord: false,
  options: [{ name: "semantic_search", type: "string" }],
  response: { about: "Episodes", key: "data", fields: [] },
  examples: { javascript: "example", python: "example", curl: "example" },
  matchedBy: ["semantic", "domain"],
  matchedUrls: ["https://podcasts.apple.com"],
};
const next = {
  provider: "firecrawl-contextual-discovery",
  capability: "discovery/context",
  options: { providers: ["particle"], level: "tools" },
};
let server: Server;
let client: FirecrawlClient;
const sent: Array<{ body: any; id: string | undefined }> = [];
let attempts = 0;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    sent.push({ body, id: req.headers["x-request-id"] as string | undefined });
    res.setHeader("content-type", "application/json");
    if (req.url === "/v2/search")
      return res.end(
        JSON.stringify({
          success: true,
          warning: "Example warning",
          data: { web: [{ url: "https://podcasts.apple.com" }], tools: [tool] },
        }),
      );
    if (body.exchange[0].provider === "retry" && attempts++ === 0) {
      res.statusCode = 502;
      return res.end("{}");
    }
    if (body.exchange[0].provider === "denied") {
      res.statusCode = 402;
      return res.end(
        JSON.stringify({
          success: false,
          code: "insufficient_credits",
          error: "Insufficient credits",
        }),
      );
    }
    const exchange =
      body.exchange[0].provider === "firecrawl-contextual-discovery"
        ? [
            {
              ...next,
              creditsCost: 0,
              data: {
                level: "providers",
                items: [{ id: "particle", name: "Particle", next }],
                total: 1,
                next: null,
              },
            },
          ]
        : [
            {
              provider: "retry",
              capability: "a/b",
              creditsCost: 15,
              data: { nested: { value: 1 } },
            },
            {
              provider: "x",
              capability: "b",
              error: {
                code: "unavailable",
                message: "Unavailable",
                status: 503,
              },
            },
          ];
    res.end(
      JSON.stringify({
        success: true,
        scrape_id: "scrape-1",
        data: { exchange, creditsCost: exchange.length === 1 ? 0 : 15 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  client = new FirecrawlClient({
    apiKey: "fc-test",
    apiUrl: `http://127.0.0.1:${port}`,
    backoffFactor: 0,
  });
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("Alexandria contracts and execution", () => {
  test("returns complete unified tools and warning beside web results", async () => {
    const result = await client.search("podcasts", {
      sources: ["web", { type: "alexandria" }],
      skills: true,
      limit: 2,
    });
    expect(result.tools).toEqual([tool]);
    expect(result.warning).toBe("Example warning");
    expect(sent.at(-1)?.body).toMatchObject({
      skills: true,
      sources: ["web", { type: "alexandria" }],
    });
    expect(result).not.toHaveProperty("alexandria");
  });
  test("retains one ID through transport retries and per-tool failures", async () => {
    const result = await client.scrape({
      exchange: [{ provider: "retry", capability: "a/b" }],
      requestId: "same-request",
    });
    const retries = sent.filter(
      (r) => r.body.exchange?.[0].provider === "retry",
    );
    expect(retries).toHaveLength(2);
    expect(retries.map((r) => r.id)).toEqual(["same-request", "same-request"]);
    expect(retries[0].body).not.toHaveProperty("requestId");
    expect(result.requestId).toBe("same-request");
    expect(result.creditsCost).toBe(15);
    expect(result.exchange[1].error?.code).toBe("unavailable");
  });
  test("returns an error code and retry identity on failed execution", async () => {
    await expect(
      client.scrape({
        exchange: { provider: "denied", capability: "a/b" },
        requestId: "denied-1",
      }),
    ).rejects.toMatchObject({
      status: 402,
      code: "insufficient_credits",
      requestId: "denied-1",
    });
  });
  test("walks with Find Tools and feeds next directly into scrape", async () => {
    const found = await client.findTools({ providers: ["particle"], limit: 2 });
    const result = await client.scrape({ exchange: found.items[0].next! });
    expect(result.creditsCost).toBe(0);
    expect(sent.at(-1)?.id).toBeTruthy();
    expect(sent.at(-1)?.body.exchange).toEqual([next]);
  });
  test("rejects URL options and queryless browsing before dispatch", async () => {
    const count = sent.length;
    await expect(
      client.scrape({ exchange: next, url: "https://example.com" } as any),
    ).rejects.toThrow();
    await expect(
      client.search("", { sources: ["alexandria"] }),
    ).rejects.toThrow("Query cannot be empty");
    expect(sent).toHaveLength(count);
  });
});
