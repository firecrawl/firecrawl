import { config } from "../../config";
import { parseMarkdown } from "../html-to-markdown";
import { MarkdownConversionError } from "../error";
import { convertHTMLToMarkdownWithHttpService } from "../html-to-markdown-client";

jest.mock("../html-to-markdown-client", () => ({
  convertHTMLToMarkdownWithHttpService: jest.fn(),
}));

jest.mock("@mendable/firecrawl-rs", () => ({
  postProcessMarkdown: jest.fn((value: string) => value),
}));

describe("parseMarkdown", () => {
  const originalServiceUrl = config.HTML_TO_MARKDOWN_SERVICE_URL;
  const originalUseGo = config.USE_GO_MARKDOWN_PARSER;

  afterEach(() => {
    config.HTML_TO_MARKDOWN_SERVICE_URL = originalServiceUrl;
    config.USE_GO_MARKDOWN_PARSER = originalUseGo;
    jest.clearAllMocks();
  });

  it("uses the service when configured", async () => {
    config.HTML_TO_MARKDOWN_SERVICE_URL = "https://markdown.test";
    config.USE_GO_MARKDOWN_PARSER = false;
    (convertHTMLToMarkdownWithHttpService as jest.Mock).mockResolvedValue(
      "Hello, world!",
    );

    await expect(parseMarkdown("<p>Hello, world!</p>")).resolves.toBe(
      "Hello, world!",
    );
    expect(convertHTMLToMarkdownWithHttpService).toHaveBeenCalledWith(
      "<p>Hello, world!</p>",
      expect.any(Object),
    );
  });

  it("returns empty string when input is empty", async () => {
    config.HTML_TO_MARKDOWN_SERVICE_URL = "https://markdown.test";
    (convertHTMLToMarkdownWithHttpService as jest.Mock).mockResolvedValue(
      "should-not-be-used",
    );

    await expect(parseMarkdown("")).resolves.toBe("");
    expect(convertHTMLToMarkdownWithHttpService).not.toHaveBeenCalled();
  });

  it("returns empty string when input is null", async () => {
    config.HTML_TO_MARKDOWN_SERVICE_URL = "https://markdown.test";
    (convertHTMLToMarkdownWithHttpService as jest.Mock).mockResolvedValue(
      "should-not-be-used",
    );

    await expect(parseMarkdown(null)).resolves.toBe("");
    expect(convertHTMLToMarkdownWithHttpService).not.toHaveBeenCalled();
  });

  it("throws when no parser is configured", async () => {
    config.HTML_TO_MARKDOWN_SERVICE_URL = undefined;
    config.USE_GO_MARKDOWN_PARSER = false;

    await expect(parseMarkdown("<p>Missing parser</p>")).rejects.toBeInstanceOf(
      MarkdownConversionError,
    );
  });

  it("throws MarkdownConversionError when the service fails", async () => {
    config.HTML_TO_MARKDOWN_SERVICE_URL = "https://markdown.test";
    config.USE_GO_MARKDOWN_PARSER = false;
    (convertHTMLToMarkdownWithHttpService as jest.Mock).mockRejectedValue(
      new Error("service down"),
    );

    await expect(parseMarkdown("<p>Fails</p>")).rejects.toBeInstanceOf(
      MarkdownConversionError,
    );
  });
});
