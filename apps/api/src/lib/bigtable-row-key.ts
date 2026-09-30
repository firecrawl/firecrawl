import crypto from "crypto";

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
