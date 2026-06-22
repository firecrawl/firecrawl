import { describe, test, expect, jest } from "@jest/globals";
import { scrape } from "../../../v2/methods/scrape";

describe("JS SDK v2 product format", () => {
  function makeHttp(postImpl: (url: string, data: any) => any) {
    return { post: jest.fn(async (u: string, d: any) => postImpl(u, d)) } as any;
  }

  test("scrape with product format returns product data", async () => {
    const mockResponse = {
      status: 200,
      data: {
        success: true,
        data: {
          markdown: "# Example Product",
          product: {
            title: "Acme Running Shoe",
            brand: "Acme",
            category: "Footwear",
            url: "https://example.com/shoe",
            description: "A lightweight running shoe.",
            variants: [
              {
                id: "default",
                images: [{ url: "https://example.com/shoe.jpg", alt: "Acme shoe" }],
                price: { amount: 89.99, currency: "USD", formatted: "$89.99" },
                sale: { originalPrice: { amount: 129.99, currency: "USD", formatted: "$129.99" } },
                availability: { inStock: true, text: "In stock" }
              }
            ]
          }
        }
      }
    };

    const http = makeHttp(() => mockResponse);
    const result = await scrape(http, "https://example.com", { formats: ["product"] });

    expect(result.product).toBeDefined();
    expect(result.product?.title).toBe("Acme Running Shoe");
    expect(result.product?.brand).toBe("Acme");
    expect(result.product?.variants?.[0]?.price?.amount).toBe(89.99);
    expect(result.product?.variants?.[0]?.price?.currency).toBe("USD");
    expect(result.product?.variants?.[0]?.sale?.originalPrice?.amount).toBe(129.99);
    expect(result.product?.variants?.[0]?.availability?.inStock).toBe(true);
    expect(result.product?.variants?.[0]?.images?.[0]?.url).toBe("https://example.com/shoe.jpg");
  });

  test("scrape with product and markdown formats returns both", async () => {
    const mockResponse = {
      status: 200,
      data: {
        success: true,
        data: {
          markdown: "# Example Content",
          product: {
            title: "Acme Mug",
            url: "https://example.com/mug",
            variants: [
              {
                price: { amount: 12.5, currency: "USD" },
                availability: { inStock: true }
              }
            ]
          }
        }
      }
    };

    const http = makeHttp(() => mockResponse);
    const result = await scrape(http, "https://example.com", { formats: ["markdown", "product"] });

    expect(result.markdown).toBe("# Example Content");
    expect(result.product).toBeDefined();
    expect(result.product?.title).toBe("Acme Mug");
    expect(result.product?.variants?.[0]?.price?.amount).toBe(12.5);
  });

  test("scrape without product format does not return product", async () => {
    const mockResponse = {
      status: 200,
      data: {
        success: true,
        data: {
          markdown: "# Example"
        }
      }
    };

    const http = makeHttp(() => mockResponse);
    const result = await scrape(http, "https://example.com", { formats: ["markdown"] });

    expect(result.markdown).toBe("# Example");
    expect(result.product).toBeUndefined();
  });

  test("non-product page scraped with product format yields a warning and no product", async () => {
    const mockResponse = {
      status: 200,
      data: {
        success: true,
        data: {
          markdown: "# Blog Post",
          warning: "No product found on this page."
        }
      }
    };

    const http = makeHttp(() => mockResponse);
    const result = await scrape(http, "https://example.com", { formats: ["product"] });

    expect(result.product).toBeUndefined();
    expect(result.warning).toContain("No product found");
  });

  test("product format with variants populated", async () => {
    const mockResponse = {
      status: 200,
      data: {
        success: true,
        data: {
          product: {
            title: "Acme T-Shirt",
            brand: "Acme",
            url: "https://example.com/tshirt",
            variants: [
              {
                id: "v1",
                sku: "TSHIRT-S-RED",
                title: "Small / Red",
                values: { size: "S", color: "Red" },
                price: { amount: 19.0, currency: "USD" },
                sale: { originalPrice: { amount: 24.0, currency: "USD" } },
                availability: { inStock: true },
                images: [{ url: "https://example.com/tshirt-red.jpg" }]
              },
              {
                id: "v2",
                sku: "TSHIRT-L-BLUE",
                title: "Large / Blue",
                values: { size: "L", color: "Blue" },
                availability: { inStock: false, text: "Sold out" }
              }
            ]
          }
        }
      }
    };

    const http = makeHttp(() => mockResponse);
    const result = await scrape(http, "https://example.com", { formats: ["product"] });

    expect(result.product).toBeDefined();
    expect(result.product?.variants).toHaveLength(2);
    expect(result.product?.variants?.[0]?.sku).toBe("TSHIRT-S-RED");
    expect(result.product?.variants?.[0]?.values?.color).toBe("Red");
    expect(result.product?.variants?.[0]?.images?.[0]?.url).toBe("https://example.com/tshirt-red.jpg");
    expect(result.product?.variants?.[0]?.sale?.originalPrice?.amount).toBe(24.0);
    expect(result.product?.variants?.[1]?.availability?.inStock).toBe(false);
    expect(result.product?.variants?.[1]?.availability?.text).toBe("Sold out");
  });
});
