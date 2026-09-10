import { afterEach, expect, it, vi } from "vitest";
import { robustFetch } from "../lib/fetch";
import { scrapeURLWithExchange } from "./exchange";

vi.mock("../../../config", () => ({
  config: { FIRE_EXCHANGE_URL: "https://exchange.internal" },
}));
vi.mock("../lib/fetch", () => ({ robustFetch: vi.fn() }));
vi.mock("../../../lib/exchange", () => ({
  getExchangeRequestLogContext: () => ({}),
  getExchangeResponseLogContext: () => ({}),
}));
vi.mock("../../../lib/otel-tracer", () => ({
  withSpan: (_name: string, run: () => unknown) => run(),
  setSpanAttributes: vi.fn(),
}));

afterEach(() => vi.clearAllMocks());

it.each([true, false, undefined])(
  "carries only authenticated extended catalogue access %s into legacy record retrieval",
  async access => {
    const logger = { child: () => logger, info: vi.fn(), warn: vi.fn() };
    vi.mocked(robustFetch).mockResolvedValue({
      success: true,
      creditsCost: 0,
      data: { markdown: "Record", metadata: {}, source: { provider: "test" } },
    });
    await scrapeURLWithExchange({
      id: "job-1",
      url: "https://records.example/item",
      options: {
        headers: {
          "x-exchange-team-id": "spoofed",
          "x-exchange-extended-catalog-access": "true",
        },
      },
      internalOptions: {
        teamId: "real-team",
        teamFlags: { exchangeRetrieve: access },
      },
      logger,
      mock: null,
      abort: { asSignal: () => new AbortController().signal },
    } as unknown as Parameters<typeof scrapeURLWithExchange>[0]);
    expect(robustFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://exchange.internal/v1/scrape",
        headers: {
          "x-exchange-team-id": "real-team",
          "x-exchange-extended-catalog-access": String(access === true),
        },
      }),
    );
  },
);
