import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";

import { getBrandingScript } from "../../../scraper/scrapeURL/engines/fire-engine/brandingScript";
import { brandFromTitle } from "../../../scraper/scrapeURL/engines/fire-engine/branding-script/brand-utils";

describe("brandFromTitle", () => {
  it("takes the leading brand of 'Brand | Tagline'", () => {
    expect(brandFromTitle("Stripe | Financial Infrastructure", "Stripe")).toBe(
      "Stripe",
    );
  });

  it("takes the trailing brand of 'Tagline - Brand'", () => {
    expect(
      brandFromTitle(
        "Frische Einrichtungsideen & erschwingliche Möbel - IKEA Deutschland",
        "Ikea",
      ),
    ).toBe("IKEA Deutschland");
    expect(brandFromTitle("Home | The Home Depot", "Homedepot")).toBe(
      "The Home Depot",
    );
  });

  it("keeps hyphenated brand names whole", () => {
    expect(brandFromTitle("Coca-Cola | Refresh the World", "Coca-cola")).toBe(
      "Coca-Cola",
    );
  });

  it("falls back to the first part when none names the domain", () => {
    expect(brandFromTitle("楽天市場 - 日本最大級の通販サイト", "Rakuten")).toBe(
      "楽天市場",
    );
    expect(brandFromTitle("Welcome: the place to be", "Acme")).toBe("Welcome");
  });

  it("returns an empty string for an empty title", () => {
    expect(brandFromTitle("", "Acme")).toBe("");
    expect(brandFromTitle(undefined, "Acme")).toBe("");
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
