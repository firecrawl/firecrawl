import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExchangeProxyError } from "../lib/exchange-proxy";
import { searchExchangeCatalog } from "./exchange-source";

vi.mock("../lib/exchange-proxy", async importOriginal => ({
  ...(await importOriginal<typeof import("../lib/exchange-proxy")>()),
  forwardToExchange: vi.fn(),
}));

import { forwardToExchange } from "../lib/exchange-proxy";
const forward = vi.mocked(forwardToExchange);
const logger = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as any;

describe("exchange search source", () => {
  beforeEach(() => forward.mockReset());

  it("asks the catalogue with the query and maps address to capability", async () => {
    forward.mockResolvedValueOnce({
      status: 200,
      contentType: "application/json",
      requestId: null,
      body: {
        capabilities: [
          {
            address: "prices/latest",
            provider: "financial-datasets",
            concept: "prices",
            cohorts: ["finance"],
            creditsCost: 1,
            similarity: 0.83,
          },
        ],
      },
    });

    const results = await searchExchangeCatalog(
      {
        query: "latest stock price by ticker",
        limit: 10,
        teamId: "team_a",
        requestId: "rid",
      },
      logger,
    );

    expect(forward).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: "team_a",
        method: "GET",
        path: "/v1/discover?q=latest%20stock%20price%20by%20ticker&limit=10",
        requestId: "rid",
      }),
    );

    expect(results).toEqual([
      {
        provider: "financial-datasets",
        capability: "prices/latest",
        concept: "prices",
        cohorts: ["finance"],
        creditsCost: 1,
        similarity: 0.83,
      },
    ]);
  });

  it("keeps the valid capabilities when one entry is malformed", async () => {
    forward.mockResolvedValueOnce({
      status: 200,
      contentType: null,
      requestId: null,
      body: {
        capabilities: [
          {
            address: "prices/latest",
            provider: "financial-datasets",
            creditsCost: 1,
          },
          { address: "broken", provider: "x", creditsCost: 1.5 },
          { provider: "no-address", creditsCost: 1 },
        ],
      },
    });
    const results = await searchExchangeCatalog(
      { query: "q", limit: 5, teamId: "t" },
      logger,
    );
    expect(results?.map(r => r.capability)).toEqual(["prices/latest"]);
    expect(logger.warn).toHaveBeenCalledWith(
      "Exchange catalogue search dropped malformed entries",
      { dropped: 2, kept: 1 },
    );
  });

  it("answers null rather than throwing on a query that cannot be encoded", async () => {
    const lone = "price \ud800";
    expect(
      await searchExchangeCatalog(
        { query: lone, limit: 5, teamId: "t" },
        logger,
      ),
    ).toBeNull();
    expect(forward).not.toHaveBeenCalled();
  });

  it("never waits longer than the caller's own timeout", async () => {
    forward.mockResolvedValueOnce({
      status: 200,
      contentType: null,
      requestId: null,
      body: { capabilities: [] },
    });
    await searchExchangeCatalog(
      { query: "q", limit: 5, teamId: "t", timeoutMs: 3_000 },
      logger,
    );
    expect(forward.mock.calls[0]![0].timeoutMs).toBe(3_000);

    forward.mockResolvedValueOnce({
      status: 200,
      contentType: null,
      requestId: null,
      body: { capabilities: [] },
    });
    await searchExchangeCatalog(
      { query: "q", limit: 5, teamId: "t", timeoutMs: 60_000 },
      logger,
    );
    expect(forward.mock.calls[1]![0].timeoutMs).toBe(10_000);
  });

  it("clamps the limit to the Exchange's ceiling", async () => {
    forward.mockResolvedValueOnce({
      status: 200,
      contentType: null,
      requestId: null,
      body: { capabilities: [] },
    });
    await searchExchangeCatalog(
      { query: "q", limit: 100, teamId: "t" },
      logger,
    );
    expect(forward.mock.calls[0]![0].path).toBe("/v1/discover?q=q&limit=24");
  });

  it("answers null, not an empty catalogue, when the Exchange cannot answer", async () => {
    forward.mockResolvedValueOnce({
      status: 503,
      contentType: null,
      requestId: null,
      body: { code: "semantic_unavailable" },
    });
    expect(
      await searchExchangeCatalog(
        { query: "q", limit: 5, teamId: "t" },
        logger,
      ),
    ).toBeNull();

    forward.mockRejectedValueOnce(new ExchangeProxyError("timeout"));
    expect(
      await searchExchangeCatalog(
        { query: "q", limit: 5, teamId: "t" },
        logger,
      ),
    ).toBeNull();

    forward.mockResolvedValueOnce({
      status: 200,
      contentType: null,
      requestId: null,
      body: { nope: true },
    });
    expect(
      await searchExchangeCatalog(
        { query: "q", limit: 5, teamId: "t" },
        logger,
      ),
    ).toBeNull();
  });
});
