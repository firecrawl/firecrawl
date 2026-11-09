import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";

import { getBrandingScript } from "../../../scraper/scrapeURL/engines/fire-engine/brandingScript";

// jsdom has no layout: elements get a box from data-top / data-w / data-h.
function logoCandidates(body: string) {
  const dom = new JSDOM(
    `<html><head><title>Acme</title></head><body>${body}</body></html>`,
    { runScripts: "outside-only", url: "https://acme.test/" },
  );
  const window = dom.window as any;
  window.Element.prototype.getBoundingClientRect = function () {
    const top = Number(this.getAttribute?.("data-top") ?? NaN);
    if (Number.isNaN(top)) {
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        width: 0,
        height: 0,
        right: 0,
        bottom: 0,
      };
    }
    const width = Number(this.getAttribute("data-w") ?? 120);
    const height = Number(this.getAttribute("data-h") ?? 32);
    return {
      x: 0,
      y: top,
      top,
      left: 0,
      width,
      height,
      right: width,
      bottom: top + height,
    };
  };
  const result = window.eval(getBrandingScript());
  return result.branding.logoCandidates as Array<{
    alt: string;
    colors?: Array<{ color: string; share: number }>;
  }>;
}

describe("branding script logo colors", () => {
  it("reads an inline SVG logo's colors, including ones it inherits", () => {
    const candidates = logoCandidates(
      `<header data-top="0" data-w="1200" data-h="64">
         <a href="/" data-top="16" aria-label="Acme home">
           <svg data-top="16" data-w="120" data-h="32" viewBox="0 0 120 32" style="color: rgb(255, 56, 92); fill: currentColor" aria-label="Acme logo">
             <path d="M0 0h80v32H0z"></path>
             <path d="M90 0h30v32H90z" style="fill: rgb(34, 34, 34)"></path>
           </svg>
         </a>
       </header>`,
    );

    const logo = candidates.find(c => c.colors);
    expect(logo?.colors?.map(c => c.color)).toEqual(
      expect.arrayContaining(["#FF385C", "#222222"]),
    );
  });

  it("counts only painted shapes: not definitions, clip paths or invisible strokes", () => {
    const candidates = logoCandidates(
      `<header data-top="0" data-w="1200" data-h="64">
         <a href="/" data-top="16" aria-label="Acme home">
           <svg data-top="16" data-w="120" data-h="32" viewBox="0 0 120 32" aria-label="Acme logo">
             <defs><path id="unused" d="M0 0h10v10H0z" style="fill: rgb(255, 0, 0)"></path></defs>
             <clipPath id="clip"><rect width="120" height="32" style="fill: rgb(0, 255, 0)"></rect></clipPath>
             <path d="M0 0h120v32H0z" style="fill: rgb(14, 126, 78); stroke: rgb(0, 0, 255); stroke-width: 2; stroke-opacity: 0"></path>
           </svg>
         </a>
       </header>`,
    );

    const logo = candidates.find(c => c.colors);
    expect(logo?.colors).toEqual([{ color: "#0E7E4E", share: 1 }]);
  });

  it("leaves colors out when they can't be read", () => {
    // jsdom can't paint images, like a cross-origin logo in a browser.
    const candidates = logoCandidates(
      `<header data-top="0" data-w="1200" data-h="64">
         <a href="/" data-top="16"><img src="https://cdn.other.test/logo.png" alt="Acme logo" data-top="16"></a>
       </header>`,
    );

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every(c => c.colors === undefined)).toBe(true);
  });
});
