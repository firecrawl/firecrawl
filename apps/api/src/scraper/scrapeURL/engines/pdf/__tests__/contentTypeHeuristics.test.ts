import { shouldRemovePdfFeatureForContentType } from "../contentTypeHeuristics";

describe("shouldRemovePdfFeatureForContentType", () => {
  it("does not remove PDF feature for application/pdf", () => {
    expect(shouldRemovePdfFeatureForContentType("application/pdf")).toBe(false);
    expect(
      shouldRemovePdfFeatureForContentType("application/pdf; charset=binary"),
    ).toBe(false);
  });

  it("does not remove PDF feature for application/octet-stream", () => {
    expect(
      shouldRemovePdfFeatureForContentType("application/octet-stream"),
    ).toBe(false);
  });

  it("removes PDF feature for html responses", () => {
    expect(shouldRemovePdfFeatureForContentType("text/html")).toBe(true);
    expect(
      shouldRemovePdfFeatureForContentType("text/html; charset=UTF-8"),
    ).toBe(true);
    expect(shouldRemovePdfFeatureForContentType("application/xhtml+xml")).toBe(
      true,
    );
  });

  it("removes PDF feature for non-html text responses", () => {
    expect(shouldRemovePdfFeatureForContentType("text/plain")).toBe(true);
  });

  it("does not remove when content type is missing", () => {
    expect(shouldRemovePdfFeatureForContentType(null)).toBe(false);
    expect(shouldRemovePdfFeatureForContentType(undefined)).toBe(false);
    expect(shouldRemovePdfFeatureForContentType("")).toBe(false);
  });
});
