import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  dispatcher: {},
}));

vi.mock("undici", async importOriginal => {
  const actual = await importOriginal<typeof import("undici")>();
  return {
    ...actual,
    default: { ...actual, fetch: mocks.fetch },
    fetch: mocks.fetch,
  };
});

vi.mock(
  "../../scraper/scrapeURL/engines/utils/safeFetch",
  async importOriginal => {
    const actual =
      await importOriginal<
        typeof import("../../scraper/scrapeURL/engines/utils/safeFetch")
      >();
    return {
      ...actual,
      getSecureDispatcherNoCookies: () => mocks.dispatcher,
    };
  },
);

vi.mock("../../lib/logger", () => {
  const mk = (): Record<string, unknown> => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => mk(),
  });
  return { logger: mk() };
});

import { config } from "../../config";
import {
  defaultModules,
  directWebhooks,
  type CoreParts,
  type WebhookContext,
  type WebhookDelivery,
  type WebhooksModule,
} from "../../service";
import { testService, withService } from "../../service/testing";
import { createWebhookSender } from "./index";
import { webhookEventMatchesFilter } from "./delivery";
import { WebhookEvent } from "./types";

const parts: CoreParts = { core: { name: "core" }, logger: { error: vi.fn() } };

describe("webhook delivery", () => {
  const originalDisable = config.DISABLE_WEBHOOK_DELIVERY;
  const originalAllowLocal = config.ALLOW_LOCAL_WEBHOOKS;
  const originalSelfHostedUrl = config.SELF_HOSTED_WEBHOOK_URL;
  const originalSelfHostedSecret = config.SELF_HOSTED_WEBHOOK_HMAC_SECRET;

  beforeEach(() => {
    mocks.fetch.mockReset();
    config.DISABLE_WEBHOOK_DELIVERY = undefined;
    config.ALLOW_LOCAL_WEBHOOKS = undefined;
    config.SELF_HOSTED_WEBHOOK_URL = undefined;
    config.SELF_HOSTED_WEBHOOK_HMAC_SECRET = undefined;
  });

  afterEach(() => {
    config.DISABLE_WEBHOOK_DELIVERY = originalDisable;
    config.ALLOW_LOCAL_WEBHOOKS = originalAllowLocal;
    config.SELF_HOSTED_WEBHOOK_URL = originalSelfHostedUrl;
    config.SELF_HOSTED_WEBHOOK_HMAC_SECRET = originalSelfHostedSecret;
  });

  describe("webhookEventMatchesFilter", () => {
    it("matches full monitor event names", () => {
      expect(
        webhookEventMatchesFilter(
          ["monitor.page", "monitor.check.completed"],
          WebhookEvent.MONITOR_PAGE,
        ),
      ).toBe(true);
      expect(
        webhookEventMatchesFilter(
          ["monitor.page", "monitor.check.completed"],
          WebhookEvent.MONITOR_CHECK_COMPLETED,
        ),
      ).toBe(true);
    });

    it("keeps legacy subtype filters for non-monitor webhooks", () => {
      expect(webhookEventMatchesFilter(["page"], WebhookEvent.CRAWL_PAGE)).toBe(
        true,
      );
      expect(
        webhookEventMatchesFilter(["completed"], WebhookEvent.CRAWL_COMPLETED),
      ).toBe(true);
    });
  });

  describe("webhooks module integration", () => {
    it("signs and sends in-process with directWebhooks", async () => {
      mocks.fetch.mockResolvedValue({ ok: true, status: 200 });
      const svc = testService(defaultModules(), parts, {
        webhooks: directWebhooks({ secret: "test-hmac-secret" }),
      });

      await withService(svc, async () => {
        const sender = await createWebhookSender({
          teamId: "team-1",
          jobId: "crawl-1",
          webhook: {
            url: "https://hooks.example.com/events",
            headers: { "X-Custom": "value" },
            metadata: { env: "test" },
            events: ["page", "completed"],
          },
          v0: false,
        });

        expect(sender).not.toBeNull();
        const result = await sender!.send(WebhookEvent.CRAWL_COMPLETED, {
          success: true,
          data: [],
          awaitWebhook: true,
        });

        expect(result).toEqual({
          attempted: true,
          delivered: true,
          queued: false,
          statusCode: 200,
        });
        expect(mocks.fetch).toHaveBeenCalledTimes(1);
        const [url, init] = mocks.fetch.mock.calls[0] as [string, any];
        expect(url).toBe("https://hooks.example.com/events");
        expect(init.method).toBe("POST");
        expect(init.dispatcher).toBe(mocks.dispatcher);
        expect(init.headers["Content-Type"]).toBe("application/json");
        expect(init.headers["X-Custom"]).toBe("value");

        const expectedSig = createHmac("sha256", "test-hmac-secret")
          .update(init.body)
          .digest("hex");
        expect(init.headers["X-Firecrawl-Signature"]).toBe(
          `sha256=${expectedSig}`,
        );
      });
    });

    it("routes signingSecret and deliver through a custom webhooks module with ZDR context", async () => {
      const secretCalls: WebhookContext[] = [];
      const deliverCalls: Array<{
        ctx: WebhookContext;
        delivery: WebhookDelivery;
      }> = [];
      const customWebhooks: WebhooksModule = {
        async signingSecret(ctx) {
          secretCalls.push(ctx);
          return "team-secret";
        },
        async deliver(ctx, delivery) {
          deliverCalls.push({ ctx, delivery });
          return { delivered: false, queued: true };
        },
      };

      await withService(
        testService(defaultModules(), parts, { webhooks: customWebhooks }),
        async () => {
          const sender = await createWebhookSender({
            teamId: "team-zdr",
            jobId: "crawl-42",
            webhook: {
              url: "https://hooks.example.com/zdr",
              headers: { Authorization: "Bearer tok" },
              metadata: {},
              events: ["page"],
            },
            v0: false,
            zeroDataRetention: true,
          });

          expect(sender).not.toBeNull();
          const result = await sender!.send(WebhookEvent.CRAWL_PAGE, {
            success: true,
            data: [],
            scrapeId: "scrape-9",
            awaitWebhook: true,
          });

          expect(result).toEqual({
            attempted: true,
            delivered: false,
            queued: true,
          });
          expect(mocks.fetch).not.toHaveBeenCalled();
          expect(secretCalls).toEqual([
            { teamId: "team-zdr", zeroDataRetention: true },
          ]);
          expect(deliverCalls).toHaveLength(1);
          expect(deliverCalls[0].ctx).toEqual({
            teamId: "team-zdr",
            zeroDataRetention: true,
          });
          expect(deliverCalls[0].delivery).toMatchObject({
            url: "https://hooks.example.com/zdr",
            event: WebhookEvent.CRAWL_PAGE,
            headers: { Authorization: "Bearer tok" },
            jobId: "crawl-42",
            scrapeId: "scrape-9",
            timeoutMs: 10_000,
          });
          expect(deliverCalls[0].delivery.headers).not.toHaveProperty(
            "X-Firecrawl-Signature",
          );
        },
      );
    });

    it("resolves SELF_HOSTED_WEBHOOK_URL and SELF_HOSTED_WEBHOOK_HMAC_SECRET through directWebhooks", async () => {
      config.SELF_HOSTED_WEBHOOK_URL = "https://hooks.example.com/{{JOB_ID}}";
      config.SELF_HOSTED_WEBHOOK_HMAC_SECRET = "env-secret";
      mocks.fetch.mockResolvedValue({ ok: true, status: 204 });

      await withService(testService(defaultModules(), parts), async () => {
        const sender = await createWebhookSender({
          teamId: "bypass",
          jobId: "job-77",
          v0: true,
        });
        expect(sender).not.toBeNull();

        const result = await sender!.send(WebhookEvent.CRAWL_COMPLETED, {
          success: true,
          data: [],
          awaitWebhook: true,
        });
        expect(result).toEqual({
          attempted: true,
          delivered: true,
          queued: false,
          statusCode: 204,
        });

        const [url, init] = mocks.fetch.mock.calls[0] as [string, any];
        expect(url).toBe("https://hooks.example.com/job-77");
        const parsed = JSON.parse(init.body);
        expect(parsed.jobId).toBe("job-77");
        const expectedSig = createHmac("sha256", "env-secret")
          .update(init.body)
          .digest("hex");
        expect(init.headers["X-Firecrawl-Signature"]).toBe(
          `sha256=${expectedSig}`,
        );
      });
    });

    it("skips private IP webhooks before calling webhooks.deliver when ALLOW_LOCAL_WEBHOOKS is unset", async () => {
      const deliver = vi.fn(async () => ({ delivered: true }));
      await withService(
        testService(defaultModules(), parts, {
          webhooks: {
            signingSecret: async () => undefined,
            deliver,
          },
        }),
        async () => {
          const sender = await createWebhookSender({
            teamId: "team-1",
            jobId: "job-1",
            webhook: {
              url: "http://127.0.0.1:8080/hook",
              headers: {},
              metadata: {},
              events: ["completed"],
            },
            v0: false,
          });

          const result = await sender!.send(WebhookEvent.CRAWL_COMPLETED, {
            success: true,
            data: [],
            awaitWebhook: true,
          });
          expect(result).toEqual({
            attempted: true,
            delivered: false,
            skipped: true,
          });
          expect(deliver).not.toHaveBeenCalled();
          expect(mocks.fetch).not.toHaveBeenCalled();
        },
      );
    });

    it("throws an error with status when direct HTTP delivery receives a non-2xx response", async () => {
      mocks.fetch.mockResolvedValue({ ok: false, status: 502 });
      await withService(
        testService(defaultModules(), parts, {
          webhooks: directWebhooks({ secret: undefined }),
        }),
        async () => {
          const sender = await createWebhookSender({
            teamId: "team-1",
            jobId: "job-1",
            webhook: {
              url: "https://hooks.example.com/fail",
              headers: {},
              metadata: {},
              events: ["completed"],
            },
            v0: false,
          });

          await expect(
            sender!.send(WebhookEvent.CRAWL_COMPLETED, {
              success: true,
              data: [],
              awaitWebhook: true,
            }),
          ).rejects.toMatchObject({
            message: "Unexpected response status: 502",
            status: 502,
          });
        },
      );
    });

    it("skips delivery when DISABLE_WEBHOOK_DELIVERY is true", async () => {
      config.DISABLE_WEBHOOK_DELIVERY = true;
      const deliver = vi.fn(async () => ({ delivered: true }));

      await withService(
        testService(defaultModules(), parts, {
          webhooks: {
            signingSecret: async () => undefined,
            deliver,
          },
        }),
        async () => {
          const sender = await createWebhookSender({
            teamId: "team-1",
            jobId: "job-1",
            webhook: {
              url: "https://hooks.example.com/disabled",
              headers: {},
              metadata: {},
              events: ["completed"],
            },
            v0: false,
          });

          const result = await sender!.send(WebhookEvent.CRAWL_COMPLETED, {
            success: true,
            data: [],
            awaitWebhook: true,
          });
          expect(result).toEqual({ attempted: false, skipped: true });
          expect(deliver).not.toHaveBeenCalled();
        },
      );
    });
  });
});
