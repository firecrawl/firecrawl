import { config } from "../../../../config";

/**
 * Whether the fire-engine scraping service is configured for this
 * deployment. When true, file downloads (PDFs, documents) are always
 * routed through the browser engines — fire-engine fetches the file and
 * hands it to the file engines as a prefetch — and the file engines'
 * own direct undici downloads stay reachable only in self-hosted
 * deployments (where this is false) or under an explicit forceEngine pin.
 *
 * Evaluated from config at module load, exactly like the historical
 * inline check in engines/index.ts. Kept in its own module so the file
 * engines can read it without importing engines/index.ts (which would
 * create a circular import: engines/index imports the file engines to
 * build its handler table).
 */
export const useFireEngine =
  config.FIRE_ENGINE_BETA_URL !== "" &&
  config.FIRE_ENGINE_BETA_URL !== undefined;
