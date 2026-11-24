import { config } from "../../config";
import { service } from "../../service";
import type { WebhookConfig } from "./types";

export async function getWebhookConfig(
  teamId: string,
  jobId: string,
  webhook?: WebhookConfig,
  zeroDataRetention = false,
): Promise<{ config: WebhookConfig; secret?: string } | null> {
  // priority:
  // - webhook
  // - self-hosted environment variable
  if (webhook) {
    return {
      config: webhook,
      secret: await service.modules.webhooks.signingSecret({
        teamId,
        zeroDataRetention,
      }),
    };
  }

  const selfHostedUrl = config.SELF_HOSTED_WEBHOOK_URL?.replace(
    "{{JOB_ID}}",
    jobId,
  );
  if (selfHostedUrl) {
    return {
      config: {
        url: selfHostedUrl,
        headers: {},
        metadata: {},
        events: ["completed", "failed", "page", "started"],
      },
      secret: await service.modules.webhooks.signingSecret({
        teamId,
        zeroDataRetention,
      }),
    };
  }

  return null;
}
