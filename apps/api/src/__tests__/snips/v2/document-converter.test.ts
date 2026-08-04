import path from "path";
import fs from "fs";
import { convertDocumentToMarkdown } from "@mendable/firecrawl-rs";

describe("Document Converter tests", () => {
  const samplesDir = path.join(process.cwd(), "samples");

  const expectedMarkdownBase = (documentText: string) =>
    `**Hello!**\n\n${documentText} file to test the Firecrawl Document Converter.\n\n*Italic*\n\n**Bold**\n\nUnderlined\n\n~~Strikethrough~~\n\n|  |  |\n| --- | --- |\n| Header 1 | Header 2 |\n| Value 1 | Value 2 |\n`;

  const sampleFiles = [
    { file: "sample.docx", name: "DOCX" },
    { file: "sample.odt", name: "ODT" },
    { file: "sample.rtf", name: "RTF" },
  ];

  describe.each(sampleFiles)("$name document conversion", ({ file, name }) => {
    const filePath = path.join(samplesDir, file);

    beforeAll(() => {
      if (!fs.existsSync(filePath)) {
        throw new Error(`Sample file ${filePath} does not exist`);
      }
    });

    it.concurrent(
      `should convert ${name} document and return expected markdown`,
      async () => {
        const fileBuffer = fs.readFileSync(filePath);

        // No extension hint: the format must be detected from the bytes
        const markdown = convertDocumentToMarkdown(new Uint8Array(fileBuffer));

        expect(markdown).toBe(expectedMarkdownBase(name));
      },
      10000,
    );
  });

  describe("XLSX document conversion", () => {
    const expectedMarkdown = `## Sheet1\n\n|  |  |\n| --- | --- |\n| sample file | test |\n|  |  |\n| Name | Price |\n| iPhone | 1000 |\n| iPad | 800 |\n| Macbook | 1200 |\n\n## Sheet2\n\n|  |  |\n| --- | --- |\n| other tab |  |\n|  |  |\n| Name | Price |\n| ChatGPT | 20 |\n| Claude | 17 |\n| Perplexity | 20 |\n`;

    it("should convert XLSX document and return expected markdown", () => {
      const filePath = path.join(samplesDir, "sample.xlsx");
      const fileBuffer = fs.readFileSync(filePath);
      const markdown = convertDocumentToMarkdown(new Uint8Array(fileBuffer));
      expect(markdown).toBe(expectedMarkdown);
    });
  });

  describe("CSV document conversion", () => {
    it("should convert CSV to a markdown table using the extension hint", () => {
      // CSV has no magic bytes, so the extension hint selects the parser
      const csv = Buffer.from("Name,Price\niPhone,1000\niPad,800\n");
      const markdown = convertDocumentToMarkdown(new Uint8Array(csv), ".csv");
      expect(markdown).toBe(
        "|  |  |\n| --- | --- |\n| Name | Price |\n| iPhone | 1000 |\n| iPad | 800 |\n",
      );
    });
  });

  describe("unrecognized content", () => {
    it("should throw on content that is not a supported document", () => {
      expect(() =>
        convertDocumentToMarkdown(new Uint8Array([1, 2, 3, 4, 5])),
      ).toThrow();
    });
  });
});
