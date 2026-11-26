import type { MockedFunction } from "vitest";
import { executeTransformers } from ".";
import { performLLMExtract } from "./llmExtract";

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

  it("strips NUL characters from engine-delivered markdown and rawHtml", async () => {
    const document = await executeTransformers(
      {
        url: "https://example.com/form.pdf",
        options: {
          formats: [{ type: "markdown" }, { type: "rawHtml" }],
          onlyMainContent: false,
        },
        internalOptions: {},
        logger: logger(),
      } as any,
      {
        rawHtml: "<p>field: S\u0000c\u0000h</p>",
        markdown: "field: S\u0000c\u0000h",
        metadata: {
          sourceURL: "https://example.com/form.pdf",
          url: "https://example.com/form.pdf",
          statusCode: 200,
          contentType: "application/pdf",
        },
      } as any,
    );

    expect(document.markdown).toBe("field: Sch");
    expect(document.rawHtml).toBe("<p>field: Sch</p>");
  });
});
