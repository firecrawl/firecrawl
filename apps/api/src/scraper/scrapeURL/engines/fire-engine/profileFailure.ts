import { ScrapeProfileError } from "../../error";

/**
 * Fire-engine#830 reports a saved-profile load or restore failure as
 * `errorData.code === "PROFILE_FAILED"` on the existing scrape-failure body.
 * `failedSchema` strips unknown keys, so this reads the raw body.
 *
 * Absent or unrecognized `errorData` returns null. Workers that predate the
 * typed error keep the previous engine-failure path.
 */
export function scrapeProfileErrorFromFireEngine(
  body: unknown,
): ScrapeProfileError | null {
  if (!body || typeof body !== "object") return null;
  const errorData = (body as { errorData?: unknown }).errorData;
  if (!errorData || typeof errorData !== "object") return null;
  if ((errorData as { code?: unknown }).code !== "PROFILE_FAILED") return null;

  const details = (errorData as { details?: unknown }).details;
  const detail =
    details && typeof details === "object"
      ? (details as {
          step?: unknown;
          reason?: unknown;
          statusCode?: unknown;
        })
      : {};
  const step =
    typeof detail.step === "string" && detail.step.length > 0
      ? detail.step
      : "load";
  const reason =
    typeof detail.reason === "string" && detail.reason.length > 0
      ? detail.reason
      : "UNKNOWN";
  const statusCode =
    typeof detail.statusCode === "number" &&
    Number.isInteger(detail.statusCode) &&
    detail.statusCode >= 0
      ? detail.statusCode
      : undefined;
  return new ScrapeProfileError(step, reason, statusCode);
}
