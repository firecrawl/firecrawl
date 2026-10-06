/**
 * Browser behavior shared by /v2/browser sessions and sessions created from a
 * scrape. Option names and defaults follow the scrape API so an interact
 * session behaves like the page the scrape saw.
 */
export type BrowserOptions = {
  blockAds: boolean;
  profile?: { name: string; saveChanges: boolean };
};

export function browserOptionsFromScrape(options: {
  blockAds?: boolean;
  profile?: { name: string; saveChanges: boolean };
}): BrowserOptions {
  return {
    blockAds: options.blockAds ?? true,
    ...(options.profile ? { profile: options.profile } : {}),
  };
}

export function isBrowserOptions(value: unknown): value is BrowserOptions {
  if (!value || typeof value !== "object") return false;
  const { blockAds, profile } = value as Record<string, unknown>;
  return (
    typeof blockAds === "boolean" &&
    (profile === undefined ||
      (typeof profile === "object" &&
        profile !== null &&
        typeof (profile as any).name === "string" &&
        typeof (profile as any).saveChanges === "boolean"))
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
  };
}
