import { z } from "zod";

// Hangar limits profile names to 1–128 UTF-8 bytes, not characters.
export const browserProfileNameSchema = z
  .string()
  .min(1)
  .refine(
    value => Buffer.byteLength(value, "utf8") <= 128,
    "Profile name must be between 1 and 128 UTF-8 bytes.",
  );

export function browserProfileDeletedKey(teamId: string, name: string): string {
  return `browser-profile-deleted:${JSON.stringify([teamId, name])}`;
}

// Screenshot capture and blockMedia: false are served by fire-engine's render
// browser. That browser rejects saved profiles ("Profiles require chrome-cdp").
export const PROFILE_RENDER_UNSUPPORTED_MESSAGE =
  "Profiles cannot be used with screenshots or with options that require the render browser. Saved profiles run on the standard browser, which does not support that path yet. Remove the screenshot format or screenshot action, or omit the profile.";

export function scrapeRequestsProfileOnRenderBrowser(options: {
  profile?: unknown;
  formats?: Array<{ type?: string }>;
  actions?: Array<{ type?: string }>;
}): boolean {
  if (options.profile === undefined) return false;
  return (
    options.formats?.some(format => format.type === "screenshot") === true ||
    options.actions?.some(action => action.type === "screenshot") === true
  );
}
