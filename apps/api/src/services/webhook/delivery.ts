import undici from "undici";
import { createHmac, randomUUID } from "crypto";
import { config } from "../../config";
import { logger as _logger } from "../../lib/logger";
import {
  getSecureDispatcherNoCookies,
  isIPPrivate,
} from "../../scraper/scrapeURL/engines/utils/safeFetch";
import {
  service,
  type WebhookContext,
  type WebhookDelivery,
  type WebhookResponse,
} from "../../service";
import type { WebhookConfig, WebhookEvent, WebhookEventDataMap } from "./types";

type WebhookSendResult = {
  attempted: boolean;
  delivered?: boolean;
  queued?: boolean;
  skipped?: boolean;
  statusCode?: number;
};

export function webhookEventMatchesFilter(
  configuredEvents: string[] | undefined,
  event: WebhookEvent,
): boolean {
  if (!configuredEvents?.length) {
    return true;
  }

  const legacySubType = event.split(".")[1];
  const namespaceSuffix = event.split(".").slice(1).join(".");
  return (
    configuredEvents.includes(event) ||
    configuredEvents.includes(legacySubType) ||
    configuredEvents.includes(namespaceSuffix)
  );
}

type WebhookSenderContext = {
  teamId: string;
  jobId: string;
  v0: boolean;
  zeroDataRetention?: boolean;
};

export class WebhookSender {
  private config: WebhookConfig;
  private secret?: string;
  private context: WebhookSenderContext;
  private logger: any;

  constructor(
    config: WebhookConfig,
    secret: string | undefined,
    context: WebhookSenderContext,
  ) {
    this.config = config;
    this.secret = secret;
    this.context = context;
    this.logger = _logger.child({
      module: "webhook-sender",
      teamId: context.teamId,
      jobId: context.jobId,
      isV0: context.v0,
    });
  }

  async send<T extends WebhookEvent>(
    event: T,
    data: WebhookEventDataMap[T],
  ): Promise<WebhookSendResult> {
    if (!this.shouldSendEvent(event)) {
      return { attempted: false, skipped: true };
    }

    const payload = {
      success: data.success,
      type: event,
      [this.context.v0 ? "jobId" : "id"]: this.context.jobId,
      webhookId: randomUUID(), // Unique ID for this webhook delivery (used for e.g. retries)
      data: "data" in data ? data.data : [],
      error: "error" in data ? data.error : undefined,
      metadata: this.config.metadata || undefined,
    };

    const delivery = this.deliver(
      payload,
      (data as any)?.scrapeId ?? undefined,
    );

    if (data.awaitWebhook) {
      return { attempted: true, ...(await delivery) };
    }

    delivery.catch(() => {});
    return {
      attempted: true,
      delivered: false,
    };
  }

  private shouldSendEvent(event: WebhookEvent): boolean {
    if (config.DISABLE_WEBHOOK_DELIVERY) {
      return false;
    }

    return webhookEventMatchesFilter(this.config.events, event);
  }

  private async deliver(
    payload: any,
    scrapeId?: string,
  ): Promise<Omit<WebhookSendResult, "attempted">> {
    const webhookHost = new URL(this.config.url).hostname;
    if (isIPPrivate(webhookHost) && config.ALLOW_LOCAL_WEBHOOKS !== true) {
      this.logger.warn("Aborting webhook call to private IP address", {
        webhookUrl: this.config.url,
      });
      return { delivered: false, skipped: true };
    }

    const timeoutMs = this.context.v0 ? 30000 : 10000;
    const ctx: WebhookContext = {
      teamId: this.context.teamId,
      zeroDataRetention: Boolean(this.context.zeroDataRetention),
    };
    const delivery: WebhookDelivery = {
      url: this.config.url,
      event: payload.type,
      payload,
      headers: this.config.headers,
      jobId: this.context.jobId,
      scrapeId,
      timeoutMs,
    };

    const send = async (): Promise<WebhookResponse> => {
      const payloadString = JSON.stringify(payload);
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...this.config.headers,
      };

      if (this.secret) {
        const hmac = createHmac("sha256", this.secret);
        hmac.update(payloadString);
        headers["X-Firecrawl-Signature"] = `sha256=${hmac.digest("hex")}`;
      }

      const abortController = new AbortController();
      const timeoutHandle = setTimeout(() => {
        abortController.abort();
      }, timeoutMs);

      try {
        const res = await undici.fetch(this.config.url, {
          method: "POST",
          headers,
          body: payloadString,
          dispatcher: getSecureDispatcherNoCookies(),
          signal: abortController.signal,
        });

        if (!res.ok) {
          const error = new Error(
            `Unexpected response status: ${res.status}`,
          ) as Error & { status?: number };
          error.status = res.status;
          throw error;
        }

        return { ok: res.ok, status: res.status };
      } catch (error) {
        this.logger.error("Failed to send webhook", {
          error,
          webhookUrl: this.config.url,
        });
        throw error;
      } finally {
        clearTimeout(timeoutHandle);
      }
    };

    return service.modules.webhooks.deliver(ctx, delivery, send);
  }

  get metadata(): Record<string, string> {
    return this.config.metadata || {};
  }
}
