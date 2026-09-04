import { MockLanguageModelV3 } from "ai/test";
import { analyzeSchemaAndPrompt_F0 } from "../../../lib/extract/fire-0/completions/analyzeSchemaAndPrompt-f0";
import { getModel } from "../../../lib/generic-ai";
import { logger } from "../../../lib/logger";

vi.mock("../../../lib/generic-ai", () => ({ getModel: vi.fn() }));
vi.mock("../../../lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe("analyzeSchemaAndPrompt_F0", () => {
  const singleEntity = {
    isMultiEntity: false,
    multiEntityKeys: [],
    reasoning: "One company profile",
    keyIndicators: ["single company"],
  };
  const multiEntity = {
    isMultiEntity: true,
    multiEntityKeys: ["ecommerce.products"],
    reasoning: "Products distributed across many pages",
    keyIndicators: ["multiple product pages"],
  };

  function mockAnalysis(result: unknown) {
    const model = new MockLanguageModelV3({
      modelId: "gpt-4.1",
      doGenerate: {
        content: [{ type: "text", text: JSON.stringify(result) }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: {
            total: 10,
            noCache: 10,
            cacheRead: 0,
            cacheWrite: 0,
          },
          outputTokens: { total: 20, text: 20, reasoning: 0 },
        },
        warnings: [],
      },
    });
    vi.mocked(getModel).mockReturnValue(model);
    return model;
  }

  function analyze() {
    return analyzeSchemaAndPrompt_F0(
      ["https://example.com"],
      { type: "object", properties: { name: { type: "string" } } },
      "Extract the requested data",
      { teamId: "test-team" },
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends every property as required in the provider's JSON schema", async () => {
    const model = mockAnalysis(multiEntity);

    await analyze();

    // Inspect the schema after the real completion helper and AI SDK have
    // serialized it. A Zod prefault can accept a missing key locally while
    // leaving it optional in this schema, which strict providers reject.
    const format = model.doGenerateCalls[0].responseFormat;
    expect(format?.type).toBe("json");
    if (format?.type !== "json") throw new Error("Expected JSON output");
    expect(format.schema?.required).toEqual(
      Object.keys(format.schema?.properties ?? {}),
    );
    expect(format.schema?.required).toContain("multiEntityKeys");
  });

  it.each([singleEntity, multiEntity])(
    "preserves a valid analysis with isMultiEntity=$isMultiEntity",
    async output => {
      mockAnalysis(output);

      expect(await analyze()).toMatchObject({
        ...output,
        tokenUsage: { completionTokens: 20 },
      });
      expect(logger.warn).not.toHaveBeenCalled();
    },
  );

  it("rejects a multi-entity result without any entity keys", async () => {
    mockAnalysis({ ...multiEntity, multiEntityKeys: [] });

    expect(await analyze()).toMatchObject({
      isMultiEntity: false,
      multiEntityKeys: [],
      reasoning: "",
      tokenUsage: { totalTokens: 0 },
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "(analyzeSchemaAndPrompt) Error parsing schema analysis",
      expect.objectContaining({ error: expect.any(Error) }),
    );
  });
});
