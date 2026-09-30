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
