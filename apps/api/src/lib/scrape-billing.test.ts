import { calculateCreditsToBeBilled } from "./scrape-billing";

describe("calculateCreditsToBeBilled", () => {
  it("bills X/Twitter scrapes at 30 credits", async () => {
    const credits = await calculateCreditsToBeBilled(
      {
        formats: [{ type: "markdown" }],
      } as any,
      {
        teamId: "team-id",
      },
      {
        metadata: {
          statusCode: 200,
          proxyUsed: "basic",
          postprocessorsUsed: ["x-twitter"],
        },
      } as any,
      {
        totalCost: 0,
      } as any,
      {} as any,
    );

    expect(credits).toBe(30);
  });

  it("bills deterministic JSON at 10 credits when the script was generated", async () => {
    const credits = await calculateCreditsToBeBilled(
      {
        formats: [{ type: "deterministicJson", schema: {} }],
      } as any,
      {
        teamId: "team-id",
      },
      {
        metadata: {
          statusCode: 200,
          proxyUsed: "basic",
        },
      } as any,
      {
        totalCost: 0.01,
        calls: [
          {
            type: "other",
            model: "vertex/gemini",
            cost: 0.01,
            metadata: { module: "deterministic-json", role: "codegen" },
          },
        ],
      } as any,
      {} as any,
    );

    expect(credits).toBe(10);
  });

  it("bills deterministic JSON at 3 credits when a cached script was reused", async () => {
    const credits = await calculateCreditsToBeBilled(
      {
        formats: [{ type: "deterministicJson", schema: {} }],
      } as any,
      {
        teamId: "team-id",
      },
      {
        metadata: {
          statusCode: 200,
          proxyUsed: "basic",
        },
      } as any,
      {
        totalCost: 0.001,
        calls: [
          {
            type: "other",
            model: "groq/llama",
            cost: 0.001,
            metadata: { module: "deterministic-json", role: "askLlm" },
          },
        ],
      } as any,
      {} as any,
    );

    expect(credits).toBe(3);
  });
});
