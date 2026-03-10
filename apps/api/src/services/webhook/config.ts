import { supabase_rr_service } from "../supabase";
import { WebhookConfig } from "./types";

import { config } from "../../config";
export async function getWebhookConfig(
  teamId: string,
  jobId: string,
  webhook?: WebhookConfig,
): Promise<{ config: WebhookConfig; secret?: string } | null> {
  // priority:
  // - webhook
  // - self-hosted environment variable
  if (webhook) {
    return { config: webhook, secret: await getHmacSecret(teamId) };
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
      secret: config.SELF_HOSTED_WEBHOOK_HMAC_SECRET,
    };
  }

  return null;
}

async function getHmacSecret(teamId: string): Promise<string | undefined> {
  if (config.USE_DB_AUTHENTICATION !== true) {
    return config.SELF_HOSTED_WEBHOOK_HMAC_SECRET;
  }

  try {
    const { data, error } = await supabase_rr_service
      .from("teams")
      .select("hmac_secret")
      .eq("id", teamId)
      .limit(1)
      .single();

    return error ? undefined : data?.hmac_secret;
  } catch {
    return undefined;
  }
}
