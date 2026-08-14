import { describe, it, expect } from "vitest";
import {
  declaredLogoCandidate,
  pickDeclaredLogo,
} from "../../../lib/branding/declared-logo";

describe("pickDeclaredLogo", () => {
  it("prefers JSON-LD declared logo over apple-touch icon", () => {
    expect(
      pickDeclaredLogo([
        { type: "favicon", src: "https://x.com/favicon.ico" },
        { type: "apple-touch-icon", src: "https://x.com/touch.png" },
        { type: "logo-jsonld", src: "https://x.com/logo.png" },
      ]),
    ).toEqual({ src: "https://x.com/logo.png", source: "logo-jsonld" });
  });

  it("falls back to apple-touch icon", () => {
    expect(
      pickDeclaredLogo([
        { type: "favicon", src: "https://x.com/favicon.ico" },
        { type: "apple-touch-icon", src: "https://x.com/touch.png" },
      ]),
    ).toEqual({ src: "https://x.com/touch.png", source: "apple-touch-icon" });
  });

  it("returns null when nothing is declared", () => {
    expect(
      pickDeclaredLogo([
        { type: "favicon", src: "https://x.com/favicon.ico" },
        { type: "og", src: "https://x.com/og.png" },
      ]),
    ).toBeNull();
    expect(pickDeclaredLogo(undefined)).toBeNull();
    expect(pickDeclaredLogo([])).toBeNull();
  });

  it("builds a selectable candidate from a declared mark", () => {
    expect(
      declaredLogoCandidate("https://x.com/logo.svg", "logo-jsonld", "Example"),
    ).toMatchObject({
      src: "https://x.com/logo.svg",
      alt: "Example",
      isSvg: true,
      isVisible: true,
      source: "logo-jsonld",
      indicators: { inHeader: true, srcMatch: true, hrefMatch: true },
    });
  });
});
