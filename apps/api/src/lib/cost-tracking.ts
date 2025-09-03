export class CostLimitExceededError extends Error {
  constructor() {
    super("Cost limit exceeded");
    this.message = "Cost limit exceeded";
    this.name = "CostLimitExceededError";
  }
}

const nanProof = (n: number | null | undefined) =>
  isNaN(n ?? 0) ? 0 : (n ?? 0);

export class CostTracking {
  calls: {
    type: "smartScrape" | "other";
    metadata: Record<string, any>;
    cost: number;
    model: string;
    tokens?: {
      input: number;
      output: number;
    };
    stack: string;
  }[] = [];
  limit: number | null = null;

  constructor(limit: number | null = null) {
    this.limit = limit;
  }

  public addCall(call: Omit<(typeof this.calls)[number], "stack">) {
    this.calls.push({
      ...call,
      stack: new Error().stack!.split("\n").slice(2).join("\n"),
    });

    if (this.limit !== null && this.toJSON().totalCost > this.limit) {
      throw new CostLimitExceededError();
    }
  }

  public toJSON() {
    return {
      calls: this.calls,

      smartScrapeCallCount: this.calls.filter(c => c.type === "smartScrape")
        .length,
      smartScrapeCost: this.calls
        .filter(c => c.type === "smartScrape")
        .reduce((acc, c) => acc + nanProof(c.cost), 0),
      otherCallCount: this.calls.filter(c => c.type === "other").length,
      otherCost: this.calls
        .filter(c => c.type === "other")
        .reduce((acc, c) => acc + nanProof(c.cost), 0),
      totalCost: this.calls.reduce((acc, c) => acc + nanProof(c.cost), 0),
    };
  }
}
