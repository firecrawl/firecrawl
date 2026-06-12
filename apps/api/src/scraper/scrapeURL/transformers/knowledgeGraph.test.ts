import { generateObject } from "ai";
import { performKnowledgeGraph } from "./knowledgeGraph";

// Only generateObject is faked; the rest of the `ai` SDK (jsonSchema,
// NoObjectGeneratedError, etc.) stays real so generateCompletions runs its
// genuine retry/control flow. This is the only point where the LLM is reached,
// so faking it lets us force failures the real provider won't reliably produce.
jest.mock("ai", () => {
  const actual = jest.requireActual("ai");
  return { ...actual, generateObject: jest.fn() };
});

const mockedGenerateObject = generateObject as unknown as jest.Mock;

const makeMeta = () =>
  ({
    options: { formats: [{ type: "knowledgeGraph" }] },
    internalOptions: { zeroDataRetention: false, teamId: "test-team" },
    logger: {
      child: jest.fn(() => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      })),
      info: jest.fn(),
    },
    costTracking: { addCall: jest.fn() },
    id: "test-id",
  }) as any;

describe("performKnowledgeGraph LLM failure/retry path", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("falls back to the retry model when the primary hits a rate limit", async () => {
    const graph = {
      nodes: [{ id: "ada", label: "Ada Lovelace", type: "Person" }],
      edges: [],
    };
    // Primary model rate-limited; fallback succeeds.
    mockedGenerateObject
      .mockRejectedValueOnce(new Error("rate limit exceeded"))
      .mockResolvedValueOnce({
        object: graph,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      });

    const document = {
      markdown: "# Ada Lovelace\nA 19th-century mathematician.",
    } as any;

    const result = await performKnowledgeGraph(makeMeta(), document);

    expect(mockedGenerateObject).toHaveBeenCalledTimes(2);
    // Primary attempt uses gpt-4o-mini; retry switches to the fallback model.
    expect(mockedGenerateObject.mock.calls[0][0].model.modelId).toBe(
      "gpt-4o-mini",
    );
    expect(mockedGenerateObject.mock.calls[1][0].model.modelId).toBe(
      "gpt-4.1-mini",
    );
    expect(result.knowledgeGraph).toEqual(graph);
  });

  it("throws when the fallback model also fails", async () => {
    mockedGenerateObject
      .mockRejectedValueOnce(new Error("Quota exceeded"))
      .mockRejectedValueOnce(new Error("Quota exceeded on fallback"));

    const document = { markdown: "# Some page content" } as any;

    await expect(performKnowledgeGraph(makeMeta(), document)).rejects.toThrow(
      "Quota exceeded on fallback",
    );
    expect(mockedGenerateObject).toHaveBeenCalledTimes(2);
  });

  it("does not retry on a non-quota error", async () => {
    mockedGenerateObject.mockRejectedValueOnce(
      new Error("invalid request: bad schema"),
    );

    const document = { markdown: "# Some page content" } as any;

    await expect(performKnowledgeGraph(makeMeta(), document)).rejects.toThrow(
      "invalid request: bad schema",
    );
    // No fallback attempt for errors outside the quota/rate-limit class.
    expect(mockedGenerateObject).toHaveBeenCalledTimes(1);
  });
});
