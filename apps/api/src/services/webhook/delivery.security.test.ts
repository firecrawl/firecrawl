import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: {
    ALLOW_LOCAL_WEBHOOKS: false,
    WEBHOOK_USE_RABBITMQ: true,
    NUQ_RABBITMQ_URL: "amqp://queue",
  },
  publish: vi.fn().mockResolvedValue(undefined),
  lookup: vi.fn(),
}));
vi.mock("../../config", () => ({ config: mocks.config }));
vi.mock("node:dns", () => ({
  default: { promises: { lookup: mocks.lookup } },
}));
vi.mock("./queue", () => ({ webhookQueue: { publish: mocks.publish } }));
vi.mock("../redis", () => ({ redisEvictConnection: {} }));
vi.mock("../../db/connection", () => ({ db: {} }));
vi.mock("../../db/schema", () => ({}));
vi.mock("../../lib/logger", () => {
  const logger = {
    warn: vi.fn(),
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
});

it("does not publish a webhook whose DNS resolves to a private address", async () => {
  mocks.lookup.mockResolvedValue([{ address: "10.0.0.1", family: 4 }]);
  expect(await send("https://internal.example/hook")).toMatchObject({
    skipped: true,
  });
  expect(mocks.publish).not.toHaveBeenCalled();
});

it("fails closed on DNS resolution failure", async () => {
  mocks.lookup.mockRejectedValue(new Error("DNS failed"));
  expect(await send("https://missing.example/hook")).toMatchObject({
    skipped: true,
  });
  expect(mocks.publish).not.toHaveBeenCalled();
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
