import type { MockedFunction } from "vitest";
import { executeTransformers } from ".";
import { performLLMExtract } from "./llmExtract";

vi.mock("../../../services/index", () => ({
  useIndex: false,
  useSearchIndex: false,
}));

vi.mock("./llmExtract", async importOriginal => {
  const actual = await importOriginal<typeof import("./llmExtract")>();

  return {
    ...actual,
    performLLMExtract: vi.fn(actual.performLLMExtract),
  };
});

const mockedPerformLLMExtract = performLLMExtract as MockedFunction<
  typeof performLLMExtract
>;

function logger() {
  const log = {
    child: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  log.child.mockReturnValue(log);
  return log;
}

describe("executeTransformers", () => {
  beforeEach(() => {
    mockedPerformLLMExtract.mockClear();
  });

  it("runs JSON extraction on markdown an engine delivered natively", async () => {
    mockedPerformLLMExtract.mockImplementationOnce(async (_meta, document) => ({
      ...document,
      json: { name: "Example Person" },
    }));

    const document = await executeTransformers(
      {
        url: "https://www.linkedin.com/in/example",
        options: {
          formats: [
            { type: "markdown" },
            { type: "json", schema: { type: "object" } },
          ],
          onlyMainContent: false,
        },
        internalOptions: {},
        logger: logger(),
      } as any,
      {
        rawHtml:
          "<html><head><title>Example</title></head><body><h1>Example Person</h1></body></html>",
        markdown: "# Example Person",
        metadata: {
          sourceURL: "https://www.linkedin.com/in/example",
          url: "https://www.linkedin.com/in/example",
          statusCode: 200,
          contentType: "text/markdown; charset=utf-8",
        },
      } as any,
    );

    expect(mockedPerformLLMExtract).toHaveBeenCalledTimes(1);
    expect(document.markdown).toBe("# Example Person");
    expect(document.json).toEqual({ name: "Example Person" });
  });

  it("passes a text/markdown body through untouched when no markdown is set", async () => {
    // Index cache hits return only the stored raw body, with no markdown.
    const rawBody =
      "# Pricing\n\n### Free\n\n**Price**: $0\n\n- 500 credits\n- [Docs](https://docs.firecrawl.dev/some_path)\n";

    const document = await executeTransformers(
      {
        url: "https://www.firecrawl.dev/pricing.md",
        options: {
          formats: [{ type: "markdown" }],
          onlyMainContent: true,
        },
        internalOptions: {},
        logger: logger(),
      } as any,
      {
        rawHtml: rawBody,
        metadata: {
          sourceURL: "https://www.firecrawl.dev/pricing.md",
          url: "https://www.firecrawl.dev/pricing.md",
          statusCode: 200,
          contentType: "text/markdown; charset=utf-8",
        },
      } as any,
    );

    expect(document.markdown).toBe(rawBody);
    expect(document.markdown).not.toContain("\\");
  });
});
