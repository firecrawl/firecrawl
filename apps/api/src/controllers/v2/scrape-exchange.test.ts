import { beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../../config";
import { ExchangeProxyError } from "../../lib/exchange-proxy";
import { exchangeScrapeController } from "./scrape-exchange";

vi.mock("../../lib/exchange-proxy", async importOriginal => ({
  ...(await importOriginal<typeof import("../../lib/exchange-proxy")>()),
  forwardToExchange: vi.fn(),
}));
vi.mock("../../services/exchange/settle", () => ({
  settleExchangeCall: vi.fn(),
}));
vi.mock("../../services/logging/log_job", () => ({
  logRequest: vi.fn(async () => {}),
}));
vi.mock("../../lib/external-request-id", () => ({
  externalRequestId: () => "ext",
}));

import { settleExchangeCall } from "../../services/exchange/settle";
import { logRequest } from "../../services/logging/log_job";
const forward = vi.mocked(settleExchangeCall);

const CALL = {
  provider: "test-provider",
  capability: "records/get",
  options: { id: "record-1" },
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
    vi.clearAllMocks();
    forward.mockReset();
    config.FIRE_EXCHANGE_URL = "https://exchange.example";
  });

  it.each([CALL, [CALL]])(
    "normalizes request %j and relays the cost",
    async exchange => {
      forward.mockResolvedValueOnce({
        status: 200,
        contentType: "application/json",
        requestId: null,
        body: {
          success: true,
          creditsCost: 1,
          results: [{ ...CALL, creditsCost: 1, data: { id: "record-1" } }],
        },
      });
      const { r, out } = res();

      const input = req({ exchange });
      input.headers["x-request-id"] = "request-1";
      await exchangeScrapeController(input, r, "job-1");

      expect(forward).toHaveBeenCalledWith(
        expect.objectContaining({
          teamId: "team_a",
          apiKeyId: 7,
          body: { requests: [CALL] },
          requestId: "request-1",
        }),
      );
      expect(out.status).toBe(200);
      expect(out.body).toEqual({
        success: true,
        scrape_id: "job-1",
        data: {
          exchange: [{ ...CALL, creditsCost: 1, data: { id: "record-1" } }],
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

  it.each([{ scrapeZDR: "forced" }, { forceZDR: true }])(
    "refuses forced ZDR before logging or forwarding: %j",
    async flags => {
      const { r, out } = res();
      await exchangeScrapeController(
        req({ exchange: CALL }, { exchangeRetrieve: true, ...flags }),
        r,
        "job-zdr",
      );
      expect(out.status).toBe(403);
      expect(out.body.error).toContain("zero data retention");
      expect(forward).not.toHaveBeenCalled();
      expect(logRequest).not.toHaveBeenCalled();
    },
  );

  it("rejects an empty list, more than ten, and page-scrape fields, with a field-level message", async () => {
    for (const body of [
      { exchange: [] },
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
      body: { code: "missing_option", error: "id is required" },
    });
    const { r, out } = res();
    await exchangeScrapeController(req({ exchange: [CALL] }), r, "job-5");
    expect(out.status).toBe(400);
    expect(out.body).toEqual({
      success: false,
      code: "missing_option",
      error: "id is required",
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
