import { createHash } from "node:crypto";
import { normalizeUrl } from "../../../lib/canonical-url";

export function canonicalizeUrl(raw: string): string {
  return normalizeUrl(String(raw || "")).toLowerCase();
}

export function computeGoalVersion(
  goal: string | null,
  subject: string | null,
  queries: string[],
): string {
  return createHash("sha256")
    .update([goal ?? "", subject ?? "", ...[...queries].sort()].join(" "))
    .digest("hex")
    .slice(0, 16);
}

export function stableSerpFingerprint(src: {
  url?: string;
  title?: string;
  snippet?: string;
  description?: string;
}): string {
  // Key on canonical URL only: snippets/titles drift between searches, so hashing them would re-flag, re-judge and re-bill the same URL.
  return createHash("sha256")
    .update(canonicalizeUrl(src.url ?? ""))
    .digest("hex")
    .slice(0, 24);
}
