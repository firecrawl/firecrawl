import axios from "axios";
import { logger } from "../../../src/lib/logger";

import { config } from "../../config";
export async function sendSlackWebhook(
  message: string,
  alertEveryone: boolean = false,
  webhookUrl: string = config.SLACK_WEBHOOK_URL ?? "",
) {
  const messagePrefix = alertEveryone ? "<!channel> " : "";
  const payload = {
    text: `${messagePrefix} ${message}`,
  };

  try {
    const response = await axios.post(webhookUrl, payload, {
      headers: {
        "Content-Type": "application/json",
      },
    });
    logger.info("Webhook sent successfully:", response.data);
  } catch (error) {
    logger.debug(`Error sending webhook: ${error}`);
  }
}
