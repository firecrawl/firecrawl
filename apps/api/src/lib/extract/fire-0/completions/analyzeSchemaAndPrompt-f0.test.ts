import { vi } from "vitest";

vi.mock("ai", async importOriginal => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateObject: vi.fn() };
});
vi.mock("../../../generic-ai", () => ({
  getModel: vi.fn((name: string) => ({ modelId: name })),
}));

import { generateObject } from "ai";
import type { Mock } from "vitest";
import { analyzeSchemaAndPrompt_F0 } from "./analyzeSchemaAndPrompt-f0";

const schema = {
  type: "object",
  properties: { products: { type: "array", items: { type: "string" } } },
};

function calls() {
  return (generateObject as Mock).mock.calls.map(([args]) => args);
}

function respond(object: unknown) {
  (generateObject as Mock).mockResolvedValueOnce({
    object,
    usage: { outputTokens: 1 },
  });
}

describe("analyzeSchemaAndPrompt_F0 telemetry", () => {
  beforeEach(() => {
    (generateObject as Mock).mockReset();
  });

  it("attributes the gpt-4.1 analysis call to the extract that ran it", async () => {
    respond({
      isMultiEntity: true,
      multiEntityKeys: ["products"],
      reasoning: "a list of products",
      keyIndicators: ["products"],
    });

    const result = await analyzeSchemaAndPrompt_F0(
      ["https://example.com"],
      schema,
      "list the products",
      {
        teamId: "team-1",
        extractId: "extract-1",
        functionId: "performExtraction_F0",
      },
    );

    expect(result.isMultiEntity).toBe(true);
    expect(calls()).toHaveLength(1);
    const [args] = calls();
    expect(args.model.modelId).toBe("gpt-4.1");
    expect(args.experimental_telemetry).toEqual({
      isEnabled: true,
      functionId: "performExtraction_F0/analyzeSchemaAndPrompt_F0",
      metadata: {
        teamId: "team-1",
        extractId: "extract-1",
        langfuseTraceId: "extract:extract-1",
      },
    });
    expect(args.providerOptions.google.labels).toMatchObject({
      functionId: "performExtraction_F0/analyzeSchemaAndPrompt_F0",
      extractId: "extract-1",
      teamId: "team-1",
    });
  });

  it("falls back to its own name when the caller passes no functionId", async () => {
    respond({
      isMultiEntity: false,
      multiEntityKeys: [],
      reasoning: "",
      keyIndicators: [],
    });

    await analyzeSchemaAndPrompt_F0(["https://example.com"], schema, "", {
      teamId: "team-1",
    });

    const [args] = calls();
    expect(args.experimental_telemetry.functionId).toBe(
      "analyzeSchemaAndPrompt_F0",
    );
    expect(args.experimental_telemetry.metadata).toEqual({ teamId: "team-1" });
  });

  it("names the schema generation call it makes when no schema is given", async () => {
    respond(schema);
    respond({
      isMultiEntity: false,
      multiEntityKeys: [],
      reasoning: "",
      keyIndicators: [],
    });

    await analyzeSchemaAndPrompt_F0(
      ["https://example.com"],
      undefined,
      "list the products",
      {
        teamId: "team-1",
        extractId: "extract-1",
        functionId: "performExtraction_F0",
      },
    );

    expect(calls().map(args => args.experimental_telemetry.functionId)).toEqual(
      [
        "performExtraction_F0/generateSchemaFromPrompt_F0",
        "performExtraction_F0/analyzeSchemaAndPrompt_F0",
      ],
    );
  });

  it("keeps the telemetry settings when the model call fails", async () => {
    (generateObject as Mock).mockRejectedValueOnce(new Error("rate limited"));

    const result = await analyzeSchemaAndPrompt_F0(
      ["https://example.com"],
      schema,
      "list the products",
      {
        teamId: "team-1",
        extractId: "extract-1",
        functionId: "performExtraction_F0",
      },
    );

    expect(result).toMatchObject({ isMultiEntity: false, multiEntityKeys: [] });
    const [args] = calls();
    expect(args.experimental_telemetry.functionId).toBe(
      "performExtraction_F0/analyzeSchemaAndPrompt_F0",
    );
  });
});
