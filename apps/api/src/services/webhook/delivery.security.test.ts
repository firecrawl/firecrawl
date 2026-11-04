import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: {
    ALLOW_LOCAL_WEBHOOKS: false,
    WEBHOOK_USE_RABBITMQ: true,
    NUQ_RABBITMQ_URL: "amqp://queue",
  },
  publish: vi.fn().mockResolvedValue(undefined),
  lookup: vi.fn(),
  rpush: vi.fn().mockResolvedValue(1),
  warn: vi.fn(),
}));
vi.mock("../../config", () => ({ config: mocks.config }));
vi.mock("node:dns", () => ({
  default: { promises: { lookup: mocks.lookup } },
}));
vi.mock("./queue", () => ({ webhookQueue: { publish: mocks.publish } }));
vi.mock("../redis", () => ({ redisEvictConnection: { rpush: mocks.rpush } }));
vi.mock("../../db/connection", () => ({ db: {} }));
vi.mock("../../db/schema", () => ({}));
vi.mock("../../lib/logger", () => {
  const logger = {
    warn: mocks.warn,
    info: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return { logger };
});
vi.mock("../../scraper/scrapeURL/engines/utils/safeFetch", () => ({
  getSecureDispatcherNoCookies: vi.fn(),
}));

import { WebhookSender } from "./delivery";
import { WebhookEvent } from "./types";

afterEach(() => {
  mocks.config.ALLOW_LOCAL_WEBHOOKS = false;
  vi.clearAllMocks();
});

function send(url: string) {
  const sender = new WebhookSender(
    { url, headers: {}, metadata: {}, events: ["started"] },
    undefined,
    { teamId: "team", jobId: "job", v0: false },
  );
  return sender.send(WebhookEvent.CRAWL_STARTED, {
    success: true,
    awaitWebhook: true,
  });
}

it.each([
  "http://[::1]",
  "http://169.254.169.254",
  "http://localhost.",
  "file:///etc/passwd",
  "invalid",
])("does not publish an unsafe stored webhook: %s", async url => {
  expect(await send(url)).toMatchObject({ delivered: false, skipped: true });
  expect(mocks.publish).not.toHaveBeenCalled();
  expect(mocks.lookup).not.toHaveBeenCalled();
  expect(mocks.rpush).toHaveBeenCalledOnce();
  const row = JSON.parse(mocks.rpush.mock.calls[0][1]);
  expect(row).toMatchObject({
    success: false,
    team_id: "team",
    crawl_id: "job",
    url,
    event: WebhookEvent.CRAWL_STARTED,
  });
  expect(row.error).toBeTruthy();
});

it("does not publish a webhook whose DNS resolves to a private address", async () => {
  mocks.lookup.mockResolvedValue([{ address: "10.0.0.1", family: 4 }]);
  expect(await send("https://internal.example/hook")).toMatchObject({
    skipped: true,
  });
  expect(mocks.publish).not.toHaveBeenCalled();
});

it("fails closed on DNS resolution failure", async () => {
  const error = new Error("DNS failed");
  mocks.lookup.mockRejectedValue(error);
  expect(await send("https://missing.example/hook")).toMatchObject({
    skipped: true,
  });
  expect(mocks.publish).not.toHaveBeenCalled();
  expect(mocks.warn).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ error }),
  );
  expect(mocks.rpush).toHaveBeenCalledOnce();
  expect(JSON.parse(mocks.rpush.mock.calls[0][1]).error).toBe("DNS failed");
});

it("publishes a public webhook after validating DNS", async () => {
  mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  expect(await send("https://public.example/hook")).toMatchObject({
    queued: true,
  });
  expect(mocks.publish).toHaveBeenCalledWith(
    expect.objectContaining({ webhook_url: "https://public.example/hook" }),
  );
});

it("preserves the explicit operator override for local webhook queues", async () => {
  mocks.config.ALLOW_LOCAL_WEBHOOKS = true;
  expect(await send("http://[::1]/hook")).toMatchObject({ queued: true });
  expect(mocks.lookup).not.toHaveBeenCalled();
  expect(mocks.publish).toHaveBeenCalledOnce();
});
