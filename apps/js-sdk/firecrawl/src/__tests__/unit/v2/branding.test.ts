import { describe, test, expect, jest } from "@jest/globals";
import { scrape } from "../../../v2/methods/scrape";

describe("JS SDK v2 branding format", () => {
  function makeHttp(postImpl: (url: string, data: any) => any) {
    return { post: jest.fn(async (u: string, d: any) => postImpl(u, d)) } as any;
  }

  test("scrape with branding format returns branding data", async () => {
    const mockResponse = {
      status: 200,
      data: {
        success: true,
        data: {
          markdown: "# Example",
          branding: {
            colorScheme: "light",
            colors: {
              primary: "#E11D48",
              secondary: "#3B82F6",
              accent: "#F59E0B"
            },
            typography: {
              fontFamilies: {
                primary: "Inter",
                heading: "Poppins"
              },
              fontSizes: {
                h1: "2.5rem",
                body: "1rem"
              }
            },
            spacing: {
              baseUnit: 8
            },
            components: {
              buttonPrimary: {
                background: "#E11D48",
                textColor: "#FFFFFF",
                borderRadius: "0.5rem"
              }
            }
          }
        }
      }
    };

    const http = makeHttp(() => mockResponse);
    const result = await scrape(http, "https://example.com", { formats: ["branding"] });

    expect(result.branding).toBeDefined();
    expect(result.branding?.colorScheme).toBe("light");
    expect(result.branding?.colors?.primary).toBe("#E11D48");
    expect(result.branding?.typography?.fontFamilies?.primary).toBe("Inter");
    expect(result.branding?.spacing?.baseUnit).toBe(8);
    expect(result.branding?.components?.buttonPrimary?.background).toBe("#E11D48");
  });

  test("scrape with branding and markdown formats returns both", async () => {
    const mockResponse = {
      status: 200,
      data: {
        success: true,
        data: {
          markdown: "# Example Content",
          branding: {
            colorScheme: "dark",
            colors: {
              primary: "#10B981"
            },
            typography: {
              fontFamilies: {
                primary: "Roboto"
              }
            }
          }
        }
      }
    };

    const http = makeHttp(() => mockResponse);
    const result = await scrape(http, "https://example.com", { formats: ["markdown", "branding"] });

    expect(result.markdown).toBe("# Example Content");
    expect(result.branding).toBeDefined();
    expect(result.branding?.colorScheme).toBe("dark");
    expect(result.branding?.colors?.primary).toBe("#10B981");
  });

  test("scrape without branding format does not return branding", async () => {
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
    expect(result.branding).toBeUndefined();
  });

  test("branding format with all nested fields", async () => {
    const mockResponse = {
      status: 200,
      data: {
        success: true,
        data: {
          branding: {
            colorScheme: "light",
            logo: "https://example.com/logo.png",
            fonts: [
              { family: "Inter", weight: 400 },
              { family: "Poppins", weight: 700 }
            ],
            colors: {
              primary: "#E11D48",
              background: "#FFFFFF"
            },
            typography: {
              fontFamilies: { primary: "Inter" },
              fontStacks: { body: ["Inter", "sans-serif"] },
              fontSizes: { h1: "2.5rem" },
              lineHeights: { body: 1.5 },
              fontWeights: { regular: 400 }
            },
            spacing: {
              baseUnit: 8,
              padding: { sm: 8, md: 16 }
            },
            components: {
              buttonPrimary: {
                background: "#E11D48",
                textColor: "#FFFFFF"
              }
            },
            icons: {
              style: "outline",
              primaryColor: "#E11D48"
            },
            images: {
              logo: "https://example.com/logo.png",
              favicon: "https://example.com/favicon.ico"
            },
            animations: {
              transitionDuration: "200ms",
              easing: "ease-in-out"
            },
            layout: {
              grid: { columns: 12, maxWidth: "1200px" },
              headerHeight: "64px"
            },
            tone: {
              voice: "professional",
              emojiUsage: "minimal"
            },
            personality: {
              tone: "professional",
              energy: "medium",
              targetAudience: "developers"
            }
          }
        }
      }
    };

    const http = makeHttp(() => mockResponse);
    const result = await scrape(http, "https://example.com", { formats: ["branding"] });

    expect(result.branding).toBeDefined();
    expect(result.branding?.logo).toBe("https://example.com/logo.png");
    expect(result.branding?.fonts).toHaveLength(2);
    expect(result.branding?.typography?.fontStacks?.body).toEqual(["Inter", "sans-serif"]);
    expect(result.branding?.spacing?.padding).toEqual({ sm: 8, md: 16 });
    expect(result.branding?.icons?.style).toBe("outline");
    expect(result.branding?.images?.favicon).toBe("https://example.com/favicon.ico");
    expect(result.branding?.animations?.easing).toBe("ease-in-out");
    expect(result.branding?.layout?.grid?.columns).toBe(12);
    expect(result.branding?.personality?.tone).toBe("professional");
  });
});
