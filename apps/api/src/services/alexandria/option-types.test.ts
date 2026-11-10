const exchangeRequest = vi.hoisted(() => vi.fn());
vi.mock("./client", () => ({ exchangeRequest }));
import { capabilityOptionTypes, clearOptionTypeCache } from "./option-types";

const input = {
  teamId: "team",
  provider: "fred",
  capability: "series/observations",
  connectors: false,
  timeoutMs: 5_000,
};

beforeEach(() => {
  clearOptionTypeCache();
  exchangeRequest.mockReset();
  exchangeRequest.mockResolvedValue({
    status: 200,
    body: {
      success: true,
      creditsCost: 0,
      data: {
        items: [
          {
            provider: "fred",
            capability: "series/observations",
            options: [{ name: "limit", type: "number" }],
          },
        ],
      },
    },
  });
});

it("reads option types from a free find-tools lookup and caches them per team", async () => {
  expect(await capabilityOptionTypes(input)).toEqual(
    new Map([["limit", "number"]]),
  );
  await capabilityOptionTypes(input);
  expect(exchangeRequest).toHaveBeenCalledTimes(1);
  expect(exchangeRequest).toHaveBeenCalledWith(
    expect.objectContaining({
      path: "/v1/retrieve",
      maximumCredits: 0,
      body: expect.objectContaining({
        provider: "firecrawl",
        capability: "find-tools",
        options: expect.objectContaining({
          providers: ["fred"],
          capabilities: ["series/observations"],
          expand: ["options"],
        }),
      }),
    }),
  );
  await capabilityOptionTypes({ ...input, teamId: "other" });
  expect(exchangeRequest).toHaveBeenCalledTimes(2);
});

it("answers an empty map for an unknown capability and throws when the lookup fails", async () => {
  expect(
    await capabilityOptionTypes({ ...input, capability: "missing" }),
  ).toEqual(new Map());
  exchangeRequest.mockResolvedValue({ status: 503, body: {} });
  await expect(
    capabilityOptionTypes({ ...input, teamId: "fresh" }),
  ).rejects.toThrow();
});

it("answers for a provider alias and maps option aliases to their type", async () => {
  exchangeRequest.mockResolvedValue({
    status: 200,
    body: {
      success: true,
      data: {
        items: [
          {
            provider: "fred",
            capability: "series/observations",
            options: [{ name: "limit", type: "number", aliases: ["max"] }],
          },
        ],
      },
    },
  });
  expect(
    await capabilityOptionTypes({ ...input, provider: "fred-alias" }),
  ).toEqual(
    new Map([
      ["limit", "number"],
      ["max", "number"],
    ]),
  );
});
