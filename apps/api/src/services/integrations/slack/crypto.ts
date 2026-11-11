import crypto from "crypto";
import { config } from "../../../config";

const PLAINTEXT_PREFIX = "plain:";
const GCM_PREFIX = "gcm:";

// Accepts a 32-byte key as hex (64 chars) or base64. Returns null ONLY when the
// key is unset. A key that is set but malformed throws, so a misconfiguration
// never silently downgrades to plaintext storage.
function getKey(): Buffer | null {
  const raw = config.SLACK_TOKEN_ENCRYPTION_KEY?.trim();
  if (!raw) return null;

  let key: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, "hex");
  } else {
    try {
      const decoded = Buffer.from(raw, "base64");
      if (decoded.length === 32) key = decoded;
    } catch {
      key = null;
    }
  }

  if (!key || key.length !== 32) {
    // A configured-but-invalid key is operator error. Fail loudly rather than
    // silently downgrading to plaintext token storage.
    throw new Error(
      "SLACK_TOKEN_ENCRYPTION_KEY is set but is not a valid 32-byte hex or base64 value",
    );
  }
  return key;
}

// Encrypts a Slack bot token for storage. Without a key, production refuses to
// store the token; other environments store it with a `plain:` marker.
export function encryptSlackToken(token: string): string {
  const key = getKey();
  if (!key) {
    if (config.ENV === "production") {
      throw new Error(
        "SLACK_TOKEN_ENCRYPTION_KEY is not set; refusing to store a plaintext Slack token in production",
      );
    }
    return `${PLAINTEXT_PREFIX}${token}`;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${GCM_PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

// Reverses encryptSlackToken. Throws when a ciphertext requires a key that is
// missing or invalid so we never silently post with a broken token.
export function decryptSlackToken(stored: string): string {
  if (stored.startsWith(PLAINTEXT_PREFIX)) {
    return stored.slice(PLAINTEXT_PREFIX.length);
  }
  if (stored.startsWith(GCM_PREFIX)) {
    const key = getKey();
    if (!key) {
      throw new Error(
        "Slack token is encrypted but SLACK_TOKEN_ENCRYPTION_KEY is missing/invalid",
      );
    }
    const [ivB64, tagB64, ctB64] = stored.slice(GCM_PREFIX.length).split(":");
    if (!ivB64 || !tagB64 || !ctB64) {
      throw new Error("Malformed encrypted Slack token");
    }
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(ivB64, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ctB64, "base64")),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  }
  // Legacy/unknown format: assume it's a raw token.
  return stored;
}
