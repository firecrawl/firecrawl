import { Autumn } from "autumn-js";
import { config } from "../../config";
import { logger } from "../../lib/logger";

if (!config.AUTUMN_SECRET_KEY) {
  logger.warn(
    "AUTUMN_SECRET_KEY is not set - add AUTUMN_SECRET_KEY to enable Autumn",
  );
}

export const autumnClient = config.AUTUMN_SECRET_KEY
  ? new Autumn({ secretKey: config.AUTUMN_SECRET_KEY, timeoutMs: 2000 })
  : null;

// The historical/analytics aggregations (`events.aggregate` bucketed by day,
// optionally grouped by API key) make Autumn walk raw events, which routinely
// takes several seconds and scales with the team's event volume. The Autumn
// SDK only honors a timeout set at the client level — a per-call `timeoutMs`
// or `fetchOptions.signal` does NOT override a lower client default — so these
// calls need their own client with a longer timeout. The hot-path client above
// keeps its tight 2s budget for latency-sensitive balance checks.
export const autumnHistoricalClient = config.AUTUMN_SECRET_KEY
  ? new Autumn({ secretKey: config.AUTUMN_SECRET_KEY, timeoutMs: 15000 })
  : null;
