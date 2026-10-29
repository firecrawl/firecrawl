import { createHash } from "crypto";

// mirrors the uuid package's validate(): RFC 9562 plus the nil/max specials
const UUID_RE =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;

// RFC 4122 v5 (namespaced SHA-1), matching the uuid package's v5()
function uuidv5(name: string, namespace: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = createHash("sha1")
    .update(ns)
    .update(Buffer.from(name, "utf8"))
    .digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isValidUuid(value: string): boolean {
  return UUID_RE.test(value);
}

// owner IDs can sometimes be non-UUID, so normalize them to avoid breakage
const normalizedUUIDNamespace = "0f38e00e-d7ee-4b77-8a7a-a787a3537ca2";
export function normalizeOwnerId(
  ownerId: string | undefined | null,
): string | null {
  if (typeof ownerId !== "string") return null;
  if (UUID_RE.test(ownerId)) return ownerId;
  return uuidv5(ownerId, normalizedUUIDNamespace);
}
