import { EventDataMap, EventDefinitionSlug } from "./data-schemas";
import { config } from "../../config";
import { logger } from "../../lib/logger";

const TRACK_SOURCE = "firecrawl-api";
const TRACK_TIMEOUT_MS = 5000;

type TrackStoreResponse = {
  tracks?: Array<{ track_uuid: string | null }>;
};

/**
 * Emit a track by POSTing it to the configured tracks endpoint. Never throws:
 * on any failure it logs and returns null, so tracking cannot break the calling
 * flow.
 * @param definitionSlug The event definition slug
 * @param data Event properties sent with the track
 * @returns The stored track UUID, or null if the write did not succeed
 */
export async function trackEvent<T extends EventDefinitionSlug>(
  definitionSlug: T,
  data: EventDataMap[T],
): Promise<string | null> {
  const url = config.FIREBRAIN_TRACKS_URL;
  const apiKey = config.FIREBRAIN_TRACKS_API_KEY?.trim();
  if (!url || !apiKey) {
    logger.warn(
      "Skipping track: FIREBRAIN_TRACKS_URL or FIREBRAIN_TRACKS_API_KEY is unset",
    );
    return null;
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        definition: definitionSlug,
        source: TRACK_SOURCE,
        properties: data,
      }),
      signal: AbortSignal.timeout(TRACK_TIMEOUT_MS),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      logger.error("Error storing track", {
        module: "ledger/tracking",
        definitionSlug,
        status: response.status,
        detail: detail.slice(0, 300),
      });
      return null;
    }

    const result = (await response.json()) as TrackStoreResponse;
    return result.tracks?.[0]?.track_uuid ?? null;
  } catch (error) {
    logger.error("Error tracking event", {
      module: "ledger/tracking",
      definitionSlug,
      error,
    });
    return null;
  }
}
