// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { getStyleSnapshot } from "../../../scraper/scrapeURL/engines/fire-engine/branding-script/elements";

// "𝐁" (U+1D401) is a surrogate pair: two UTF-16 code units.
const bold = "\u{1D401}";
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("branding script element text", () => {
  it("does not cut a surrogate pair when truncating button text", () => {
    document.body.innerHTML = `<button>${"a".repeat(99)}${bold}${bold}</button>`;

    const { text } = getStyleSnapshot(document.querySelector("button")!);

    expect(text).toBe("a".repeat(99));
    expect(text).not.toMatch(LONE_SURROGATE);
  });

  it("keeps a pair that fits and still truncates at 100 code units", () => {
    document.body.innerHTML = `<input type="submit" value="${"a".repeat(98)}${bold}zzz">`;

    const { text } = getStyleSnapshot(document.querySelector("input")!);

    expect(text).toBe("a".repeat(98) + bold);
  });

  it("does not cut a surrogate pair in input labels", () => {
    document.body.innerHTML = `<label>${"a".repeat(99)}${bold}<input></label>`;

    const { inputMetadata } = getStyleSnapshot(
      document.querySelector("input")!,
    );

    expect(inputMetadata?.label).toBe("a".repeat(99));
  });
});
