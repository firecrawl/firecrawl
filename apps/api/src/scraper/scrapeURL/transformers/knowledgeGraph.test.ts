import { vi } from "vitest";
import { generateObject } from "ai";
import { performKnowledgeGraph } from "./knowledgeGraph";
import { config } from "../../../config";

// Only generateObject is faked; the rest of the `ai` SDK (jsonSchema,
// NoObjectGeneratedError, etc.) stays real so generateCompletions runs its
// genuine retry/control flow. This is the only point where the LLM is reached,
// so faking it lets us force failures the real provider won't reliably produce.
vi.mock("ai", async importOriginal => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateObject: vi.fn() };
});

const mockedGenerateObject = generateObject as unknown as ReturnType<
  typeof vi.fn
>;

const makeMeta = () =>
  ({
    options: { formats: [{ type: "knowledgeGraph" }] },
    internalOptions: { zeroDataRetention: false, teamId: "test-team" },
    logger: {
      child: vi.fn(() => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      })),
      info: vi.fn(),
    },
    costTracking: { addCall: vi.fn() },
    id: "test-id",
  }) as any;

describe("performKnowledgeGraph LLM failure/retry path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("warns and skips generation under zero data retention", async () => {
    const meta = makeMeta();
    meta.internalOptions.zeroDataRetention = true;
    const document = { markdown: "# Ada Lovelace" } as any;

    const result = await performKnowledgeGraph(meta, document);

    expect(result.knowledgeGraph).toBeUndefined();
    expect(result.warning).toContain("zero data retention");
    expect(mockedGenerateObject).not.toHaveBeenCalled();
  });

  it("warns and skips empty markdown", async () => {
    const result = await performKnowledgeGraph(makeMeta(), {
      markdown: "  ",
    } as any);

    expect(result.knowledgeGraph).toBeUndefined();
    expect(result.warning).toContain("markdown content is empty");
    expect(mockedGenerateObject).not.toHaveBeenCalled();
  });

  it("tells the extraction model to preserve asymmetric edge direction", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: { nodes: [], edges: [] },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });

    await performKnowledgeGraph(makeMeta(), {
      markdown: "Ada Lovelace was Lord Byron's daughter.",
    } as any);

    const instructions = mockedGenerateObject.mock.calls[0][0].system;
    expect(instructions).toContain("source is the subject");
    expect(instructions).toContain("Ada Lovelace");
    expect(instructions).toContain("child_of");
    expect(instructions).toContain(
      "never Ada Lovelace -> Lord Byron: parent_of",
    );
  });

  it("corrects parent direction only when the article infobox identifies the parent", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: {
        nodes: [
          { id: "ada", label: "Ada Lovelace", type: "Person" },
          { id: "byron", label: "George Byron", type: "Person" },
          { id: "anne", label: "Anne Isabella Milbanke", type: "Person" },
        ],
        edges: [
          { source: "ada", target: "byron", relation: "parent_of" },
          { source: "ada", target: "anne", relation: "parent_of" },
          { source: "byron", target: "ada", relation: "parent_of" },
        ],
      },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });

    const result = await performKnowledgeGraph(makeMeta(), {
      markdown: `Ada Lovelace
============
| Parents | * [George Byron, 6th Baron Byron](https://en.wikipedia.org/wiki/Lord_Byron)<br> (father)<br>* [Anne Isabella Milbanke](https://en.wikipedia.org/wiki/Lady_Byron)<br> (mother) |`,
    } as any);

    expect(result.knowledgeGraph?.edges).toEqual([
      { source: "ada", target: "byron", relation: "child_of" },
      { source: "ada", target: "anne", relation: "child_of" },
      { source: "byron", target: "ada", relation: "parent_of" },
    ]);
  });

  it("drops unsupported parent_of edges between the article subject's parents", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: {
        nodes: [
          { id: "ada", label: "Ada Lovelace", type: "Person" },
          { id: "lord", label: "Lord Byron", type: "Person" },
          {
            id: "george",
            label: "George Byron, 6th Baron Byron",
            type: "Person",
          },
          { id: "anne", label: "Anne Isabella Milbanke", type: "Person" },
        ],
        edges: [
          { source: "lord", target: "george", relation: "parent_of" },
          { source: "lord", target: "anne", relation: "parent_of" },
          { source: "ada", target: "lord", relation: "child_of" },
        ],
      },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });

    const result = await performKnowledgeGraph(makeMeta(), {
      markdown: `Ada Lovelace
============
| Parents | * [George Byron, 6th Baron Byron](https://en.wikipedia.org/wiki/Lord_Byron "Lord Byron")<br> (father)<br>* [Anne Isabella Milbanke](https://en.wikipedia.org/wiki/Lady_Byron "Lady Byron")<br> (mother) |`,
    } as any);

    expect(result.knowledgeGraph?.edges).toEqual([
      { source: "ada", target: "lord", relation: "child_of" },
    ]);
  });

  it("leaves a parent_of edge untouched without source evidence", async () => {
    const graph = {
      nodes: [
        { id: "parent", label: "Parent", type: "Person" },
        { id: "child", label: "Child", type: "Person" },
      ],
      edges: [{ source: "parent", target: "child", relation: "parent_of" }],
    };
    mockedGenerateObject.mockResolvedValueOnce({
      object: graph,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });

    const result = await performKnowledgeGraph(makeMeta(), {
      markdown: "# Family story\nA parent has a child.",
    } as any);

    expect(result.knowledgeGraph?.edges).toEqual(graph.edges);
  });

  it("uses KG-specific primary and retry models even with a global override", async () => {
    const original = {
      primary: config.KG_MODEL,
      retry: config.KG_RETRY_MODEL,
      global: config.MODEL_NAME,
    };
    try {
      config.KG_MODEL = "gpt-4.1";
      config.KG_RETRY_MODEL = "gpt-5";
      config.MODEL_NAME = "global-override";
      mockedGenerateObject
        .mockRejectedValueOnce(new Error("rate limit exceeded"))
        .mockResolvedValueOnce({
          object: { nodes: [], edges: [] },
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        });

      await performKnowledgeGraph(makeMeta(), {
        markdown: "# Small page",
      } as any);

      expect(mockedGenerateObject.mock.calls[0][0].model.modelId).toBe(
        "gpt-4.1",
      );
      expect(mockedGenerateObject.mock.calls[1][0].model.modelId).toBe("gpt-5");
    } finally {
      config.KG_MODEL = original.primary;
      config.KG_RETRY_MODEL = original.retry;
      config.MODEL_NAME = original.global;
    }
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
