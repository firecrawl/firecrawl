import { beforeEach, expect, it, vi } from "vitest";
vi.mock("undici", () => ({ fetch: vi.fn() }));
vi.mock("../../config", () => ({
  config: {
    FIRE_EXCHANGE_URL: "https://exchange.example/",
    EXCHANGE_INTERNAL_SECRET: "test-secret",
  },
}));
vi.mock("../../lib/logger", () => ({ logger: { error: vi.fn() } }));
import { fetch } from "undici";
import { config } from "../../config";
import { reportExchangeUsageBilling } from "./report";
const response = (status: number) =>
  ({
    status,
    ok: status === 200,
    arrayBuffer: vi.fn(async () => new ArrayBuffer(0)),
  }) as any;
beforeEach(() => {
  vi.mocked(fetch).mockReset();
  config.EXCHANGE_INTERNAL_SECRET = "test-secret";
});
it("confirms the request receipt using the internal secret", async () => {
  vi.mocked(fetch).mockResolvedValue(response(200));
  expect(await reportExchangeUsageBilling("request", "billing")).toBe(true);
  const [url, options] = vi.mocked(fetch).mock.calls[0];
  expect(url).toBe("https://exchange.example/v1/usage-events/billing");
  expect(options?.headers).toEqual({
    "content-type": "application/json",
    "x-exchange-secret": "test-secret",
  });
  expect(JSON.parse(options?.body as string)).toEqual([
    { requestId: "request", status: "confirmed", billingReference: "billing" },
  ]);
});
it("bounds retries and reports failure for reconciliation", async () => {
  vi.mocked(fetch).mockResolvedValue(response(503));
  expect(await reportExchangeUsageBilling("request")).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(3);
});
it("does not retry invalid credentials", async () => {
  vi.mocked(fetch).mockResolvedValue(response(401));
  expect(await reportExchangeUsageBilling("request")).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("does not send an unauthenticated confirmation", async () => {
  config.EXCHANGE_INTERNAL_SECRET = undefined;
  expect(await reportExchangeUsageBilling("request")).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});
