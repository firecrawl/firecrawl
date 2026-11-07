import { describe, expect, it } from "vitest";
import type { FeatureFlag } from "../engines";
import { applyHandoffFeatureFlags } from "./handoffFeatureFlags";

describe("applyHandoffFeatureFlags", () => {
  it("replaces the URL-derived file flag with the parser the handoff names", () => {
    // A .pdf URL that served a docx.
    expect(applyHandoffFeatureFlags(new Set(["pdf"]), ["document"])).toEqual(
      new Set(["document"]),
    );
    // A .docx URL that served a PDF.
    expect(applyHandoffFeatureFlags(new Set(["document"]), ["pdf"])).toEqual(
      new Set(["pdf"]),
    );
    // A .pdf URL that served a PNG.
    expect(applyHandoffFeatureFlags(new Set(["pdf"]), ["image"])).toEqual(
      new Set(["image"]),
    );
  });

  it("keeps every non-file flag", () => {
    expect(
      applyHandoffFeatureFlags(new Set(["pdf", "location", "waitFor"]), [
        "document",
      ]),
    ).toEqual(new Set(["document", "location", "waitFor"]));
  });

  it("is a plain union when the handoff names no parser", () => {
    expect(
      applyHandoffFeatureFlags(new Set(["pdf", "location"]), ["stealthProxy"]),
    ).toEqual(new Set(["pdf", "location", "stealthProxy"]));
  });

  it("leaves a matching file flag in place", () => {
    expect(
      applyHandoffFeatureFlags(new Set(["pdf", "mobile"]), ["pdf"]),
    ).toEqual(new Set(["pdf", "mobile"]));
  });

  it("does not mutate the request's set", () => {
    const current = new Set<FeatureFlag>(["pdf"]);
    applyHandoffFeatureFlags(current, ["document"]);
    expect(current).toEqual(new Set(["pdf"]));
  });
});
