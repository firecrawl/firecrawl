import { createHash, timingSafeEqual } from "node:crypto";

// Compares SHA-256 digests so neither content nor length leaks through timing.
export function timingSafeSecretEqual(
  provided: unknown,
  expected?: string,
): boolean {
  if (typeof provided !== "string" || !provided || !expected) return false;
  const left = createHash("sha256").update(provided).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}
