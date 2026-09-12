const request = vi.hoisted(() => vi.fn());
vi.mock("../services/alexandria/client", () => ({ exchangeRequest: request }));
import { discoverTools } from "./alexandria";
const logger = { warn: vi.fn() } as any;
const tool = {
  provider: "fred",
  capability: "series/observations",
  name: "Observations",
  description: "Get observations",
  creditsCost: 3,
  perRecord: false,
  options: [{ name: "series_id", type: "string", required: true }],
  response: { about: "Time series", key: "observations", fields: [] },
};
const hit = {
  provider: tool.provider,
  address: tool.capability,
  cohorts: ["finance"],
};
beforeEach(() => {
  vi.clearAllMocks();
  request.mockImplementation(async input => ({
    status: 200,
    body: input.path.startsWith("/v1/discover?")
      ? { capabilities: [hit] }
      : input.path.startsWith("/v1/discover/")
        ? {
            ...tool,
            label: tool.name,
            whenToUse: tool.description,
            returns: tool.response,
            attribution: "FRED",
          }
        : input.path === "/v1/skills/resolve"
          ? {
              skills: [
                {
                  id: "fred",
                  matchedDomains: ["fred.stlouisfed.org"],
                  domainCapabilities: {
                    "fred.stlouisfed.org": [tool.capability],
                  },
                },
              ],
            }
          : { success: true, creditsCost: 0, data: { items: [tool] } },
  }));
});
const discover = (extra: Record<string, unknown>) =>
  discoverTools(
    { teamId: "team", limit: 3, timeoutMs: 10000, ...extra },
    logger,
  );

it("returns real semantic contracts including attribution", async () => {
  const result = await discover({ query: "GDP" });
  expect(result.status).toBe("available");
  expect(result.items[0]).toEqual(
    expect.objectContaining({
      ...tool,
      attribution: "FRED",
      matchedBy: ["semantic"],
      matchedUrls: [],
    }),
  );
  expect(request.mock.calls.every(([input]) => input.teamId === "team")).toBe(
    true,
  );
});

it("merges semantic and domain matches without duplicating tools", async () => {
  const result = await discover({
    query: "GDP",
    urls: ["https://fred.stlouisfed.org/series/GDP", "https://example.com"],
  });
  expect(result.items).toHaveLength(1);
  expect(result.items[0]).toEqual(
    expect.objectContaining({
      matchedBy: ["semantic", "domain"],
      matchedUrls: ["https://fred.stlouisfed.org/series/GDP"],
    }),
  );
  expect(request).toHaveBeenLastCalledWith(
    expect.objectContaining({
      maximumCredits: 0,
      body: expect.objectContaining({
        options: expect.objectContaining({
          capabilities: [tool.capability],
          expand: ["options", "response", "examples"],
        }),
      }),
    }),
  );
});

it("does not send credential-bearing or non-HTTP URLs", async () => {
  await discover({
    urls: [
      "file:///tmp/secret",
      "https://user:secret@example.com",
      "not a url",
    ],
  });
  expect(request).not.toHaveBeenCalled();
});

it("keeps semantic results when domain lookup fails", async () => {
  const implementation = request.getMockImplementation()!;
  request.mockImplementation(input =>
    input.path.includes("skills")
      ? Promise.reject(new Error("offline"))
      : implementation(input),
  );
  const result = await discover({
    query: "GDP",
    urls: ["https://fred.stlouisfed.org/series/GDP"],
  });
  expect(result.items).toHaveLength(1);
  expect(result.warning).toBeDefined();
});

it("rejects an unexpected contract identity", async () => {
  request.mockImplementation(async input => ({
    status: 200,
    body: input.path.includes("?")
      ? { capabilities: [hit] }
      : {
          ...tool,
          provider: "other",
          label: tool.name,
          whenToUse: tool.description,
          returns: tool.response,
        },
  }));
  expect((await discover({ query: "GDP" })).items).toEqual([]);
});

it("rejects billed catalogue lookup", async () => {
  const implementation = request.getMockImplementation()!;
  request.mockImplementation(async input =>
    input.path === "/v1/retrieve"
      ? {
          status: 200,
          body: { success: true, creditsCost: 1, data: { items: [tool] } },
        }
      : implementation(input),
  );
  expect(
    (await discover({ urls: ["https://fred.stlouisfed.org/series/GDP"] }))
      .items,
  ).toEqual([]);
});

it("handles provider-level mappings without a separate compatibility adapter", async () => {
  const implementation = request.getMockImplementation()!;
  request.mockImplementation(async input =>
    input.path.includes("skills")
      ? {
          status: 200,
          body: {
            skills: [{ id: "fred", matchedDomains: ["fred.stlouisfed.org"] }],
          },
        }
      : implementation(input),
  );
  expect(
    (await discover({ urls: ["https://fred.stlouisfed.org/"] })).items,
  ).toHaveLength(1);
});

it("does not invent capabilities for an explicitly empty mapping", async () => {
  request.mockResolvedValue({
    status: 200,
    body: {
      skills: [
        {
          id: "fred",
          matchedDomains: ["fred.stlouisfed.org"],
          domainCapabilities: {},
        },
      ],
    },
  });
  expect(
    (await discover({ urls: ["https://fred.stlouisfed.org/"] })).items,
  ).toEqual([]);
  expect(request).toHaveBeenCalledTimes(1);
});
