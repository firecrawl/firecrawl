import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { config } from "../../config";
import { reportExchangeUsageBilling } from "./report";

vi.mock("node:timers/promises", () => ({
  setTimeout: vi.fn().mockResolvedValue(undefined),
}));
import { setTimeout as delay } from "node:timers/promises";

const originalDispatcher = getGlobalDispatcher();
const originalUrl = config.FIRE_EXCHANGE_URL;
const originalSecret = config.EXCHANGE_INTERNAL_SECRET;
const path = "/v1/usage-events/billing";
let agent: MockAgent;

beforeEach(() => {
  vi.mocked(delay).mockClear();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  config.FIRE_EXCHANGE_URL = "https://exchange.example";
  config.EXCHANGE_INTERNAL_SECRET = "test-secret";
});

afterEach(async () => {
  vi.restoreAllMocks();
  setGlobalDispatcher(originalDispatcher);
  config.FIRE_EXCHANGE_URL = originalUrl;
  config.EXCHANGE_INTERNAL_SECRET = originalSecret;
  await agent.close();
});

it("confirms through the configured HTTPS endpoint, preserving its path prefix", async () => {
  config.FIRE_EXCHANGE_URL = "https://exchange.example/base/";
  agent
    .get("https://exchange.example")
    .intercept({
      path: `/base${path}`,
      method: "POST",
      headers: { "x-exchange-secret": "test-secret" },
      body: JSON.stringify([
        {
          requestId: "receipt-1",
          status: "confirmed",
          billingReference: "charge-1",
        },
      ]),
    })
    .reply(200, {});
  await expect(
    reportExchangeUsageBilling("receipt-1", "charge-1"),
  ).resolves.toBe(true);
  agent.assertNoPendingInterceptors();
});

it.each([429, 500])(
  "retries a %s response and confirms billing",
  async status => {
    const pool = agent.get("https://exchange.example");
    pool.intercept({ path, method: "POST" }).reply(status, {});
    pool.intercept({ path, method: "POST" }).reply(200, {});
    await expect(
      reportExchangeUsageBilling("receipt-1", "charge-1"),
    ).resolves.toBe(true);
    agent.assertNoPendingInterceptors();
  },
);

it.each(["http://exchange.example", "http://localhost:3000"])(
  "does not send the secret to %s",
  async url => {
    config.FIRE_EXCHANGE_URL = url;
    const received = vi.fn(() => ({ statusCode: 200, data: "{}" }));
    agent.get(url).intercept({ path, method: "POST" }).reply(received);
    const confirmed = await reportExchangeUsageBilling("receipt-1");
    expect(received).not.toHaveBeenCalled();
    expect(confirmed).toBe(false);
  },
);

it.each(["https://unexpected.example", "http://unexpected.example"])(
  "does not forward the secret on a redirect to %s",
  async destination => {
    agent
      .get("https://exchange.example")
      .intercept({ path, method: "POST" })
      .reply(307, "", { headers: { location: `${destination}/collect` } });
    const redirected = vi.fn(() => ({ statusCode: 200, data: "{}" }));
    agent
      .get(destination)
      .intercept({ path: "/collect", method: "POST" })
      .reply(redirected);
    const confirmed = await reportExchangeUsageBilling("receipt-1");
    expect(redirected).not.toHaveBeenCalled();
    expect(confirmed).toBe(false);
  },
);

it("does not retry a missing billing receipt or endpoint", async () => {
  const dispatch = vi.spyOn(agent, "dispatch");
  agent
    .get("https://exchange.example")
    .intercept({ path, method: "POST" })
    .reply(404, {});
  expect(await reportExchangeUsageBilling("missing")).toBe(false);
  expect(dispatch).toHaveBeenCalledTimes(1);
  agent.assertNoPendingInterceptors();
});

it.each([
  ["0", 0],
  ["2", 2000],
  ["999999", 5000],
  ["invalid", 250],
  ["-1", 250],
  ["-1.5", 250],
  ["1.5", 250],
  ["0x10", 250],
  ["", 250],
  ["Thu, 10 Sep 2026 11:59:59 GMT", 250],
  ["Thu, 10 Sep 2026 12:00:02 GMT", 2000],
])(
  "bounds Retry-After %s before retrying",
  async (retryAfter, expectedDelay) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 8, 10, 12));
    const pool = agent.get("https://exchange.example");
    pool
      .intercept({ path, method: "POST" })
      .reply(429, {}, { headers: { "retry-after": retryAfter } });
    pool.intercept({ path, method: "POST" }).reply(200, {});
    expect(await reportExchangeUsageBilling("receipt-1")).toBe(true);
    expect(delay).toHaveBeenCalledWith(expectedDelay);
    agent.assertNoPendingInterceptors();
  },
);

it("returns false after three failed dispatches", async () => {
  const dispatch = vi.spyOn(agent, "dispatch");
  agent
    .get("https://exchange.example")
    .intercept({ path, method: "POST" })
    .reply(503, {})
    .times(3);
  expect(await reportExchangeUsageBilling("receipt-1")).toBe(false);
  expect(dispatch).toHaveBeenCalledTimes(3);
  agent.assertNoPendingInterceptors();
});
