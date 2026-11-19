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

// Screenshot capture, and a branding request that also needs visual output,
// are served by fire-engine's render browser. That browser rejects saved
// profiles ("Profiles require chrome-cdp"). A YouTube page does the same via
// blockMedia: false, but that depends on the URL, so the engine guard handles
// it. Branding with only DOM actions stays on the standard browser.
const DOM_SAFE_ACTION_TYPES: ReadonlySet<string> = new Set([
  "wait",
  "click",
  "write",
  "press",
  "scroll",
  "scrape",
  "executeJavascript",
]);

export const PROFILE_RENDER_UNSUPPORTED_MESSAGE =
  "Profiles cannot be used with screenshots or with options that require the render browser. Saved profiles run on the standard browser, which does not support that path yet. Remove the screenshot format or screenshot action, or omit the profile.";

export function scrapeRequestsProfileOnRenderBrowser(options: {
  profile?: unknown;
  formats?: Array<{ type?: string }>;
  actions?: Array<{ type?: string }>;
}): boolean {
  if (options.profile === undefined) return false;
  const formats = options.formats ?? [];
  const actions = options.actions ?? [];
  if (
    formats.some(format => format.type === "screenshot") ||
    actions.some(action => action.type === "screenshot")
  ) {
    return true;
  }
  // Mirrors shouldForceNonRender without the YouTube postprocessor, which
  // needs the URL. Branding loads media (blockMedia: false). It stays off the
  // render browser only when nothing else needs visual output.
  if (!formats.some(format => format.type === "branding")) return false;
  return (
    formats.some(
      format => format.type === "audio" || format.type === "video",
    ) ||
    actions.some(
      action =>
        action.type !== undefined && !DOM_SAFE_ACTION_TYPES.has(action.type),
    )
  );
}
