import { config } from "../../config";
import { fetch } from "undici";
import { logger } from "../../lib/logger";

export async function reportExchangeUsageBilling(
  requestId: string,
  billingReference?: string,
): Promise<boolean> {
  if (!config.FIRE_EXCHANGE_URL || !config.EXCHANGE_INTERNAL_SECRET) {
    logger.error("Exchange billing report is not configured", { requestId });
    return false;
  }
  const endpoint = URL.parse(config.FIRE_EXCHANGE_URL);
  if (endpoint?.protocol !== "https:") {
    logger.error("Exchange billing report requires an HTTPS endpoint", {
      requestId,
    });
    return false;
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/v1/usage-events/billing`;
  endpoint.search = "";
  endpoint.hash = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(endpoint.toString(), {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          "x-exchange-secret": config.EXCHANGE_INTERNAL_SECRET,
        },
        body: JSON.stringify([
          {
            requestId,
            status: "confirmed",
            ...(billingReference ? { billingReference } : {}),
          },
        ]),
        signal: AbortSignal.timeout(5000),
      });
      await response.arrayBuffer();
      if (response.ok) return true;
      if (response.status < 500 && response.status !== 429) break;
    } catch {}
  }
  logger.error("Exchange billing confirmation needs reconciliation", {
    requestId,
    billingReference,
  });
  return false;
}
