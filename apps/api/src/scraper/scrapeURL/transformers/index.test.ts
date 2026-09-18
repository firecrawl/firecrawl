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

  it.each([
    "application/json",
    "Application/JSON; charset=utf-8",
    "application/vnd.api+json",
    "application/ld+json; charset=utf-8",
    "Application/Problem+JSON",
  ])("preserves %s bodies in a JSON code fence", async contentType => {
    const rawHtml = JSON.stringify({
      data: [{ full_name: "a_b", tags: ["c_d"] }],
    });
    const document = await executeTransformers(
      {
        url: "https://example.com/api",
        options: { formats: [{ type: "markdown" }], onlyMainContent: false },
        internalOptions: {},
        logger: logger(),
      } as any,
      { rawHtml, metadata: { contentType } } as any,
    );

    expect(document.markdown).toBe("```json\n" + rawHtml + "\n```");
  });

  it.each([
    'text/html; profile="application/json"',
    'text/html; profile="application/vnd.api+json"',
  ])("does not treat %s as JSON", async contentType => {
    const document = await executeTransformers(
      {
        url: "https://example.com",
        options: { formats: [{ type: "markdown" }], onlyMainContent: false },
        internalOptions: {},
        logger: logger(),
      } as any,
      {
        rawHtml:
          "<html><body><p>Hello <strong>world</strong></p></body></html>",
        metadata: {
          contentType,
        },
      } as any,
    );

    expect(document.markdown).toContain("Hello **world**");
    expect(document.markdown).not.toContain("```json");
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
});
