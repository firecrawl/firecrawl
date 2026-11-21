import { removeBase64Images } from "../removeBase64Images";

describe("removeBase64Images transformer", () => {
  const metaEnabled: any = {
    options: {
      removeBase64Images: true,
    },
  };

  const metaDisabled: any = {
    options: {
      removeBase64Images: false,
    },
  };

  it("replaces a single base64 image URL with placeholder", () => {
    const doc: any = {
      markdown: "![logo](data:image/png;base64,iVBORw0KGgo=)",
    };
    const result = removeBase64Images(metaEnabled, doc);
    expect(result.markdown).toBe("![logo](<Base64-Image-Removed>)");
  });

  it("does not delete table cells when non-base64 data:image precedes a base64 image (issue #5022)", () => {
    const input =
      "| SSO | ![no](data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E) No | ![yes](data:image/png;base64,iVBORw0KGgo=) Yes |";
    const doc: any = { markdown: input };
    const result = removeBase64Images(metaEnabled, doc);
    expect(result.markdown).toBe(
      "| SSO | ![no](data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E) No | ![yes](<Base64-Image-Removed>) Yes |",
    );
  });

  it("preserves text between non-base64 SVG data URI and a base64 image on the same line", () => {
    const input =
      "![icon](data:image/svg+xml,...) Price: $42, in stock. ![logo](data:image/png;base64,iVBORw0KGgo=)";
    const doc: any = { markdown: input };
    const result = removeBase64Images(metaEnabled, doc);
    expect(result.markdown).toBe(
      "![icon](data:image/svg+xml,...) Price: $42, in stock. ![logo](<Base64-Image-Removed>)",
    );
  });

  it("replaces multiple base64 images independently on the same line and preserves text", () => {
    const input =
      "![one](data:image/png;base64,AAA=) and ![two](data:image/png;base64,BBB=)";
    const doc: any = { markdown: input };
    const result = removeBase64Images(metaEnabled, doc);
    expect(result.markdown).toBe(
      "![one](<Base64-Image-Removed>) and ![two](<Base64-Image-Removed>)",
    );
  });

  it("replaces base64 image with parameters such as charset", () => {
    const input = "![svg](data:image/svg+xml;charset=utf-8;base64,PHN2Zy...)";
    const doc: any = { markdown: input };
    const result = removeBase64Images(metaEnabled, doc);
    expect(result.markdown).toBe("![svg](<Base64-Image-Removed>)");
  });

  it("leaves external https images and normal markdown links unchanged", () => {
    const input =
      "![external](https://example.com/pic.png) and [link](https://example.com)";
    const doc: any = { markdown: input };
    const result = removeBase64Images(metaEnabled, doc);
    expect(result.markdown).toBe(input);
  });

  it("does not modify markdown when removeBase64Images option is false", () => {
    const input = "![logo](data:image/png;base64,iVBORw0KGgo=)";
    const doc: any = { markdown: input };
    const result = removeBase64Images(metaDisabled, doc);
    expect(result.markdown).toBe(input);
  });

  it("handles document without markdown property gracefully", () => {
    const doc: any = { html: "<p>hello</p>" };
    const result = removeBase64Images(metaEnabled, doc);
    expect(result.markdown).toBeUndefined();
    expect(result.html).toBe("<p>hello</p>");
  });

  it("handles multiline markdown with mixed images and text correctly", () => {
    const input = [
      "# Header",
      "![icon](data:image/svg+xml,%3Csvg%3E) inline icon",
      "",
      "A paragraph with ![b1](data:image/jpeg;base64,123) and some text.",
      "",
      "| Col 1 | Col 2 |",
      "| --- | --- |",
      "| ![svg](data:image/svg+xml,foo) val1 | ![b2](data:image/webp;base64,456) val2 |",
    ].join("\n");
    const doc: any = { markdown: input };
    const result = removeBase64Images(metaEnabled, doc);
    expect(result.markdown).toBe(
      [
        "# Header",
        "![icon](data:image/svg+xml,%3Csvg%3E) inline icon",
        "",
        "A paragraph with ![b1](<Base64-Image-Removed>) and some text.",
        "",
        "| Col 1 | Col 2 |",
        "| --- | --- |",
        "| ![svg](data:image/svg+xml,foo) val1 | ![b2](<Base64-Image-Removed>) val2 |",
      ].join("\n"),
    );
  });
});
