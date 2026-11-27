import { logger } from "./logger";
import { initializeEngineForcing } from "../scraper/WebScraper/utils/engine-forcing";
import { service } from "../service";

/**
 * Initializes startup dependencies required before the API server accepts traffic.
 */
export async function initializeApiStartupDependencies(): Promise<void> {
  try {
    await service.modules.blocklist.init();
    initializeEngineForcing();
  } catch (error: unknown) {
    logger.error("Failed to initialize API startup dependencies", {
      error,
    });
    throw error;
  }
}
