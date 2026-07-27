import { describe, expect, it } from "vitest";
import { withoutAuditMetadata } from "./redaction";

describe("SIEM logging metadata redaction", () => {
  it("removes top-level and nested audit metadata without mutating input", () => {
    const input = {
      auditMetadata: { username: "top@example.com" },
      scrapeOptions: {
        auditMetadata: { username: "nested@example.com" },
        formats: ["markdown"],
      },
    };

    expect(withoutAuditMetadata(input)).toEqual({
      scrapeOptions: { formats: ["markdown"] },
    });
    expect(input.auditMetadata).toEqual({ username: "top@example.com" });
    expect(input.scrapeOptions.auditMetadata).toEqual({
      username: "nested@example.com",
    });
  });
});
