import { beforeEach, expect, it, vi } from "vitest";
vi.mock("../lib/exchange-proxy", async importOriginal => ({
  ...(await importOriginal<typeof import("../lib/exchange-proxy")>()),
  forwardToExchange: vi.fn(),
}));
import { forwardToExchange } from "../lib/exchange-proxy";
import { searchRequestSchema } from "../controllers/v2/types";
import { searchAlexandria, AlexandriaRequestError } from "./alexandria-source";
const forward = vi.mocked(forwardToExchange);
const logger = { warn: vi.fn() } as any;
beforeEach(() => forward.mockReset());
it("accepts mixed string and structured sources, and requires queries only when needed", () => {
  const input = searchRequestSchema.parse({
    query: "finance",
    sources: ["web", { type: "alexandria", categories: ["finance"] }],
  });
  expect(input.sources.map(source => source.type)).toEqual([
    "web",
    "alexandria",
  ]);
  expect(
    searchRequestSchema.safeParse({
      sources: [
        { type: "alexandria", mode: "browse", providers: ["particle"] },
      ],
    }).success,
  ).toBe(true);
  for (const input of [
    { sources: ["web"] },
    { sources: [{ type: "alexandria", mode: "semantic" }] },
    { query: "q", sources: ["alexandria", "exchange-providers"] },
    {
      query: "q",
      sources: [
        { type: "alexandria", level: "providers", expand: ["options"] },
      ],
    },
    {
      query: "q",
      sources: [{ type: "alexandria", domains: ["https://example.com/path"] }],
    },
  ])
    expect(searchRequestSchema.safeParse(input).success).toBe(false);
});
it("forwards scoped disclosure and pagination, and produces usable follow-up requests", async () => {
  forward.mockResolvedValue({
    status: 200,
    requestId: null,
    contentType: "application/json",
    body: {
      level: "tools",
      mode: "browse",
      total: 13,
      nextCursor: "next",
      items: [
        {
          provider: "particle",
          capability: "podcasts/search",
          requestOptions: [{ name: "query", type: "string", required: true }],
          next: {
            type: "alexandria",
            mode: "browse",
            level: "tools",
            providers: ["particle"],
            capabilities: ["podcasts/search"],
            expand: ["options", "response", "examples"],
          },
        },
      ],
    },
  });
  const result = await searchAlexandria(
    {
      query: "",
      source: {
        type: "alexandria",
        providers: ["particle"],
        level: "tools",
        mode: "browse",
        expand: ["examples"],
        languages: ["javascript", "python", "curl"],
        cursor: "previous",
        limit: 5,
      },
      limit: 10,
      teamId: "team",
      hasExtendedCatalogAccess: true,
    },
    logger,
  );
  const called = forward.mock.calls[0][0];
  const url = new URL(called.path, "https://exchange.example");
  expect(url.searchParams.get("providers")).toBe("particle");
  expect(url.searchParams.get("cursor")).toBe("previous");
  expect(url.searchParams.get("limit")).toBe("5");
  expect(called.hasExtendedCatalogAccess).toBe(true);
  expect(result.nextCursor).toBe("next");
  const examples = result.items[0].examples as Record<string, string>;
  expect(examples.javascript).toContain("await fetch(");
  expect(examples.javascript).toContain('"x-request-id": requestId');
  expect(examples.python).toContain('"<query>"');
  expect(examples.python).toContain('"x-request-id": request_id');
  expect(examples.curl).toContain("x-request-id");
  expect(result.items[0].requestOptions).toBeUndefined();
  expect(searchRequestSchema.safeParse(result.items[0].next).success).toBe(
    true,
  );
});
it("distinguishes a valid empty catalogue from unavailable discovery and invalid cursors", async () => {
  const input = {
    query: "",
    source: { type: "alexandria" as const, mode: "browse" as const },
    limit: 10,
    teamId: "team",
  };
  forward.mockResolvedValueOnce({
    status: 200,
    requestId: null,
    contentType: "application/json",
    body: {
      level: "providers",
      mode: "browse",
      items: [],
      total: 0,
      nextCursor: null,
    },
  });
  expect(await searchAlexandria(input, logger)).toMatchObject({
    status: "available",
    total: 0,
  });
  forward.mockResolvedValueOnce({
    status: 503,
    requestId: null,
    contentType: "application/json",
    body: {},
  });
  expect(await searchAlexandria(input, logger)).toMatchObject({
    status: "unavailable",
    total: null,
  });
  forward.mockResolvedValueOnce({
    status: 400,
    requestId: null,
    contentType: "application/json",
    body: { error: "Cursor expired" },
  });
  await expect(searchAlexandria(input, logger)).rejects.toBeInstanceOf(
    AlexandriaRequestError,
  );
});
