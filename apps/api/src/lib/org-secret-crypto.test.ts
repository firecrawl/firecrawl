import crypto from "crypto";
import { afterEach, describe, expect, it } from "vitest";
import { config } from "../config";
import { decryptOrgSecret, encryptOrgSecret } from "./org-secret-crypto";

const originalKey = config.SIEM_LOGGING_ENCRYPTION_KEY;

afterEach(() => {
  config.SIEM_LOGGING_ENCRYPTION_KEY = originalKey;
});

describe("Org secret encryption", () => {
  it("round-trips with AES-256-GCM without storing plaintext", () => {
    config.SIEM_LOGGING_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
    const encrypted = encryptOrgSecret("client-secret-value", "org-one");

    expect(encrypted).toMatch(/^gcm:/);
    expect(encrypted).not.toContain("client-secret-value");
    expect(decryptOrgSecret(encrypted, "org-one")).toBe("client-secret-value");
    expect(() => decryptOrgSecret(encrypted, "org-two")).toThrow();
  });

  it("refuses to store a secret without a valid external key", () => {
    config.SIEM_LOGGING_ENCRYPTION_KEY = undefined;
    expect(() => encryptOrgSecret("secret", "org-one")).toThrow(
      "SIEM_LOGGING_ENCRYPTION_KEY is not configured",
    );

    config.SIEM_LOGGING_ENCRYPTION_KEY = "too-short";
    expect(() => encryptOrgSecret("secret", "org-one")).toThrow(
      "must be a 32-byte",
    );
  });
});
