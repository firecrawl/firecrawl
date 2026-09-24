import { describe, expect, it } from "vitest";
import type { Meta } from "../../..";
import { buildFirePdfRequestMetadata } from "./request-metadata";

function metaWith(internalOptions: Record<string, unknown>): Meta {
  return {
    url: "https://example.com/doc.pdf",
    rewrittenUrl: undefined,
    options: {},
    internalOptions,
  } as unknown as Meta;
}

describe("buildFirePdfRequestMetadata", () => {
  it("declares a PDF source unless told otherwise", () => {
    expect(buildFirePdfRequestMetadata(metaWith({}))).toEqual({
      source_endpoint: "scrape",
      source_request_context: "default",
      source_kind: "pdf",
      url: "https://example.com/doc.pdf",
    });
  });

  it("carries the image kind on scrape and parse requests", () => {
    expect(buildFirePdfRequestMetadata(metaWith({}), "image")).toMatchObject({
      source_endpoint: "scrape",
      source_kind: "image",
      url: "https://example.com/doc.pdf",
    });
    expect(
      buildFirePdfRequestMetadata(
        metaWith({ uploadedFile: { kind: "image" } }),
        "image",
      ),
    ).toEqual({
      source_endpoint: "parse",
      source_request_context: "default",
      source_kind: "image",
    });
  });

  it("keeps the kind while dropping the URL for zero-data-retention scrapes", () => {
    expect(
      buildFirePdfRequestMetadata(
        metaWith({ zeroDataRetention: true }),
        "image",
      ),
    ).toEqual({
      source_endpoint: "scrape",
      source_request_context: "default",
      source_kind: "image",
    });
  });
});
