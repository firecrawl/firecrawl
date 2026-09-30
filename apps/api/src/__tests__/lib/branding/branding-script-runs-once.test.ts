import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";

import { getBrandingScript } from "../../../scraper/scrapeURL/engines/fire-engine/brandingScript";

describe("bundled branding script", () => {
  it("scans the page once and returns the result", () => {
    const dom = new JSDOM(
      `<html><head><title>Acme | Home</title><script src="/app.js"></script></head>
       <body><header><a href="/"><img alt="Acme logo" src="/logo.svg"></a></header>
       <h1>Acme</h1><p>Hello</p><button>Get started</button></body></html>`,
      { runScripts: "outside-only", url: "https://acme.test/" },
    );
    const window = dom.window as any;

    // Framework detection reads the page's script tags once per scan.
    let scans = 0;
    const querySelectorAll = window.Document.prototype.querySelectorAll;
    window.Document.prototype.querySelectorAll = function (selector: string) {
      if (selector === "script[src]") scans++;
      return querySelectorAll.call(this, selector);
    };

    const result = window.eval(getBrandingScript());

    expect(scans).toBe(1);
    // A real extraction, not just an object: the brand comes from the title,
    // and the scan recorded no errors.
    expect(result?.branding?.brandName).toBe("Acme");
    expect(result?.branding?.errors).toBeUndefined();
  });
});
