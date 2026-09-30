const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  known: vi.fn(),
}));
vi.mock("undici", () => ({ Agent: class {}, fetch: mocks.fetch }));
vi.mock("../../config", () => ({
  config: { FIRE_EXCHANGE_URL: "https://exchange.example/" },
}));
vi.mock("../autumn/autumn.service", () => ({
  autumnService: { getKnownRateLimitMultiplier: mocks.known },
}));
vi.mock("ioredis", () => ({
  default: class {
    defineCommand() {}
  },
}));
import { exchangePlanTier, exchangeRequest } from "./client";

const sent = () => mocks.fetch.mock.calls.at(-1)!;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("exchangeRequest", () => {
  it("sends the plan header and returns the upstream Retry-After", async () => {
    mocks.fetch.mockResolvedValue(
      new Response(JSON.stringify({ code: "provider_rate_limited" }), {
        status: 429,
        headers: { "retry-after": "7" },
      }),
    );
    const response = await exchangeRequest({
      teamId: "team",
      path: "/v1/retrieve",
      body: { requests: [] },
      timeoutMs: 1000,
      plan: "growth",
    });
    expect(sent()[0]).toBe("https://exchange.example/v1/retrieve");
    expect(sent()[1].headers).toEqual(
      expect.objectContaining({
        "x-exchange-team-id": "team",
        "x-exchange-plan": "growth",
      }),
    );
    expect(response).toEqual({
      status: 429,
      body: { code: "provider_rate_limited" },
      retryAfter: "7",
    });
  });

  it("omits the plan header and Retry-After when neither is present", async () => {
    mocks.fetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const response = await exchangeRequest({
      teamId: "team",
      path: "/v1/retrieve",
      body: {},
      timeoutMs: 1000,
    });
    expect(sent()[1].headers).not.toHaveProperty("x-exchange-plan");
    expect(response).toEqual({ status: 200, body: { ok: true } });
  });
});

describe("exchangePlanTier", () => {
  it("maps the team's known multiplier to its plan", async () => {
    mocks.known.mockResolvedValue(500);
    expect(await exchangePlanTier("team", "org")).toBe("growth");
    expect(mocks.known).toHaveBeenCalledWith("team", "org");
  });

  it("is undefined when the multiplier cannot be known", async () => {
    mocks.known.mockResolvedValue(null);
    expect(await exchangePlanTier("team", undefined)).toBeUndefined();
    expect(mocks.known).toHaveBeenCalledWith("team", null);

    mocks.known.mockRejectedValue(new Error("unavailable"));
    expect(await exchangePlanTier("team", "org")).toBeUndefined();
  });
});
