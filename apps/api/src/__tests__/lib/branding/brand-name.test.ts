import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";

import { getBrandingScript } from "../../../scraper/scrapeURL/engines/fire-engine/brandingScript";
import { brandFromTitle } from "../../../scraper/scrapeURL/engines/fire-engine/branding-script/brand-utils";

describe("brandFromTitle", () => {
  it("takes the leading brand of 'Brand | Tagline'", () => {
    expect(
      brandFromTitle("Stripe | Financial Infrastructure", "stripe.com"),
    ).toBe("Stripe");
  });

  it("takes the trailing brand of 'Tagline - Brand'", () => {
    expect(
      brandFromTitle(
        "Frische Einrichtungsideen & erschwingliche Möbel - IKEA Deutschland",
        "www.ikea.com",
      ),
    ).toBe("IKEA Deutschland");
    expect(brandFromTitle("Home | The Home Depot", "www.homedepot.com")).toBe(
      "The Home Depot",
    );
  });

  it("keeps hyphenated brand names whole", () => {
    expect(
      brandFromTitle("Coca-Cola | Refresh the World", "www.coca-cola.com"),
    ).toBe("Coca-Cola");
  });

  it("falls back to the first part when none names the domain", () => {
    expect(
      brandFromTitle("楽天市場 - 日本最大級の通販サイト", "www.rakuten.co.jp"),
    ).toBe("楽天市場");
    expect(brandFromTitle("Welcome: the place to be", "acme.com")).toBe(
      "Welcome",
    );
  });

  it("prefers the registrable domain over a subdomain", () => {
    expect(brandFromTitle("Support - Example", "support.example.com")).toBe(
      "Example",
    );
    expect(brandFromTitle("Example - Support", "support.example.com")).toBe(
      "Example",
    );
  });

  it("matches whole words, not a domain hidden inside a word", () => {
    expect(brandFromTitle("Best Buy - Ace", "www.ace.com")).toBe("Ace");
    expect(brandFromTitle("Space travel - Ace", "www.ace.com")).toBe("Ace");
  });

  it("matches short brands and skips country second-level suffixes", () => {
    expect(brandFromTitle("Laptops and printers | HP", "www.hp.com")).toBe(
      "HP",
    );
    expect(
      brandFromTitle("Groceries delivered - Ocado", "www.ocado.co.uk"),
    ).toBe("Ocado");
  });

  it("returns an empty string for an empty title", () => {
    expect(brandFromTitle("", "acme.com")).toBe("");
    expect(brandFromTitle(undefined, "acme.com")).toBe("");
  });
});

describe("bundled branding script brand name", () => {
  it("reads the brand from the end of a 'Tagline - Brand' title", () => {
    const window = new JSDOM(
      `<html><head><title>Affordable furniture for every home - Acme</title></head>
       <body><h1>Welcome</h1></body></html>`,
      { runScripts: "outside-only", url: "https://www.acme.test/" },
    ).window as any;

    const result = window.eval(getBrandingScript());

    expect(result?.branding?.brandName).toBe("Acme");
  });
});
