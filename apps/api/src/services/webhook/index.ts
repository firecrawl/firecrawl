import { logger as _logger } from "../../lib/logger";
import { getWebhookConfig } from "./config";
import { WebhookConfig } from "./types";
import { WebhookSender } from "./delivery";

export async function createWebhookSender(params: {
  teamId: string;
  jobId: string;
  webhook?: WebhookConfig;
  v0: boolean;
}): Promise<WebhookSender | null> {
  const config = await getWebhookConfig(
    params.teamId,
    params.jobId,
    params.webhook,
  );
  if (!config) {
    return null;
  }

  return new WebhookSender(config.config, config.secret, {
    teamId: params.teamId,
    jobId: params.jobId,
    v0: params.v0,
  });
}

export {
  getWebhookInsertQueueLength,
  processWebhookInsertJobs,
} from "./delivery";
export { WebhookEvent } from "./types";
export { shutdownWebhookQueue } from "./queue";
