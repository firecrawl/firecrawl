import crypto from "crypto";

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Whether `id` could name a row at all. Every Bigtable job row is keyed by a
 * UUIDv7, so any other id has no row to find: callers answer "not found"
 * without a read, rather than treating the key error as an outage.
 */
export function isUuidV7Id(id: string): boolean {
  return UUID_V7.test(id);
}

export function saltedUuidV7RowKey(id: string): string {
  if (!UUID_V7.test(id)) {
    throw new Error(`Expected a UUIDv7 row id, received ${id}`);
  }

  const uuid = Buffer.from(id.replaceAll("-", ""), "hex");
  const salt = crypto
    .createHash("sha256")
    .update(uuid)
    .digest()
    .subarray(0, 1)
    .toString("hex");
  return salt + uuid.toString("base64url");
}
