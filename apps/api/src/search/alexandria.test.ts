import { describe, it, expect, vi, beforeEach } from "vitest";
import { discoverTools } from "./alexandria";
import { exchangeRequest } from "../services/alexandria/client";
vi.mock("../services/alexandria/client", () => ({ exchangeRequest: vi.fn() }));
const request = vi.mocked(exchangeRequest);
const logger = { warn: vi.fn() } as any;
const next = {
  provider: "firecrawl",
  capability: "find-tools",
  options: {
    providers: ["sample"],
    capabilities: ["records/search"],
    expand: ["options", "response", "examples"],
  },
};
const tool = {
  provider: "sample",
  capability: "records/search",
  name: "Records",
  description: "Search records",
  creditsCost: 5,
  perRecord: false,
  options: [{ name: "query", type: "string" }],
  response: { about: "Records", key: "records", fields: [] },
  example: { query: "test" },
  next,
};
const input = { teamId: "team", query: "records", limit: 5, timeoutMs: 10000 };
beforeEach(() => vi.clearAllMocks());
it.each([undefined, "summary", "full"] as const)(
  "supports %s discovery detail",
  async toolDetail => {
    request.mockResolvedValue({
      status: 200,
      body: { success: true, creditsCost: 0, data: { items: [tool] } },
    });
    const result = await discoverTools({ ...input, toolDetail }, logger);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0].body).toMatchObject({
      provider: "firecrawl",
      capability: "find-tools",
      options: {
        query: "records",
        expand:
          toolDetail === "full" ? ["options", "response", "examples"] : [],
      },
    });
    expect(result.items[0]).toMatchObject({
      id: "sample/records/search",
      matchedBy: ["semantic"],
    });
    if (toolDetail === "full")
      expect(result.items[0]).toMatchObject({
        options: tool.options,
        response: tool.response,
      });
    else {
      expect(result.items[0]).toMatchObject({ next });
      for (const field of ["options", "response", "example"])
        expect(result.items[0]).not.toHaveProperty(field);
    }
  },
);
it("keeps a warning when discovery fails", async () => {
  request.mockResolvedValue({ status: 503, body: {} });
  const result = await discoverTools(input, logger);
  expect(result.items).toEqual([]);
  expect(result.warning).toBeTruthy();
});
it("deduplicates semantic and domain summaries and preserves inspection", async () => {
  request.mockImplementation(async args =>
    args.path === "/v1/skills/resolve"
      ? {
          status: 200,
          body: {
            skills: [
              {
                id: "sample",
                matchedDomains: ["example.com"],
                domainCapabilities: { "example.com": ["records/search"] },
              },
            ],
          },
        }
      : {
          status: 200,
          body: { success: true, creditsCost: 0, data: { items: [tool] } },
        },
  );
  const result = await discoverTools(
    { ...input, urls: ["https://example.com/records"] },
    logger,
  );
  expect(result.items).toHaveLength(1);
  expect(result.items[0]).toMatchObject({
    matchedBy: ["semantic", "domain"],
    matchedUrls: ["https://example.com/records"],
    next,
  });
  expect(result.items[0]).not.toHaveProperty("options");
  expect(
    request.mock.calls
      .filter(([args]) => args.path === "/v1/retrieve")
      .map(([args]) => (args.body as any).options.expand),
  ).toEqual([[], []]);
});
