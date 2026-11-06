import { removeBase64Images } from "./removeBase64Images";
import type { Meta } from "..";
import type { Document } from "../../../controllers/v1/types";

function makeMeta(): Meta {
  return {
    url: "http://example.com",
    options: { removeBase64Images: true },
    internalOptions: {},
    logger: {
      child: () => ({}),
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  } as unknown as Meta;
}

function transform(markdown: string): string {
  const document: Document = { markdown };
  const result = removeBase64Images(makeMeta(), document);
  return result.markdown as string;
}

describe("removeBase64Images", () => {
  it("replaces the URL of a base64 image only", () => {
    const input = "![logo](data:image/png;base64,iVBORw0KGgo=)";
    expect(transform(input)).toBe("![logo](<Base64-Image-Removed>)");
  });

  it("keeps a non-base64 data:image before a base64 image on the same line", () => {
    const input =
      "![icon](data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E) Price: $42, in stock. ![logo](data:image/png;base64,iVBORw0KGgo=)";
    expect(transform(input)).toBe(
      "![icon](data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E) Price: $42, in stock. ![logo](<Base64-Image-Removed>)",
    );
  });

  it("keeps table cells intact when a non-base64 data:image precedes a base64 image", () => {
    const input =
      "| SSO | ![no](data:image/svg+xml,%3Csvg%2F%3E) No | ![yes](data:image/png;base64,iVBORw0KGgo=) Yes |";
    expect(transform(input)).toBe(
      "| SSO | ![no](data:image/svg+xml,%3Csvg%2F%3E) No | ![yes](<Base64-Image-Removed>) Yes |",
    );
  });

  it("replaces adjacent base64 images", () => {
    const input =
      "![a](data:image/png;base64,AAA) ![b](data:image/jpeg;base64,BBB)";
    expect(transform(input)).toBe(
      "![a](<Base64-Image-Removed>) ![b](<Base64-Image-Removed>)",
    );
  });

  it("is not affected by an https image before a base64 one", () => {
    const input =
      "![ext](https://example.com/img.png) ![logo](data:image/png;base64,iVBORw0KGgo=)";
    expect(transform(input)).toBe(
      "![ext](https://example.com/img.png) ![logo](<Base64-Image-Removed>)",
    );
  });
});
