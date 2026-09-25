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

  it("keeps native JSON and markdown without running LLM JSON extraction", async () => {
    const nativeJson = { id: "person-1", full_name: "Example Person" };
    const nativeMarkdown = "# Example Person";

    const document = await executeTransformers(
      {
        url: "https://www.linkedin.com/in/example",
        options: {
          formats: [{ type: "markdown" }, { type: "json" }],
          onlyMainContent: false,
        },
        internalOptions: {},
        logger: logger(),
      } as any,
      {
        rawHtml:
          "<html><head><title>Ignored</title></head><body></body></html>",
        markdown: nativeMarkdown,
        json: nativeJson,
        metadata: {
          sourceURL: "https://www.linkedin.com/in/example",
          url: "https://www.linkedin.com/in/example",
          statusCode: 200,
          contentType: "text/markdown; charset=utf-8",
        },
      } as any,
    );

    expect(mockedPerformLLMExtract).not.toHaveBeenCalled();
    expect(document.markdown).toBe(nativeMarkdown);
    expect(document.json).toEqual(nativeJson);
  });

  it("maps native JSON to v1 extract compatibility field", async () => {
    const nativeJson = { id: "person-1", full_name: "Example Person" };

    const document = await executeTransformers(
      {
        url: "https://www.linkedin.com/in/example",
        options: {
          formats: [{ type: "markdown" }, { type: "json" }],
          onlyMainContent: false,
        },
        internalOptions: { v1OriginalFormat: "extract" },
        logger: logger(),
      } as any,
      {
        rawHtml:
          "<html><head><title>Ignored</title></head><body></body></html>",
        markdown: "# Example Person",
        json: nativeJson,
        metadata: {
          sourceURL: "https://www.linkedin.com/in/example",
          url: "https://www.linkedin.com/in/example",
          statusCode: 200,
          contentType: "text/markdown; charset=utf-8",
        },
      } as any,
    );

    expect(mockedPerformLLMExtract).not.toHaveBeenCalled();
    expect(document.extract).toEqual(nativeJson);
    expect(document.json).toEqual(nativeJson);
  });

  // Bodies served as text/markdown (e.g. /docs/page.md) reach this transformer
  // without a markdown field when the engine does not set one (the fetch
  // engine never does). They are already markdown, like text/plain.
  it.each(["text/markdown; charset=utf-8", "text/x-markdown", "Text/Markdown"])(
    "passes a %s body through as markdown",
    async contentType => {
      const body = [
        "# Access policies",
        "",
        "- [access_policies](https://example.com/docs/access_policies)",
        "- Use `snake_case` keys",
        "",
      ].join("\n");

      const document = await executeTransformers(
        {
          url: "https://example.com/docs/access.md",
          options: {
            formats: [{ type: "markdown" }],
            onlyMainContent: true,
          },
          internalOptions: {},
          logger: logger(),
        } as any,
        {
          rawHtml: body,
          metadata: {
            sourceURL: "https://example.com/docs/access.md",
            url: "https://example.com/docs/access.md",
            statusCode: 200,
            contentType,
          },
        } as any,
      );

      expect(document.markdown).toBe(body);
    },
  );
});
