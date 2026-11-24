import { validate as isUuid } from "uuid";
import { logger } from "./logger";
import { service } from "../service";

/**
 * Validates an `x-idempotency-key` header value and claims it via the active
 * idempotency module. Returns false for malformed or duplicate keys.
 */
export async function claimIdempotencyKey(
  rawHeader: string | string[],
  teamId: string,
): Promise<boolean> {
  const key = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (typeof key !== "string" || !isUuid(key)) {
    logger.debug("Invalid idempotency key provided in the request headers.");
    return false;
  }
  return service.modules.idempotency.claim(key, { teamId });
}
