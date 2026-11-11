const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("undici", async importOriginal => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: mocks.fetch,
}));

import { config } from "../../config";
import { exchangeRequest } from "./client";

describe("exchangeRequest", () => {
  const original = config.FIRE_EXCHANGE_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    config.FIRE_EXCHANGE_URL = "https://exchange.test";
    mocks.fetch.mockImplementation(
      async () => new Response(JSON.stringify({ success: true })),
    );
  });

  afterEach(() => {
    config.FIRE_EXCHANGE_URL = original;
  });

  const headersOf = () =>
    (mocks.fetch.mock.calls[0]![1] as { headers: Record<string, string> })
      .headers;

  it("grants the team's own MCP connectors only when asked", async () => {
    await exchangeRequest({
      teamId: "team",
      path: "/v1/retrieve",
      body: {},
      timeoutMs: 1000,
      connectors: true,
    });
    expect(headersOf()).toMatchObject({
      "x-exchange-team-id": "team",
      "x-exchange-connectors": "true",
    });
  });

  it("sends the client IP only when known", async () => {
    await exchangeRequest({
      teamId: "team",
      path: "/v1/retrieve",
      body: {},
      timeoutMs: 1000,
      clientIp: "203.0.113.7",
    });
    expect(headersOf()["x-exchange-client-ip"]).toBe("203.0.113.7");

    mocks.fetch.mockClear();
    await exchangeRequest({
      teamId: "team",
      path: "/v1/retrieve",
      body: {},
      timeoutMs: 1000,
    });
    expect(headersOf()).not.toHaveProperty("x-exchange-client-ip");
  });

  it("sends the billing country only when known", async () => {
    await exchangeRequest({
      teamId: "team",
      path: "/v1/retrieve",
      body: {},
      timeoutMs: 1000,
      billingCountry: "DE",
    });
    expect(headersOf()["x-exchange-billing-country"]).toBe("DE");

    mocks.fetch.mockClear();
    await exchangeRequest({
      teamId: "team",
      path: "/v1/retrieve",
      body: {},
      timeoutMs: 1000,
    });
    expect(headersOf()).not.toHaveProperty("x-exchange-billing-country");
  });

  it("sends no connectors grant by default", async () => {
    await exchangeRequest({
      teamId: "team",
      path: "/v1/retrieve",
      body: {},
      timeoutMs: 1000,
    });
    expect(headersOf()).not.toHaveProperty("x-exchange-connectors");
  });

  it("asks for zero data retention only when set", async () => {
    await exchangeRequest({
      teamId: "team",
      path: "/v1/retrieve",
      body: {},
      timeoutMs: 1000,
      zeroDataRetention: true,
    });
    expect(headersOf()).toMatchObject({
      "x-exchange-zero-data-retention": "true",
    });
    mocks.fetch.mockClear();
    await exchangeRequest({
      teamId: "team",
      path: "/v1/retrieve",
      body: {},
      timeoutMs: 1000,
    });
    expect(headersOf()).not.toHaveProperty("x-exchange-zero-data-retention");
  });

  it("sends the deadline as a whole number of milliseconds", async () => {
    await exchangeRequest({
      teamId: "team",
      path: "/v1/retrieve",
      body: {},
      timeoutMs: 12345,
      maximumCredits: 10,
    });
    const deadline = Number(headersOf()["x-exchange-deadline"]);
    expect(Number.isSafeInteger(deadline)).toBe(true);
  });
});
