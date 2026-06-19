import { describe, test, expect, jest } from "@jest/globals";
import { scrape } from "../../../v2/methods/scrape";

describe("JS SDK v2 menu format", () => {
  function makeHttp(postImpl: (url: string, data: any) => any) {
    return { post: jest.fn(async (u: string, d: any) => postImpl(u, d)) } as any;
  }

  test("scrape with menu format returns menu data", async () => {
    const mockResponse = {
      status: 200,
      data: {
        success: true,
        data: {
          markdown: "# Example Menu",
          menu: {
            isMenu: true,
            confidence: 0.95,
            currency: "USD",
            sourceUrl: "https://example.com/menu",
            merchant: { name: "Acme Diner", type: "restaurant" },
            sections: [
              {
                id: "mains",
                name: "Mains",
                description: "Hearty plates",
                items: [
                  {
                    id: "burger",
                    name: "Classic Burger",
                    description: "Beef patty with cheese",
                    images: [{ url: "https://example.com/burger.jpg", alt: "Burger" }],
                    price: { amount: 12.5, currency: "USD", formatted: "$12.50" },
                    availability: { inStock: true, text: "Available" },
                    dietary: ["contains-gluten"],
                    calories: 800,
                    optionGroups: [],
                    identifiers: { merchantItemId: "ITEM-1" },
                    url: "https://example.com/menu#burger",
                    sourceUrl: "https://example.com/menu"
                  }
                ]
              }
            ]
          }
        }
      }
    };

    const http = makeHttp(() => mockResponse);
    const result = await scrape(http, "https://example.com", { formats: ["menu"] });

    expect(result.menu).toBeDefined();
    expect(result.menu?.isMenu).toBe(true);
    expect(result.menu?.confidence).toBe(0.95);
    expect(result.menu?.currency).toBe("USD");
    expect(result.menu?.merchant?.name).toBe("Acme Diner");
    expect(result.menu?.merchant?.type).toBe("restaurant");
    expect(result.menu?.sections?.[0]?.name).toBe("Mains");
    expect(result.menu?.sections?.[0]?.items?.[0]?.name).toBe("Classic Burger");
    expect(result.menu?.sections?.[0]?.items?.[0]?.price?.amount).toBe(12.5);
    expect(result.menu?.sections?.[0]?.items?.[0]?.price?.currency).toBe("USD");
    expect(result.menu?.sections?.[0]?.items?.[0]?.availability?.inStock).toBe(true);
    expect(result.menu?.sections?.[0]?.items?.[0]?.images?.[0]?.url).toBe("https://example.com/burger.jpg");
    expect(result.menu?.sections?.[0]?.items?.[0]?.dietary?.[0]).toBe("contains-gluten");
    expect(result.menu?.sections?.[0]?.items?.[0]?.identifiers?.merchantItemId).toBe("ITEM-1");
  });

  test("scrape with menu and markdown formats returns both", async () => {
    const mockResponse = {
      status: 200,
      data: {
        success: true,
        data: {
          markdown: "# Example Content",
          menu: {
            isMenu: true,
            confidence: 0.8,
            sourceUrl: "https://example.com/cafe",
            merchant: { name: "Cafe Acme" },
            sections: [
              {
                id: "drinks",
                name: "Drinks",
                items: [
                  {
                    id: "coffee",
                    name: "Coffee",
                    images: [],
                    price: { amount: 3.5, currency: "USD" },
                    availability: { inStock: true },
                    dietary: [],
                    optionGroups: [],
                    identifiers: {},
                    sourceUrl: "https://example.com/cafe"
                  }
                ]
              }
            ]
          }
        }
      }
    };

    const http = makeHttp(() => mockResponse);
    const result = await scrape(http, "https://example.com", { formats: ["markdown", "menu"] });

    expect(result.markdown).toBe("# Example Content");
    expect(result.menu).toBeDefined();
    expect(result.menu?.merchant?.name).toBe("Cafe Acme");
    expect(result.menu?.sections?.[0]?.items?.[0]?.price?.amount).toBe(3.5);
  });

  test("scrape without menu format does not return menu", async () => {
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
    expect(result.menu).toBeUndefined();
  });

  test("non-menu page scraped with menu format yields a warning and no menu", async () => {
    const mockResponse = {
      status: 200,
      data: {
        success: true,
        data: {
          markdown: "# Blog Post",
          warning: "No menu found on this page."
        }
      }
    };

    const http = makeHttp(() => mockResponse);
    const result = await scrape(http, "https://example.com", { formats: ["menu"] });

    expect(result.menu).toBeUndefined();
    expect(result.warning).toContain("No menu found");
  });

  test("menu format with multiple sections and items", async () => {
    const mockResponse = {
      status: 200,
      data: {
        success: true,
        data: {
          menu: {
            isMenu: true,
            confidence: 0.9,
            sourceUrl: "https://example.com/menu",
            merchant: { name: "Acme Bistro", type: "restaurant", location: { city: "Springfield" } },
            sections: [
              {
                id: "starters",
                name: "Starters",
                items: [
                  {
                    id: "soup",
                    name: "Tomato Soup",
                    images: [],
                    price: { amount: 6.0, currency: "USD" },
                    availability: { inStock: true },
                    dietary: ["vegetarian"],
                    optionGroups: [],
                    identifiers: {},
                    sourceUrl: "https://example.com/menu"
                  }
                ]
              },
              {
                id: "desserts",
                name: "Desserts",
                items: [
                  {
                    id: "cake",
                    name: "Chocolate Cake",
                    images: [{ url: "https://example.com/cake.jpg" }],
                    availability: { inStock: false, text: "Sold out" },
                    dietary: [],
                    optionGroups: [],
                    identifiers: {},
                    sourceUrl: "https://example.com/menu"
                  }
                ]
              }
            ]
          }
        }
      }
    };

    const http = makeHttp(() => mockResponse);
    const result = await scrape(http, "https://example.com", { formats: ["menu"] });

    expect(result.menu).toBeDefined();
    expect(result.menu?.sections).toHaveLength(2);
    expect(result.menu?.sections?.[0]?.items?.[0]?.dietary?.[0]).toBe("vegetarian");
    expect(result.menu?.sections?.[1]?.name).toBe("Desserts");
    expect(result.menu?.sections?.[1]?.items?.[0]?.images?.[0]?.url).toBe("https://example.com/cake.jpg");
    expect(result.menu?.sections?.[1]?.items?.[0]?.availability?.inStock).toBe(false);
    expect(result.menu?.sections?.[1]?.items?.[0]?.availability?.text).toBe("Sold out");
  });
});
