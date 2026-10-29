import { scrapeRequestSchema } from "../types";

describe("v2 scrapeRequestSchema — branding mode", () => {
  const parse = (format: unknown) =>
    scrapeRequestSchema.safeParse({
      url: "https://example.com",
      formats: [format],
    });

  it("accepts branding with and without a mode", () => {
    expect(parse({ type: "branding" }).success).toBe(true);
    expect(parse("branding").success).toBe(true);
    for (const mode of ["auto", "fast", "standard"]) {
      const result = parse({ type: "branding", mode });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.formats).toContainEqual({ type: "branding", mode });
      }
    }
  });

  it("rejects an unknown mode", () => {
    expect(parse({ type: "branding", mode: "turbo" }).success).toBe(false);
  });
});
