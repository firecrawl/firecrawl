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
