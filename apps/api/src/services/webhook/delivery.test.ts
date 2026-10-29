import { WebhookEvent } from "./types";
import { webhookEventMatchesFilter } from "./delivery";

describe("webhook delivery", () => {
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
});
