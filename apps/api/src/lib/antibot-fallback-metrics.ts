import { Counter } from "prom-client";

export const scrapeEngineAttemptCounter = new Counter({
  name: "firecrawl_scrape_engine_attempts_total",
  help: "Normal-engine scrape attempts and their outcome",
  labelNames: ["engine", "outcome"],
});

export const antibotFailureCounter = new Counter({
  name: "firecrawl_antibot_failures_total",
  help: "Responses classified as anti-bot blocks, by confidence and vendor",
  labelNames: ["confidence", "vendor"],
});

export const camoufoxFallbackCounter = new Counter({
  name: "firecrawl_camoufox_fallback_total",
  help: "Camoufox stealth-fallback attempts by outcome",
  labelNames: ["outcome"],
});

export const flaresolverrFallbackCounter = new Counter({
  name: "firecrawl_flaresolverr_fallback_total",
  help: "FlareSolverr challenge-solver fallback attempts by outcome",
  labelNames: ["outcome"],
});

export const pmcBiocCounter = new Counter({
  name: "firecrawl_pmc_bioc_total",
  help: "PMC BioC official-source adapter attempts by outcome",
  labelNames: ["outcome"],
});

export const terminalNotFoundCounter = new Counter({
  name: "firecrawl_scrape_not_found_total",
  help: "Scrapes that terminated on a 404/410 (not retryable by stealth)",
  labelNames: ["status"],
});
