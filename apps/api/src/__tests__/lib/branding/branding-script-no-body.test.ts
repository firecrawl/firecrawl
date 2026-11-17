import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";

import { getBrandingScript } from "../../../scraper/scrapeURL/engines/fire-engine/brandingScript";

// The branding script can run while a page is still mid-navigation, before
// <body> (or even <html>) has been parsed. It must degrade, not throw.
describe("bundled branding script without a document body", () => {
  const load = (html: string) =>
    new JSDOM(html, { runScripts: "outside-only", url: "https://acme.test/" })
      .window as any;

  it("returns a result when document.body is null", () => {
    const window = load(
      `<html class="dark"><head><title>Acme | Home</title></head>
       <body><h1>Acme</h1><p>Hello</p><button>Go</button></body></html>`,
    );
    window.document.body.remove();
    expect(window.document.body).toBeNull();

    const result = window.eval(getBrandingScript());

    expect(result?.branding?.brandName).toBe("Acme");
    // Scheme indicators on <html> still count when <body> is missing.
    expect(result?.branding?.colorScheme).toBe("dark");
    expect(result?.branding?.errors).toBeUndefined();
  });

  it("falls back to light when no root carries a scheme indicator", () => {
    const window = load(
      `<html><head><title>Acme</title></head><body></body></html>`,
    );
    window.document.body.remove();

    const result = window.eval(getBrandingScript());

    expect(result?.branding?.colorScheme).toBe("light");
    expect(result?.branding?.errors).toBeUndefined();
  });

  it("returns a result when the document has no root element at all", () => {
    const window = load(`<html><head><title>Acme</title></head></html>`);
    window.document.documentElement.remove();
    expect(window.document.documentElement).toBeNull();
    expect(window.document.body).toBeNull();

    expect(() => window.eval(getBrandingScript())).not.toThrow();
    const result = window.eval(getBrandingScript());
    expect(result?.branding?.colorScheme).toBe("light");
  });
});
