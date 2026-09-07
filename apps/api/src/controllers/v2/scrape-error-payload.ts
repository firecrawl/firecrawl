import {
  getTimeoutProcessingDetails,
  TransportableError,
} from "../../lib/error";
import { getSiteErrorDetails } from "../../scraper/scrapeURL/error";

export function scrapeErrorPayload(e: TransportableError) {
  const details = getTimeoutProcessingDetails(e) ?? getSiteErrorDetails(e);
  return {
    success: false as const,
    code: e.code,
    error: e.message,
    ...(details && { details }),
  };
}
