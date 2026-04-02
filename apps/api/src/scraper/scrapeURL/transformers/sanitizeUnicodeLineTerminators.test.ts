import { sanitizeUnicodeLineTerminators } from "./sanitizeUnicodeLineTerminators";
import { Document } from "../../../controllers/v2/types";
import { Meta } from "..";

const dummyMeta = {} as Meta;

function makeDoc(overrides: Partial<Document> = {}): Document {
  return { metadata: { sourceURL: "https://example.com" }, ...overrides } as Document;
}

describe("sanitizeUnicodeLineTerminators", () => {
  it("replaces U+2028 with newline and U+2029 with double newline in markdown", () => {
    const doc = makeDoc({
      markdown: "Hello\u2028World\u2029End",
    });
    const result = sanitizeUnicodeLineTerminators(dummyMeta, doc);
    expect(result.markdown).toBe("Hello\nWorld\n\nEnd");
    expect(result.markdown).not.toMatch(/[\u2028\u2029]/);
  });

  it("replaces U+2028 and U+2029 in html", () => {
    const doc = makeDoc({
      html: "<p>Hello\u2028World\u2029</p>",
    });
    const result = sanitizeUnicodeLineTerminators(dummyMeta, doc);
    expect(result.html).toBe("<p>Hello\nWorld\n\n</p>");
    expect(result.html).not.toMatch(/[\u2028\u2029]/);
  });

  it("replaces U+2028 and U+2029 in rawHtml", () => {
    const doc = makeDoc({
      rawHtml: "<div>\u2028\u2029</div>",
    });
    const result = sanitizeUnicodeLineTerminators(dummyMeta, doc);
    expect(result.rawHtml).toBe("<div>\n\n\n</div>");
    expect(result.rawHtml).not.toMatch(/[\u2028\u2029]/);
  });

  it("handles all three fields at once", () => {
    const doc = makeDoc({
      markdown: "md\u2028content",
      html: "html\u2029content",
      rawHtml: "raw\u2028\u2029html",
    });
    const result = sanitizeUnicodeLineTerminators(dummyMeta, doc);
    expect(result.markdown).toBe("md\ncontent");
    expect(result.html).toBe("html\n\ncontent");
    expect(result.rawHtml).toBe("raw\n\n\nhtml");
  });

  it("leaves content unchanged when no line terminators present", () => {
    const doc = makeDoc({
      markdown: "Normal markdown\nwith newlines\r\nand tabs\t",
    });
    const result = sanitizeUnicodeLineTerminators(dummyMeta, doc);
    expect(result.markdown).toBe("Normal markdown\nwith newlines\r\nand tabs\t");
  });

  it("handles undefined fields gracefully", () => {
    const doc = makeDoc({});
    const result = sanitizeUnicodeLineTerminators(dummyMeta, doc);
    expect(result.markdown).toBeUndefined();
    expect(result.html).toBeUndefined();
    expect(result.rawHtml).toBeUndefined();
  });

  it("produces JSON.stringify-safe output", () => {
    const doc = makeDoc({
      markdown: "Text with\u2028line sep and\u2029paragraph sep embedded",
    });
    const result = sanitizeUnicodeLineTerminators(dummyMeta, doc);
    const json = JSON.stringify(result.markdown);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(json).not.toContain("\u2028");
    expect(json).not.toContain("\u2029");
  });
});
