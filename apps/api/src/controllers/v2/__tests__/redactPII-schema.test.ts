import { scrapeRequestSchema } from "../types";

describe("v2 scrapeRequestSchema — redactPII", () => {
  const baseUrl = "https://example.com";

  // ---- boolean form -------------------------------------------------------

  it("accepts redactPII: true with markdown output", () => {
    const result = scrapeRequestSchema.safeParse({
      url: baseUrl,
      formats: ["markdown"],
      redactPII: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // `true` normalizes to a defaults object via the Zod transform.
      expect(result.data.redactPII).toMatchObject({
        mode: "accurate",
        replaceStyle: "tag",
      });
    }
  });

  it("normalizes redactPII: false to unset", () => {
    const result = scrapeRequestSchema.safeParse({
      url: baseUrl,
      formats: ["markdown"],
      redactPII: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.redactPII).toBeUndefined();
    }
  });

  it("accepts redactPII unset (treated as off)", () => {
    const result = scrapeRequestSchema.safeParse({
      url: baseUrl,
      formats: ["markdown"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.redactPII).toBeUndefined();
    }
  });

  it("accepts redactPII: true with default formats", () => {
    const result = scrapeRequestSchema.safeParse({
      url: baseUrl,
      redactPII: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.formats).toEqual([{ type: "markdown" }]);
      expect(result.data.redactPII).toMatchObject({
        mode: "accurate",
        replaceStyle: "tag",
      });
    }
  });

  it("rejects the removed pii format", () => {
    const result = scrapeRequestSchema.safeParse({
      url: baseUrl,
      formats: ["pii"],
      redactPII: true,
    });
    expect(result.success).toBe(false);
  });

  // ---- object form --------------------------------------------------------

  it("accepts an explicit mode in the object form", () => {
    const result = scrapeRequestSchema.safeParse({
      url: baseUrl,
      formats: ["markdown"],
      redactPII: { mode: "aggressive" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.redactPII).toMatchObject({
        mode: "aggressive",
        replaceStyle: "tag",
      });
    }
  });

  it("accepts each documented mode", () => {
    for (const mode of ["accurate", "aggressive", "fast"] as const) {
      const result = scrapeRequestSchema.safeParse({
        url: baseUrl,
        formats: ["markdown"],
        redactPII: { mode },
      });
      expect(result.success).toBe(true);
      if (result.success && result.data.redactPII) {
        expect(result.data.redactPII.mode).toBe(mode);
      }
    }
  });

  it("rejects an unknown mode", () => {
    const result = scrapeRequestSchema.safeParse({
      url: baseUrl,
      formats: ["markdown"],
      redactPII: { mode: "model" }, // internal mode name, not exposed
    });
    expect(result.success).toBe(false);
  });

  it("accepts an entities allowlist", () => {
    const result = scrapeRequestSchema.safeParse({
      url: baseUrl,
      formats: ["markdown"],
      redactPII: { entities: ["EMAIL", "PHONE"] },
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.redactPII) {
      expect(result.data.redactPII.entities).toEqual(["EMAIL", "PHONE"]);
    }
  });

  it("rejects an unknown entity", () => {
    const result = scrapeRequestSchema.safeParse({
      url: baseUrl,
      formats: ["markdown"],
      redactPII: { entities: ["EMAIL", "NICKNAME"] },
    });
    expect(result.success).toBe(false);
  });

  it("accepts each replaceStyle", () => {
    for (const replaceStyle of ["tag", "mask", "remove"] as const) {
      const result = scrapeRequestSchema.safeParse({
        url: baseUrl,
        formats: ["markdown"],
        redactPII: { replaceStyle },
      });
      expect(result.success).toBe(true);
      if (result.success && result.data.redactPII) {
        expect(result.data.redactPII.replaceStyle).toBe(replaceStyle);
      }
    }
  });

  it("rejects unknown fields in the object form (strict)", () => {
    const result = scrapeRequestSchema.safeParse({
      url: baseUrl,
      formats: ["markdown"],
      redactPII: { mode: "accurate", typo: "yes" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts the object form with markdown output", () => {
    const result = scrapeRequestSchema.safeParse({
      url: baseUrl,
      formats: ["markdown"],
      redactPII: { mode: "aggressive" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.redactPII).toMatchObject({
        mode: "aggressive",
        replaceStyle: "tag",
      });
    }
  });

  // ---- type rejection -----------------------------------------------------

  it("rejects redactPII as a string", () => {
    const result = scrapeRequestSchema.safeParse({
      url: baseUrl,
      formats: ["markdown"],
      redactPII: "yes",
    });
    expect(result.success).toBe(false);
  });

  it("rejects redactPII as a number", () => {
    const result = scrapeRequestSchema.safeParse({
      url: baseUrl,
      formats: ["markdown"],
      redactPII: 1,
    });
    expect(result.success).toBe(false);
  });

  // ---- onlyMainContent ------------------------------------------------------

  it("preserves explicit onlyMainContent: false when redactPII is enabled", () => {
    const result = scrapeRequestSchema.safeParse({
      url: baseUrl,
      formats: ["markdown"],
      redactPII: true,
      onlyMainContent: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.onlyMainContent).toBe(false);
    }
  });

  it("keeps the default onlyMainContent: true when redactPII is enabled", () => {
    const result = scrapeRequestSchema.safeParse({
      url: baseUrl,
      redactPII: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.onlyMainContent).toBe(true);
    }
  });

  it("leaves onlyMainContent alone when redactPII is unset", () => {
    const result = scrapeRequestSchema.safeParse({
      url: baseUrl,
      formats: ["markdown"],
      onlyMainContent: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.onlyMainContent).toBe(false);
    }
  });
});
