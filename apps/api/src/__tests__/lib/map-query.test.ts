import { describe, it, expect } from "@jest/globals";
import { buildMapUrlQuery, normalizeMapDomainUrl } from "../../lib/map-query";

describe("map-query helpers", () => {
  describe("normalizeMapDomainUrl", () => {
    it("strips www from a URL", () => {
      expect(normalizeMapDomainUrl("https://www.example.com")).toBe(
        "https://example.com",
      );
    });

    it("leaves non-www URL unchanged", () => {
      expect(normalizeMapDomainUrl("https://example.com")).toBe(
        "https://example.com",
      );
    });
  });

  describe("buildMapUrlQuery", () => {
    it("builds site query without search", () => {
      expect(buildMapUrlQuery("https://www.example.com")).toBe(
        "site:https://example.com",
      );
    });

    it("builds search+site query", () => {
      expect(buildMapUrlQuery("https://www.example.com", "pricing", false)).toBe(
        "pricing site:https://example.com",
      );
    });

    it("builds search query with allowExternalLinks", () => {
      expect(buildMapUrlQuery("https://www.example.com", "pricing", true)).toBe(
        "pricing https://example.com",
      );
    });
  });
});
