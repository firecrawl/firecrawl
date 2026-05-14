import axios from "axios";
import { config } from "../../config";
import { logger } from "../../lib/logger";

type CompletionNotificationPayload = {
  jobType: "scrape" | "crawl" | "batch_scrape";
  jobId: string;
  success: boolean;
  url?: string;
  numDocs?: number;
  error?: string;
  duration?: number;
  teamId: string;
};

function buildSlackPayload(payload: CompletionNotificationPayload) {
  const emoji = payload.success ? ":white_check_mark:" : ":x:";
  const status = payload.success ? "Completed" : "Failed";
  const title = `${emoji} Firecrawl ${payload.jobType.replace(/_/g, " ")} ${status}`;

  const fields: string[] = [`*Job ID:* \`${payload.jobId}\``];
  if (payload.url) fields.push(`*URL:* ${payload.url}`);
  if (payload.numDocs !== undefined)
    fields.push(`*Documents:* ${payload.numDocs}`);
  if (payload.duration)
    fields.push(`*Duration:* ${(payload.duration / 1000).toFixed(1)}s`);
  if (payload.error) fields.push(`*Error:* ${payload.error}`);

  return {
    text: title,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: title } },
      { type: "section", text: { type: "mrkdwn", text: fields.join("\n") } },
    ],
  };
}

function buildDiscordPayload(payload: CompletionNotificationPayload) {
  const color = payload.success ? 0x00ff00 : 0xff0000;
  const status = payload.success ? "Completed" : "Failed";

  const fields: { name: string; value: string; inline: boolean }[] = [
    { name: "Job ID", value: payload.jobId, inline: true },
    {
      name: "Type",
      value: payload.jobType.replace(/_/g, " "),
      inline: true,
    },
  ];

  if (payload.url)
    fields.push({ name: "URL", value: payload.url, inline: false });
  if (payload.numDocs !== undefined)
    fields.push({
      name: "Documents",
      value: String(payload.numDocs),
      inline: true,
    });
  if (payload.duration)
    fields.push({
      name: "Duration",
      value: `${(payload.duration / 1000).toFixed(1)}s`,
      inline: true,
    });
  if (payload.error)
    fields.push({ name: "Error", value: payload.error, inline: false });

  return {
    embeds: [
      {
        title: `Firecrawl ${payload.jobType.replace(/_/g, " ")} ${status}`,
        color,
        fields,
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

export async function sendCompletionNotification(
  payload: CompletionNotificationPayload,
): Promise<void> {
  const slackUrl = config.NOTIFY_SLACK_WEBHOOK_URL;
  const discordUrl = config.NOTIFY_DISCORD_WEBHOOK_URL;

  if (!slackUrl && !discordUrl) return;

  const promises: Promise<void>[] = [];

  if (slackUrl) {
    promises.push(
      axios
        .post(slackUrl, buildSlackPayload(payload), {
          headers: { "Content-Type": "application/json" },
        })
        .then(() => {
          logger.debug("Completion notification sent to Slack");
        })
        .catch(err => {
          logger.debug(`Failed to send Slack completion notification: ${err}`);
        }),
    );
  }

  if (discordUrl) {
    promises.push(
      axios
        .post(discordUrl, buildDiscordPayload(payload), {
          headers: { "Content-Type": "application/json" },
        })
        .then(() => {
          logger.debug("Completion notification sent to Discord");
        })
        .catch(err => {
          logger.debug(
            `Failed to send Discord completion notification: ${err}`,
          );
        }),
    );
  }

  await Promise.allSettled(promises);
}
