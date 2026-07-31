import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../config", () => ({
  config: {
    EXCHANGE_API_TOKEN: "service-token",
    EXCHANGE_API_URL: "http://exchange.local",
  },
}));

import {
  invokeExchangeCalls,
  quoteExchangeCalls,
  redactExchangeCredentials,
  type ExchangeCall,
} from "../invoke";

const call = {
  provider: "acme",
  capability: "company",
  options: { domain: "firecrawl.dev" },
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("Exchange quote and invoke", () => {
  it("quotes the published price and returns the pending access event", async () => {
    const providerFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            creditsPerCall: 7,
            delivery: "direct",
            readOnly: true,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            accessEventId: "event-1",
            exchangeRequestId: "exchange-request-1",
            data: {
              provider: "acme",
              capability: "company",
              delivery: "direct",
              creditsCost: 7,
              result: { name: "Firecrawl" },
            },
          }),
          { status: 200 },
        ),
      );

    const quotes = await quoteExchangeCalls([call]);
    const results = await invokeExchangeCalls({
      calls: [call],
      quotes,

      teamId: "team-1",
      timeoutMs: 15_000,
      zeroDataRetention: true,
    });

    expect(quotes).toEqual([
      { call, creditsCost: 7, delivery: "direct", readOnly: true },
    ]);
    expect(results).toEqual([
      expect.objectContaining({
        accessEventId: "event-1",
        creditsCost: 7,
        data: { name: "Firecrawl" },
      }),
    ]);
    expect(providerFetch).toHaveBeenNthCalledWith(
      2,
      new URL("/v1/invoke", "http://exchange.local"),
      expect.objectContaining({
        body: expect.any(String),
      }),
    );
    const sent = JSON.parse(
      (providerFetch.mock.calls[1]?.[1] as { body: string }).body,
    );
    expect(sent).toMatchObject({
      provider: call.provider,
      capability: call.capability,
      options: call.options,
      teamId: "team-1",
      zeroDataRetention: true,
    });
    // The caller never supplies one; the service generates it for the audit trail.
    expect(sent.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(sent).not.toHaveProperty("idempotencyKey");
  });

  it("does not invoke when an exact published quote is unavailable", async () => {
    const providerFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 404 }));

    const quotes = await quoteExchangeCalls([call]);
    const results = await invokeExchangeCalls({
      calls: [call],
      quotes,

      teamId: "team-1",
      timeoutMs: 15_000,
      zeroDataRetention: false,
    });

    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(results[0]).toMatchObject({
      error: { code: "exchange_quote_unavailable" },
    });
  });

  it("honours the quote when the price rises after admission", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          accessEventId: "event-1",
          exchangeRequestId: "exchange-request-1",
          data: {
            provider: "acme",
            capability: "company",
            delivery: "direct",
            creditsCost: 8,
            result: { name: "Firecrawl" },
          },
        }),
        { status: 200 },
      ),
    );

    const [result] = await invokeExchangeCalls({
      calls: [call],
      quotes: [{ call, creditsCost: 7 }],

      teamId: "team-1",
      timeoutMs: 15_000,
      zeroDataRetention: false,
    });

    // The provider already ran, so the result is delivered and the quote is
    // honoured rather than the higher price the provider reported.
    expect(result).toMatchObject({
      accessEventId: "event-1",
      creditsCost: 7,
      data: { name: "Firecrawl" },
    });
    expect(result).not.toHaveProperty("error");
  });

  it("passes on a price drop rather than charging the stale quote", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          accessEventId: "event-2",
          exchangeRequestId: "exchange-request-2",
          data: {
            provider: "acme",
            capability: "company",
            delivery: "direct",
            creditsCost: 3,
            result: { name: "Firecrawl" },
          },
        }),
        { status: 200 },
      ),
    );

    const [result] = await invokeExchangeCalls({
      calls: [call],
      quotes: [{ call, creditsCost: 7 }],
      teamId: "team-1",
      timeoutMs: 15_000,
      zeroDataRetention: false,
    });

    expect(result).toMatchObject({ creditsCost: 3 });
    expect(result).not.toHaveProperty("error");
  });
});

describe("redactExchangeCredentials", () => {
  it("removes caller-supplied provider keys before a request body is persisted", () => {
    const body: { query: string; exchange: ExchangeCall[] } = {
      query: "acme",
      exchange: [
        { ...call, providerApiKey: "caller-secret" },
        { ...call, capability: "second" },
      ],
    };

    const redacted = redactExchangeCredentials(body) as typeof body;

    expect(JSON.stringify(redacted)).not.toContain("caller-secret");
    expect(redacted.exchange[0].providerApiKey).toBe("<redacted>");
    expect(redacted.exchange[1]).toEqual(body.exchange[1]);
    expect(redacted.query).toBe("acme");
    expect(body.exchange[0].providerApiKey).toBe("caller-secret");
  });

  it("returns the original body when no call carries a credential", () => {
    const body = { query: "acme", exchange: [call] };
    expect(redactExchangeCredentials(body)).toBe(body);
  });
});
