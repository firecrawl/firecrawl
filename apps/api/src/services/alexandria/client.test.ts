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

  it("sends the billing organization only when known, apart from the terms identity", async () => {
    await exchangeRequest({
      teamId: "team",
      path: "/v1/retrieve",
      body: {},
      timeoutMs: 1000,
      billingOrganizationId: "org",
    });
    expect(headersOf()["x-exchange-billing-organization-id"]).toBe("org");
    expect(headersOf()).not.toHaveProperty("x-exchange-organization-id");
    expect(headersOf()).not.toHaveProperty("x-exchange-api-key-id");

    mocks.fetch.mockClear();
    await exchangeRequest({
      teamId: "team",
      path: "/v1/retrieve",
      body: {},
      timeoutMs: 1000,
      termsIdentity: { organizationId: "org", apiKeyId: "key" },
    });
    expect(headersOf()).toMatchObject({
      "x-exchange-organization-id": "org",
      "x-exchange-api-key-id": "key",
    });
    expect(headersOf()).not.toHaveProperty(
      "x-exchange-billing-organization-id",
    );
  });

  it("marks the team Alexandria Verified only when set", async () => {
    await exchangeRequest({
      teamId: "team",
      path: "/v1/retrieve",
      body: {},
      timeoutMs: 1000,
      alexandriaVerified: true,
    });
    expect(headersOf()["x-exchange-alexandria-verified"]).toBe("true");

    mocks.fetch.mockClear();
    await exchangeRequest({
      teamId: "team",
      path: "/v1/retrieve",
      body: {},
      timeoutMs: 1000,
    });
    expect(headersOf()).not.toHaveProperty("x-exchange-alexandria-verified");
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

  it("says whether feedback may be stored only when told", async () => {
    await exchangeRequest({
      teamId: "team",
      path: "/v1/retrieve",
      body: {},
      timeoutMs: 1000,
      feedbackStorage: "opted_out",
    });
    expect(headersOf()["x-exchange-feedback-storage"]).toBe("opted_out");

    mocks.fetch.mockClear();
    await exchangeRequest({
      teamId: "team",
      path: "/v1/retrieve",
      body: {},
      timeoutMs: 1000,
    });
    expect(headersOf()).not.toHaveProperty("x-exchange-feedback-storage");
  });

  it.each([
    ["mcp-cursor", "mcp-cursor"],
    [" MCP-Claude-Code@3.40.0 ", "mcp-claude-code-3.40.0"],
    ["cli.codex/1_2", "cli.codex/1_2"],
    ["a\r\nx-injected: 1", "a-x-injected-1"],
    ["a".repeat(80), "a".repeat(64)],
  ])(
    "sends the caller's origin and integration as short tokens (%j)",
    async (sent, token) => {
      await exchangeRequest({
        teamId: "team",
        path: "/v1/retrieve",
        body: {},
        timeoutMs: 1000,
        clientOrigin: sent,
        clientIntegration: sent,
      });
      expect(headersOf()["x-exchange-client-origin"]).toBe(token);
      expect(headersOf()["x-exchange-client-integration"]).toBe(token);
    },
  );

  it.each([undefined, null, "", "   ", "@@@", "--"])(
    "sends no origin or integration when it is unknown (%j)",
    async sent => {
      await exchangeRequest({
        teamId: "team",
        path: "/v1/retrieve",
        body: {},
        timeoutMs: 1000,
        clientOrigin: sent,
        clientIntegration: sent,
      });
      expect(headersOf()).not.toHaveProperty("x-exchange-client-origin");
      expect(headersOf()).not.toHaveProperty("x-exchange-client-integration");
    },
  );

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
