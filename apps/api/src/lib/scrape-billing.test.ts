import {
  calculateCreditsToBeBilled,
  calculateThreatScanCredits,
} from "./scrape-billing";
import { UnsafeDomainBlockedError } from "./threat-protection/error";
import type { ThreatDecision } from "./threat-protection/types";

describe("calculateCreditsToBeBilled", () => {
  it("bills handled data layer successes at 15 credits", async () => {
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
          url: "https://profiles.example/in/example-person",
          proxyUsed: "basic",
        },
      } as any,
      {
        totalCost: 0,
      } as any,
      {} as any,
      undefined,
      undefined,
      { handled: true },
    );

    expect(credits).toBe(15);
  });

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

// =========================================
// Threat protection scan fees (ENG-4985)
// =========================================

const consulted = (allowed = true): ThreatDecision => ({
  allowed,
  rule: allowed ? "default-allow" : "risk-score",
  providerConsulted: true,
  verdict: {
    provider: "google-web-risk",
    riskScore: allowed ? 0 : 100,
    categories: [],
    fromCache: false,
    raw: {},
  },
  mode: "normal",
});

const localOnly = (
  rule: ThreatDecision["rule"],
  allowed: boolean,
): ThreatDecision => ({
  allowed,
  rule,
  providerConsulted: false,
  verdict: null,
  mode: "normal",
});

const billWithDecisions = (args: {
  document: { metadata: Record<string, unknown> } | null;
  error?: Error | null;
  threatDecisions?: ThreatDecision[];
}) =>
  calculateCreditsToBeBilled(
    { formats: [{ type: "markdown" }] } as any,
    { teamId: "team-id" },
    args.document as any,
    { totalCost: 0 } as any,
    {} as any,
    args.error,
    undefined,
    undefined,
    args.threatDecisions,
  );

const successDocument = {
  metadata: { statusCode: 200, proxyUsed: "basic" },
};

describe("calculateThreatScanCredits", () => {
  it("bills nothing for no decisions", () => {
    expect(calculateThreatScanCredits([])).toBe(0);
  });

  it("bills +2 per consulted decision", () => {
    expect(calculateThreatScanCredits([consulted()])).toBe(2);
    expect(calculateThreatScanCredits([consulted(), consulted()])).toBe(4);
  });

  it("bills consulted decisions regardless of the allow/block outcome", () => {
    expect(calculateThreatScanCredits([consulted(false)])).toBe(2);
  });

  it("bills cached verdicts the same as fresh ones", () => {
    const cached = consulted();
    cached.verdict = { ...cached.verdict!, fromCache: true };
    expect(calculateThreatScanCredits([cached])).toBe(2);
  });

  it("never bills local-only decisions", () => {
    expect(
      calculateThreatScanCredits([
        localOnly("whitelist", true),
        localOnly("blacklist", false),
        localOnly("blocked-tld", false),
        localOnly("provider-failure", false),
      ]),
    ).toBe(0);
  });

  it("sums mixed decisions", () => {
    expect(
      calculateThreatScanCredits([
        consulted(),
        consulted(false),
        localOnly("blacklist", false),
      ]),
    ).toBe(4);
  });
});

describe("calculateCreditsToBeBilled — threat protection scan fees", () => {
  it("adds +2 to a successful scrape with a consulted decision", async () => {
    expect(
      await billWithDecisions({
        document: successDocument,
        threatDecisions: [consulted()],
      }),
    ).toBe(3);
  });

  it("bills each consulted decision on a redirect (two domains scanned)", async () => {
    expect(
      await billWithDecisions({
        document: successDocument,
        threatDecisions: [consulted(), consulted()],
      }),
    ).toBe(5);
  });

  it("adds nothing for local-only decisions on success", async () => {
    expect(
      await billWithDecisions({
        document: successDocument,
        threatDecisions: [localOnly("whitelist", true)],
      }),
    ).toBe(1);
  });

  it("bills the scan fee (and no base cost) for a blocked scrape", async () => {
    const decision = consulted(false);
    expect(
      await billWithDecisions({
        document: null,
        error: new UnsafeDomainBlockedError("blocked.example.com", decision),
        threatDecisions: [decision],
      }),
    ).toBe(2);
  });

  it("bills a blocked scrape from the error decision when the decisions array is missing", async () => {
    const decision = consulted(false);
    expect(
      await billWithDecisions({
        document: null,
        error: new UnsafeDomainBlockedError("blocked.example.com", decision),
      }),
    ).toBe(2);
  });

  it("does not double-bill when the error decision is also in the decisions array", async () => {
    const initial = consulted();
    const redirectBlock = consulted(false);
    expect(
      await billWithDecisions({
        document: null,
        error: new UnsafeDomainBlockedError(
          "blocked.example.com",
          redirectBlock,
        ),
        threatDecisions: [initial, redirectBlock],
      }),
    ).toBe(4);
  });

  it("bills nothing for a blocked scrape decided by local-only rules", async () => {
    const decision = localOnly("blacklist", false);
    expect(
      await billWithDecisions({
        document: null,
        error: new UnsafeDomainBlockedError("blocked.example.com", decision),
        threatDecisions: [decision],
      }),
    ).toBe(0);
  });

  it("bills nothing for unrelated failures without decisions", async () => {
    expect(
      await billWithDecisions({
        document: null,
        error: new Error("engine failure"),
      }),
    ).toBe(0);
  });

  it("adds the scan fee on top of other failure billing (scan happened before the failure)", async () => {
    expect(
      await billWithDecisions({
        document: null,
        error: new Error("engine failure"),
        threatDecisions: [consulted()],
      }),
    ).toBe(2);
  });
});
