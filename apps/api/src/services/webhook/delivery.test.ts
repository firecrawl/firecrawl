import { WebhookEvent } from "./types";
import { WebhookSender, webhookEventMatchesFilter } from "./delivery";
import { buildWebhookDeliveryHeaders } from "./headers";
import { webhookSchema } from "./schema";
import { config } from "../../config";
import { webhookQueue } from "./queue";

describe("webhook delivery", () => {
  const originalWebhookUseRabbitMq = config.WEBHOOK_USE_RABBITMQ;
  const originalRabbitMqUrl = config.NUQ_RABBITMQ_URL;
  const originalAllowLocalWebhooks = config.ALLOW_LOCAL_WEBHOOKS;

  afterEach(() => {
    config.WEBHOOK_USE_RABBITMQ = originalWebhookUseRabbitMq;
    config.NUQ_RABBITMQ_URL = originalRabbitMqUrl;
    config.ALLOW_LOCAL_WEBHOOKS = originalAllowLocalWebhooks;
    jest.restoreAllMocks();
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

  describe("buildWebhookDeliveryHeaders", () => {
    const payload = {
      success: true,
      type: WebhookEvent.CRAWL_PAGE,
      id: "crawl-123",
      webhookId: "webhook-123",
      data: [],
    };

    it("adds stable delivery metadata and a signature for direct delivery", () => {
      const payloadString = JSON.stringify(payload);

      expect(
        buildWebhookDeliveryHeaders({
          configHeaders: {
            "X-Customer-Trace": "trace-1",
            "x-firecrawl-event": "customer-event",
          },
          deliveryMode: "direct",
          jobId: "crawl-123",
          payload,
          payloadString,
          scrapeId: "scrape-123",
          secret: "secret",
        }),
      ).toEqual({
        "Content-Type": "application/json",
        "X-Customer-Trace": "trace-1",
        "X-Firecrawl-Webhook-Id": "webhook-123",
        "X-Firecrawl-Event": WebhookEvent.CRAWL_PAGE,
        "X-Firecrawl-Job-Id": "crawl-123",
        "X-Firecrawl-Delivery-Mode": "direct",
        "X-Firecrawl-Scrape-Id": "scrape-123",
        "X-Firecrawl-Signature":
          "sha256=29729c39fd5f57c6f4d50c86dd20256a5d77b7b39d19531c17805163fb830d40",
      });
    });

    it("signs queued deliveries before publishing to RabbitMQ", () => {
      const payloadString = JSON.stringify(payload);

      const headers = buildWebhookDeliveryHeaders({
        deliveryMode: "queued",
        jobId: "crawl-123",
        payload,
        payloadString,
        secret: "secret",
      });

      expect(headers["X-Firecrawl-Delivery-Mode"]).toBe("queued");
      expect(headers["X-Firecrawl-Signature"]).toBe(
        "sha256=29729c39fd5f57c6f4d50c86dd20256a5d77b7b39d19531c17805163fb830d40",
      );
    });
  });

  describe("webhookSchema", () => {
    it("rejects attempts to override Firecrawl-managed delivery headers", () => {
      const parsed = webhookSchema.safeParse({
        url: "https://example.com/webhook",
        headers: {
          "x-firecrawl-webhook-id": "customer-value",
        },
      });

      expect(parsed.success).toBe(false);
    });
  });

  describe("WebhookSender", () => {
    it("publishes queued deliveries with signed Firecrawl metadata headers", async () => {
      config.WEBHOOK_USE_RABBITMQ = true;
      config.NUQ_RABBITMQ_URL = "amqp://rabbitmq";
      config.ALLOW_LOCAL_WEBHOOKS = true;
      const publish = jest
        .spyOn(webhookQueue, "publish")
        .mockResolvedValue(undefined);

      const sender = new WebhookSender(
        {
          url: "https://example.com/webhook",
          headers: {
            "X-Customer-Trace": "trace-1",
            "x-firecrawl-job-id": "customer-job",
          },
          metadata: {},
          events: [],
        },
        "secret",
        { teamId: "team-123", jobId: "crawl-123", v0: false },
      );

      const result = await sender.send(WebhookEvent.CRAWL_PAGE, {
        success: true,
        data: [],
        scrapeId: "scrape-123",
        awaitWebhook: true,
      });

      expect(result).toEqual({
        attempted: true,
        delivered: false,
        queued: true,
      });
      expect(publish).toHaveBeenCalledTimes(1);
      const [message] = publish.mock.calls[0];
      expect(message).toMatchObject({
        webhook_url: "https://example.com/webhook",
        team_id: "team-123",
        job_id: "crawl-123",
        scrape_id: "scrape-123",
        event: WebhookEvent.CRAWL_PAGE,
      });
      expect(message.payload.webhookId).toEqual(expect.any(String));
      expect(message.headers["X-Customer-Trace"]).toBe("trace-1");
      expect(message.headers["x-firecrawl-job-id"]).toBeUndefined();
      expect(message.headers["X-Firecrawl-Webhook-Id"]).toBe(
        message.payload.webhookId,
      );
      expect(message.headers["X-Firecrawl-Event"]).toBe(
        WebhookEvent.CRAWL_PAGE,
      );
      expect(message.headers["X-Firecrawl-Job-Id"]).toBe("crawl-123");
      expect(message.headers["X-Firecrawl-Scrape-Id"]).toBe("scrape-123");
      expect(message.headers["X-Firecrawl-Delivery-Mode"]).toBe("queued");
      expect(message.headers["X-Firecrawl-Signature"]).toMatch(/^sha256=/);
    });
  });
});
