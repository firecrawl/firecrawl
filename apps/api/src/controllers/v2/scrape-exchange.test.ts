import { beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../../config";
import { ExchangeProxyError } from "../../lib/exchange-proxy";
import { exchangeScrapeController } from "./scrape-exchange";

vi.mock("../../lib/exchange-proxy", async importOriginal => ({
  ...(await importOriginal<typeof import("../../lib/exchange-proxy")>()),
  forwardToExchange: vi.fn(),
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

  it("forwards every call as one batch under the team, and relays results with the cost", async () => {
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

    await exchangeScrapeController(req({ exchange: [CALL] }), r, "job-1");

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
  });

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
