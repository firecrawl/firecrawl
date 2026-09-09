import crypto from "crypto";
import { config } from "../config";

// AES-256-GCM encryption for org-scoped partner credentials at rest (SIEM
// destination secrets, Zscaler OAuth client secrets). The key lives outside
// the database (env), and the org ID is bound in as AAD so a ciphertext
// pasted onto another org's row fails authentication instead of decrypting.

const GCM_PREFIX = "gcm:";

function getEncryptionKey(): Buffer {
  const raw = config.SIEM_LOGGING_ENCRYPTION_KEY?.trim();
  if (!raw) {
    throw new Error("SIEM_LOGGING_ENCRYPTION_KEY is not configured");
  }

  let key: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, "hex");
  } else {
    const decoded = Buffer.from(raw, "base64");
    if (decoded.length === 32) key = decoded;
  }

  if (!key || key.length !== 32) {
    throw new Error(
      "SIEM_LOGGING_ENCRYPTION_KEY must be a 32-byte hex or base64 value",
    );
  }
  return key;
}

export function encryptOrgSecret(secret: string, orgId: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(orgId, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${GCM_PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

export function decryptOrgSecret(stored: string, orgId: string): string {
  if (!stored.startsWith(GCM_PREFIX)) {
    throw new Error("Stored secret is not encrypted with AES-256-GCM");
  }

  const [ivB64, tagB64, ciphertextB64] = stored
    .slice(GCM_PREFIX.length)
    .split(":");
  if (!ivB64 || !tagB64 || !ciphertextB64) {
    throw new Error("Malformed encrypted secret");
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAAD(Buffer.from(orgId, "utf8"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
