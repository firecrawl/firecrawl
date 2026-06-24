type DisableableFeature = "crawl" | "map";

const TRUE_STRING = "true";

const featureNames: Record<DisableableFeature, string> = {
  crawl: "Crawl",
  map: "Map",
};

function isEnvToggleEnabled(name: string): boolean {
  return process.env[name]?.toLowerCase() === TRUE_STRING;
}

export function isCrawlDisabled(): boolean {
  return isEnvToggleEnabled("DISABLE_CRAWL");
}

export function isMapDisabled(): boolean {
  return isEnvToggleEnabled("DISABLE_MAP");
}

export function featureDisabledBody(feature: DisableableFeature) {
  return {
    success: false as const,
    error: `${featureNames[feature]} endpoint disabled by server configuration`,
  };
}
