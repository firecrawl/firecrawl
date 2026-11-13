import { removeBase64Images } from "./removeBase64Images";

const baseMeta = () =>
  ({
    url: "https://example.com",
    options: { removeBase64Images: true },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  }) as any;

const baseDocument = (markdown: string) =>
  ({ markdown }) as any;

describe("removeBase64Images", () => {
  it("replaces a single base64 image", () => {
    const doc = baseDocument("![alt](data:image/png;base64,AAAA)");
    const result = removeBase64Images(baseMeta(), doc);
    expect(result.markdown).toBe("![alt](<Base64-Image-Removed>)");
  });

  it("does not touch non-base64 data URIs", () => {
    const md = "![no](data:image/svg+xml,%3Csvg%2F%3E) No";
    const doc = baseDocument(md);
    const result = removeBase64Images(baseMeta(), doc);
    expect(result.markdown).toBe(md);
  });

  it("preserves text between a non-base64 and a base64 image on the same line", () => {
    const md =
      "![no](data:image/svg+xml,%3Csvg%2F%3E) No ![yes](data:image/png;base64,AAAA) Yes";
    const doc = baseDocument(md);
    const result = removeBase64Images(baseMeta(), doc);
    expect(result.markdown).toBe(
      "![no](data:image/svg+xml,%3Csvg%2F%3E) No ![yes](<Base64-Image-Removed>) Yes",
    );
  });

  it("preserves table cells when a non-base64 icon precedes a base64 image", () => {
    const md = "| SSO | ![no](data:image/svg+xml,%3Csvg%2F%3E) No | ![yes](data:image/png;base64,AAAA) Yes |";
    const doc = baseDocument(md);
    const result = removeBase64Images(baseMeta(), doc);
    expect(result.markdown).toBe(
      "| SSO | ![no](data:image/svg+xml,%3Csvg%2F%3E) No | ![yes](<Base64-Image-Removed>) Yes |",
    );
  });

  it("does nothing when removeBase64Images is disabled", () => {
    const meta = baseMeta();
    meta.options.removeBase64Images = false;
    const md = "![img](data:image/png;base64,AAAA)";
    const doc = baseDocument(md);
    const result = removeBase64Images(meta, doc);
    expect(result.markdown).toBe(md);
  });
});
