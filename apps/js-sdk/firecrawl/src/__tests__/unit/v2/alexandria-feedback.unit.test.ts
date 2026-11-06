import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import { FirecrawlClient, collectFeedbackTokens } from "../../../index";

let server: Server;
let client: FirecrawlClient;
const sent: Array<{ url?: string; body: any }> = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };

const feedbackResponse = {
  success: true,
  feedbackId: "feedback-1",
  creditsRefunded: 0,
};
const base = {
  rating: "good" as const,
  requestedWebsite: {
    url: "https://example.com",
    requestedFunctionality: "Find episodes",
  },
  rationale: "Returned what was needed",
};

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    sent.push({ url: req.url, body });
    res.setHeader("content-type", "application/json");
    if (req.url === "/v2/feedback") {
      res.statusCode = reply.status;
      return res.end(JSON.stringify(reply.body));
    }
    const provider = body.alexandria[0].provider;
    const alexandria =
      provider === "firecrawl"
        ? [
            {
              provider,
              capability: "find-tools",
              creditsCost: 0,
              feedbackToken: "meta-token",
              data: { level: "providers", items: [], total: 0, next: null },
            },
          ]
        : [
            {
              provider: "particle",
              capability: "a/b",
              creditsCost: 15,
              feedbackToken: "token-ok",
              data: {},
            },
            {
              provider: "x",
              capability: "b",
              feedbackToken: "token-error",
              error: { code: "unavailable", message: "Unavailable" },
            },
            { provider: "y", capability: "c", creditsCost: 1, data: {} },
          ];
    res.end(
      JSON.stringify({
        success: true,
        scrape_id: "scrape-1",
        data: { alexandria, creditsCost: 15 },
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
beforeEach(() => {
  sent.length = 0;
  reply = { status: 200, body: feedbackResponse };
});

describe("Alexandria feedback tokens", () => {
  test("scrape keeps feedbackToken on successful and errored results", async () => {
    const result = await client.scrape({
      alexandria: [
        { provider: "particle", capability: "a/b" },
        { provider: "x", capability: "b" },
        { provider: "y", capability: "c" },
      ],
    });
    expect(result.alexandria.map((item) => item.feedbackToken)).toEqual([
      "token-ok",
      "token-error",
      undefined,
    ]);
  });

  test("findTools passes through the token of the meta call", async () => {
    const found = await client.findTools({ providers: ["particle"] });
    expect(found.feedbackToken).toBe("meta-token");
  });

  test("collectFeedbackTokens skips missing, dedupes, and keeps the newest 20", () => {
    const results = Array.from({ length: 25 }, (_, i) => ({
      feedbackToken: `t${i}`,
    }));
    const collected = collectFeedbackTokens([
      { feedbackToken: "dup" },
      {},
      undefined,
      ...results,
      { feedbackToken: "dup" },
    ]);
    expect(collected).toHaveLength(20);
    expect(collected.at(-1)).toBe("dup");
    expect(collected.at(-2)).toBe("t24");
    expect(collected[0]).toBe("t6");
    expect(collectFeedbackTokens([{}, { feedbackToken: "" }])).toEqual([]);
  });
});

describe("alexandriaFeedback", () => {
  test("posts endpoint alexandria with tokens and callRatings", async () => {
    reply.body = { ...feedbackResponse, rejectedTokens: 1 };
    const response = await client.alexandriaFeedback({
      ...base,
      objective: "Find episodes",
      tokens: ["a", "b"],
      callRatings: [{ token: "c", rating: "bad" }],
      providerFeedback: [
        { name: "particle", issue: "insufficient_coverage", why: "Gaps" },
      ],
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("/v2/feedback");
    expect(sent[0].body).toMatchObject({
      endpoint: "alexandria",
      rating: "good",
      requestedWebsite: base.requestedWebsite,
      rationale: base.rationale,
      objective: "Find episodes",
      tokens: ["a", "b"],
      callRatings: [{ token: "c", rating: "bad" }],
      providerFeedback: [
        { name: "particle", issue: "insufficient_coverage", why: "Gaps" },
      ],
    });
    expect(typeof sent[0].body.origin).toBe("string");
    expect(response.rejectedTokens).toBe(1);
    expect(response.feedbackId).toBe("feedback-1");
  });

  test("works without tokens, as before", async () => {
    const response = await client.alexandriaFeedback(base);
    expect(sent[0].body).not.toHaveProperty("tokens");
    expect(sent[0].body).not.toHaveProperty("callRatings");
    expect(response.rejectedTokens).toBeUndefined();
  });

  test("accepts exactly 20 tokens and 20 callRatings", async () => {
    await client.alexandriaFeedback({
      ...base,
      tokens: Array.from({ length: 20 }, (_, i) => `t${i}`),
      callRatings: Array.from({ length: 20 }, (_, i) => ({
        token: `c${i}`,
        rating: "partial" as const,
      })),
    });
    expect(sent[0].body.tokens).toHaveLength(20);
    expect(sent[0].body.callRatings).toHaveLength(20);
  });

  test("accepts a token of exactly 1024 characters", async () => {
    await client.alexandriaFeedback({ ...base, tokens: ["x".repeat(1024)] });
    expect(sent[0].body.tokens[0]).toHaveLength(1024);
  });

  test("requires requestedFunctionality for new_capability_request", async () => {
    const entry = {
      name: "episodes",
      provider: "particle",
      issue: "new_capability_request" as const,
      why: "Needed",
    };
    await expect(
      client.alexandriaFeedback({
        ...base,
        capabilityFeedback: [entry as any],
      }),
    ).rejects.toThrow("requestedFunctionality is required");
    expect(sent).toHaveLength(0);
    await client.alexandriaFeedback({
      ...base,
      capabilityFeedback: [{ ...entry, requestedFunctionality: "Dates" }],
    });
    expect(sent[0].body.capabilityFeedback[0].requestedFunctionality).toBe(
      "Dates",
    );
  });

  test.each([
    ["21 tokens", { tokens: Array.from({ length: 21 }, (_, i) => `t${i}`) }, "tokens accepts at most 20"],
    [
      "21 callRatings",
      { callRatings: Array.from({ length: 21 }, (_, i) => ({ token: `c${i}`, rating: "good" as const })) },
      "callRatings accepts at most 20",
    ],
    ["empty token", { tokens: [""] }, "tokens[0] must be a string"],
    ["oversized token", { tokens: ["x".repeat(1025)] }, "tokens[0] must be a string"],
    [
      "invalid call rating",
      { callRatings: [{ token: "a", rating: "great" as any }] },
      "rating must be one of",
    ],
    ["invalid rating", { rating: "great" as any }, "rating must be one of"],
  ])("rejects %s before dispatch", async (_name, override, message) => {
    await expect(
      client.alexandriaFeedback({ ...base, ...override }),
    ).rejects.toThrow(message);
    expect(sent).toHaveLength(0);
  });

  test("surfaces API errors", async () => {
    reply = { status: 400, body: { success: false, error: "Invalid request" } };
    await expect(client.alexandriaFeedback(base)).rejects.toMatchObject({
      status: 400,
    });
  });
});
