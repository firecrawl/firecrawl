/**
 * Browser behavior shared by /v2/browser sessions and sessions created from a
 * scrape. Option names and defaults follow the scrape API so an interact
 * session behaves like the page the scrape saw.
 */
export type BrowserOptions = {
  blockAds: boolean;
  profile?: { name: string; saveChanges: boolean };
  /** `country` is a lowercase ISO 3166-1 alpha-2 code. */
  location?: { country: string };
  proxy?: "basic" | "stealth";
};

export function browserOptionsFromScrape(options: {
  blockAds?: boolean;
  profile?: { name: string; saveChanges: boolean };
  location?: { country: string };
  proxy?: "basic" | "stealth" | "enhanced" | "auto";
}): BrowserOptions {
  const country = options.location?.country.toLowerCase();
  return {
    blockAds: options.blockAds ?? true,
    ...(options.profile ? { profile: options.profile } : {}),
    // us-generic and us-whitelist are not countries; they keep the default US egress.
    ...(country && /^[a-z]{2}$/.test(country) ? { location: { country } } : {}),
    proxy:
      options.proxy === "stealth" || options.proxy === "enhanced"
        ? "stealth"
        : "basic",
  };
}

export function isBrowserOptions(value: unknown): value is BrowserOptions {
  if (!value || typeof value !== "object") return false;
  const { blockAds, profile, location, proxy } = value as Record<
    string,
    unknown
  >;
  return (
    typeof blockAds === "boolean" &&
    (profile === undefined ||
      (typeof profile === "object" &&
        profile !== null &&
        typeof (profile as any).name === "string" &&
        typeof (profile as any).saveChanges === "boolean")) &&
    (location === undefined ||
      (typeof location === "object" &&
        location !== null &&
        typeof (location as any).country === "string")) &&
    (proxy === undefined || proxy === "basic" || proxy === "stealth")
  );
}

/** The Hangar create-request fields that carry these options. */
export function hangarBrowserOptions(options: BrowserOptions) {
  return {
    // uBlock Origin Lite covers ads, trackers and cookie notices.
    extensions: options.blockAds ? ["ublock"] : [],
    ...(options.profile
      ? {
          profile: {
            name: options.profile.name,
            save_changes: options.profile.saveChanges,
          },
        }
      : {}),
    // Scrape's stealth proxy is Hangar's mobile pool. Omitted fields keep
    // Hangar's defaults: country "us", type "basic".
    ...(options.location || options.proxy === "stealth"
      ? {
          proxy: {
            ...(options.location ? { country: options.location.country } : {}),
            type: options.proxy === "stealth" ? "mobile" : "basic",
          },
        }
      : {}),
  };
}
