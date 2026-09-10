import { beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../../config";
import { ExchangeProxyError } from "../../lib/exchange-proxy";
import { billExchangeRecord } from "../../lib/exchange-record-billing";
import { exchangeScrapeController } from "./scrape-exchange";

vi.mock("../../lib/exchange-proxy", async importOriginal => ({
  ...(await importOriginal<typeof import("../../lib/exchange-proxy")>()),
  forwardToExchange: vi.fn(),
}));
vi.mock("../../lib/exchange-record-billing", () => ({
  billExchangeRecord: vi.fn(),
}));
vi.mock("../../services/logging/log_job", () => ({
  logRequest: vi.fn(async () => {}),
}));
vi.mock("../../lib/external-request-id", () => ({
  externalRequestId: () => "ext",
}));

import { forwardToExchange } from "../../lib/exchange-proxy";
const forward = vi.mocked(forwardToExchange);

const CALL = {
  provider: "financial-datasets",
  capability: "prices/latest",
  options: { ticker: "NVDA" },
};

function req(
  body: unknown,
  flags: Record<string, unknown> = { exchangeRetrieve: true },
) {
  return {
    body,
    auth: { team_id: "team_a" },
    acuc: { api_key_id: 7, flags },
    headers: {},
  } as any;
}
function res() {
  const out: { status?: number; body?: any } = {};
  const r: any = {
    status: (s: number) => {
      out.status = s;
      return r;
    },
    json: (b: unknown) => {
      out.body = b;
      return r;
    },
  };
  return { r, out };
}

describe("scrape({ exchange })", () => {
  beforeEach(() => {
    forward.mockReset();
    config.FIRE_EXCHANGE_URL = "https://exchange.example";
  });

  it.each([CALL, [CALL]])(
    "normalizes the supported request shape %j and relays results with the cost",
    async exchange => {
      forward.mockResolvedValueOnce({
        status: 200,
        contentType: "application/json",
        requestId: null,
        body: {
          success: true,
          creditsCost: 1,
          results: [{ ...CALL, creditsCost: 1, data: { price: 1 } }],
        },
      });
      const { r, out } = res();

      await exchangeScrapeController(req({ exchange }), r, "job-1");

      expect(forward).toHaveBeenCalledWith(
        expect.objectContaining({
          teamId: "team_a",
          method: "POST",
          path: "/v1/retrieve",
          body: { requests: [CALL] },
          requestId: "job-1",
        }),
      );
      expect(out.status).toBe(200);
      expect(out.body).toEqual({
        success: true,
        scrape_id: "job-1",
        data: {
          exchange: [{ ...CALL, creditsCost: 1, data: { price: 1 } }],
          creditsCost: 1,
        },
      });
    },
  );

  it("refuses a team without the flag, before forwarding, the way /exchange/retrieve does", async () => {
    const { r, out } = res();
    await exchangeScrapeController(req({ exchange: [CALL] }, {}), r, "job-2");
    expect(out.status).toBe(403);
    expect(forward).not.toHaveBeenCalled();
  });

  it("is unavailable without an Exchange URL", async () => {
    config.FIRE_EXCHANGE_URL = "";
    const { r, out } = res();
    await exchangeScrapeController(req({ exchange: [CALL] }), r, "job-3");
    expect(out.status).toBe(503);
  });

  it("rejects an empty list, more than ten, and page-scrape fields, with a field-level message", async () => {
    for (const body of [
      { exchange: [] },
      { exchange: null },
      { exchange: "invalid" },
      { exchange: {} },
      { exchange: { provider: "p" } },
      { exchange: { ...CALL, options: [] } },
      { exchange: CALL, url: "https://x.example" },
      { exchange: Array.from({ length: 11 }, () => CALL) },
      { exchange: [CALL], url: "https://x.example" },
      { exchange: [{ provider: "p" }] },
    ]) {
      const { r, out } = res();
      await exchangeScrapeController(req(body), r, "job-4");
      expect(out.status).toBe(400);
      expect(out.body.error).toMatch(/^Bad Request: /);
    }
    expect(forward).not.toHaveBeenCalled();
  });

  it("relays the Exchange's own error and status", async () => {
    forward.mockResolvedValueOnce({
      status: 400,
      contentType: null,
      requestId: null,
      body: { code: "missing_option", error: "ticker is required" },
    });
    const { r, out } = res();
    await exchangeScrapeController(req({ exchange: [CALL] }), r, "job-5");
    expect(out.status).toBe(400);
    expect(out.body).toEqual({
      success: false,
      code: "missing_option",
      error: "ticker is required",
    });
  });

  it("answers 502 rather than 500 for a failure the proxy did not classify", async () => {
    forward.mockRejectedValueOnce(new Error("something unexpected"));
    const { r, out } = res();
    await exchangeScrapeController(req({ exchange: [CALL] }), r, "job-7");
    expect(out.status).toBe(502);
    expect(out.body).toEqual({
      success: false,
      error: "The request could not be completed.",
    });
  });

  it("maps proxy failures to the proxy's statuses", async () => {
    forward.mockRejectedValueOnce(new ExchangeProxyError("timeout"));
    const { r, out } = res();
    await exchangeScrapeController(req({ exchange: [CALL] }), r, "job-6");
    expect(out.status).toBe(504);
  });
});

describe("Exchange record retrieval", () => {
  const record = {
    url: "firecrawl://exchange/website/pages/123",
    maxCredits: 3,
  };
  const data = {
    id: "123",
    url: record.url,
    title: "Page",
    source: { provider: "website", recordId: "123", recordType: "pages" },
    metadata: {},
    markdown: "Content",
  };
  beforeEach(() => {
    vi.mocked(billExchangeRecord).mockReset();
    forward.mockReset();
    config.FIRE_EXCHANGE_URL = "https://exchange.example";
  });
  function answer() {
    forward.mockResolvedValueOnce({
      status: 200,
      contentType: "application/json",
      requestId: null,
      body: {
        success: true,
        accessEventId: "10000000-0000-4000-8000-000000000001",
        creditsCost: 2,
        data,
      },
    });
  }
  it("fetches the canonical record and bills before returning content", async () => {
    answer();
    vi.mocked(billExchangeRecord).mockResolvedValueOnce({ success: true });
    const { r, out } = res();
    await exchangeScrapeController(req({ exchange: record }), r, "record-job");
    expect(forward).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/v1/records/fetch",
        body: { url: record.url },
        teamId: "team_a",
      }),
    );
    expect(billExchangeRecord).toHaveBeenCalledWith(
      expect.objectContaining({ creditsCost: 2 }),
      { teamId: "team_a", apiKeyId: 7, maxCredits: 3 },
    );
    expect(out.status).toBe(200);
    expect(out.body.data.exchange[0].data).toEqual(data);
  });
  it("does not expose the record when billing is denied", async () => {
    answer();
    vi.mocked(billExchangeRecord).mockResolvedValueOnce({
      success: false,
      status: 402,
      error: "Insufficient credits",
    });
    const { r, out } = res();
    await exchangeScrapeController(req({ exchange: record }), r, "record-job");
    expect(out.status).toBe(402);
    expect(out.body).not.toHaveProperty("data");
  });
  it.each([
    { url: record.url },
    { ...record, maxCredits: -1 },
    { ...record, url: "https://example.com" },
    [record],
  ])("rejects invalid record request %j", async exchange => {
    const { r, out } = res();
    await exchangeScrapeController(req({ exchange }), r, "record-job");
    expect(out.status).toBe(400);
    expect(forward).not.toHaveBeenCalled();
  });
});
