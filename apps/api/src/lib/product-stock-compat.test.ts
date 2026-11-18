import { describe, expect, it } from "vitest";
import {
  acceptsNullStock,
  withLegacyStockDefaults,
} from "./product-stock-compat";

describe("acceptsNullStock", () => {
  it.each([
    ["python-sdk@4.57.0", false],
    ["python-sdk@4.58.0", true],
    ["python-sdk@4.58.1", true],
    ["python-sdk@5.0.0", true],
    ["python-sdk@4.30.3", false],
    ["python-sdk.some-agent@4.57.0", false],
    ["python-sdk.some-agent@4.58.0", true],
    ["js-sdk@4.54.0", false],
    ["js-sdk@4.55.0", true],
    ["js-sdk.bullmq@4.51.0", false],
    ["js-sdk.bullmq@4.55.0", true],
    ["js-sdk@0.1.0", false],
    ["js-sdk@1.0.1822", false],
    ["java-sdk@1.18.0", false],
    ["java-sdk@1.18.9", false],
    ["java-sdk@1.19.0", true],
    ["go-sdk@1.16.11", false],
    ["go-sdk@1.17.0", true],
    ["rust-sdk@2.21.10", false],
    ["rust-sdk@2.22.0", true],
    ["ruby-sdk@1.17.8", false],
    ["ruby-sdk@1.18.0", true],
    ["php-sdk@1.16.7", false],
    ["php-sdk@1.17.0", true],
    ["dotnet-sdk@1.15.3", false],
    ["dotnet-sdk@1.16.0", true],
  ])("%s -> %s", (origin, expected) => {
    expect(acceptsNullStock(origin)).toBe(expected);
  });

  it.each([
    "python-sdk",
    "python-sdk@",
    "python-sdk@unknown",
    "python-sdk@4.58.0-beta.1",
    "js-sdk@4.55.0rc1",
    "java-sdk@x.y.z",
  ])("treats a known SDK with an unusable version as old: %s", origin => {
    expect(acceptsNullStock(origin)).toBe(false);
  });

  it("normalizes case, whitespace and a trailing integration tag", () => {
    expect(acceptsNullStock(" Python-SDK@4.57.0 ")).toBe(false);
    expect(acceptsNullStock("js-sdk@4.24.0|cli")).toBe(false);
    expect(acceptsNullStock("python-sdk@4.58")).toBe(true);
  });

  it.each([
    undefined,
    null,
    "",
    "api",
    "api|n8n",
    "website",
    "mcp-server",
    "mcp-ua-claude-user@3.40.0",
    "cli.claude-code@1.29.0",
    "firecrawl-convex@1.0.0",
    "elixir-sdk@1.0.0",
    "xpython-sdk@1.0.0",
  ])("gives null to %s", origin => {
    expect(acceptsNullStock(origin)).toBe(true);
  });
});

describe("withLegacyStockDefaults", () => {
  it("maps null, missing and non-boolean stock to true and keeps known values", () => {
    const product = {
      title: "T",
      url: "https://shop.test/p",
      variants: [
        { id: "a", availability: { inStock: true, text: "In stock" } },
        { id: "b", availability: { inStock: false } },
        { id: "c", availability: { inStock: null } },
        { id: "d", availability: {} },
        { id: "e", availability: null },
        { id: "f" },
        { id: "g", availability: { inStock: "yes" } },
      ],
    };

    const out = withLegacyStockDefaults(product);

    expect(out.variants.map(v => (v as any).availability)).toEqual([
      { inStock: true, text: "In stock" },
      { inStock: false },
      { inStock: true },
      { inStock: true },
      { inStock: true },
      { inStock: true },
      { inStock: true },
    ]);
    expect(product.variants[2].availability).toEqual({ inStock: null });
  });

  it("leaves a product without a variants array untouched", () => {
    const product = { title: "T", url: "u" } as any;
    expect(withLegacyStockDefaults(product)).toBe(product);
  });
});
