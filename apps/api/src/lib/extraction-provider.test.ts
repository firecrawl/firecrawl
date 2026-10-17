import { config } from "../config";
import {
  cohortBucket,
  extractionProviderCost,
  isRequestedModelSupported,
  selectExtractionRoute,
} from "./extraction-provider";

const base = { teamId: "team-a", zeroDataRetention: false, inputBytes: 10_000 };

function withConfig<T>(overrides: Partial<typeof config>, fn: () => T): T {
  const saved: Partial<typeof config> = {};
  for (const k of Object.keys(overrides) as (keyof typeof config)[]) {
    (saved as any)[k] = config[k];
    (config as any)[k] = overrides[k];
  }
  try {
    return fn();
  } finally {
    Object.assign(config, saved);
  }
}

describe("extraction provider routing", () => {
  it("is off when no provider is configured", () => {
    withConfig(
      {
        EXTRACTION_PROVIDER_BASE_URL: undefined,
        EXTRACTION_PROVIDER_ROLLOUT_PERCENT: 100,
      },
      () => expect(selectExtractionRoute(base)).toBe("default"),
    );
  });

  it("buckets teams stably and evenly enough to roll out by percentage", () => {
    const a = cohortBucket("team-a");
    expect(cohortBucket("team-a")).toBe(a);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(100);
    const buckets = new Set(
      Array.from({ length: 2000 }, (_, i) => cohortBucket(`team-${i}`)),
    );
    expect(buckets.size).toBe(100);
  });

  it("routes below the rollout percentage, shadows in the next band, defaults above", () => {
    withConfig(
      {
        EXTRACTION_PROVIDER_BASE_URL: "http://provider.local/v1",
        EXTRACTION_PROVIDER_ROLLOUT_PERCENT: 10,
        EXTRACTION_PROVIDER_SHADOW_PERCENT: 10,
        EXTRACTION_PROVIDER_TEAM_IDS: undefined,
      },
      () => {
        const teams = Array.from({ length: 500 }, (_, i) => `team-${i}`);
        for (const teamId of teams) {
          const b = cohortBucket(teamId);
          const expected = b < 10 ? "provider" : b < 20 ? "shadow" : "default";
          expect(selectExtractionRoute({ ...base, teamId })).toBe(expected);
        }
      },
    );
  });

  it("routes 100% and 0% as expected", () => {
    withConfig(
      {
        EXTRACTION_PROVIDER_BASE_URL: "http://provider.local/v1",
        EXTRACTION_PROVIDER_ROLLOUT_PERCENT: 100,
        EXTRACTION_PROVIDER_SHADOW_PERCENT: 0,
      },
      () => expect(selectExtractionRoute(base)).toBe("provider"),
    );
    withConfig(
      {
        EXTRACTION_PROVIDER_BASE_URL: "http://provider.local/v1",
        EXTRACTION_PROVIDER_ROLLOUT_PERCENT: 0,
        EXTRACTION_PROVIDER_SHADOW_PERCENT: 0,
        EXTRACTION_PROVIDER_TEAM_IDS: undefined,
      },
      () => expect(selectExtractionRoute(base)).toBe("default"),
    );
  });

  it("keeps zero-data-retention requests, oversized inputs and unknown teams on the default model", () => {
    withConfig(
      {
        EXTRACTION_PROVIDER_BASE_URL: "http://provider.local/v1",
        EXTRACTION_PROVIDER_ROLLOUT_PERCENT: 100,
        EXTRACTION_PROVIDER_MAX_INPUT_BYTES: 400_000,
      },
      () => {
        expect(
          selectExtractionRoute({ ...base, zeroDataRetention: true }),
        ).toBe("default");
        expect(selectExtractionRoute({ ...base, inputBytes: 400_001 })).toBe(
          "default",
        );
        expect(selectExtractionRoute({ ...base, teamId: undefined })).toBe(
          "default",
        );
      },
    );
  });

  it("always routes allowlisted teams", () => {
    withConfig(
      {
        EXTRACTION_PROVIDER_BASE_URL: "http://provider.local/v1",
        EXTRACTION_PROVIDER_ROLLOUT_PERCENT: 0,
        EXTRACTION_PROVIDER_TEAM_IDS: "x, team-a ,y",
      },
      () => {
        expect(selectExtractionRoute(base)).toBe("provider");
        expect(selectExtractionRoute({ ...base, teamId: "team-b" })).toBe(
          "default",
        );
      },
    );
  });

  it("prices only the configured provider model", () => {
    withConfig(
      {
        EXTRACTION_PROVIDER_BASE_URL: "http://provider.local/v1",
        EXTRACTION_PROVIDER_MODEL: "extraction-v1",
        EXTRACTION_PROVIDER_INPUT_COST_PER_MTOK: 0.07,
        EXTRACTION_PROVIDER_OUTPUT_COST_PER_MTOK: 0.2,
      },
      () => {
        expect(extractionProviderCost("extraction-v1")).toEqual({
          input_cost: 0.07,
          output_cost: 0.2,
        });
        expect(extractionProviderCost("gpt-4o-mini")).toBeUndefined();
      },
    );
  });

  it("honours a requested model for listed teams, or for everyone with the opt-in switch", () => {
    const cfg = {
      EXTRACTION_PROVIDER_BASE_URL: "http://provider.local/v1",
      EXTRACTION_PROVIDER_MODEL: "extraction-v1",
      EXTRACTION_PROVIDER_ROLLOUT_PERCENT: 0,
      EXTRACTION_PROVIDER_SHADOW_PERCENT: 0,
    };
    withConfig(
      {
        ...cfg,
        EXTRACTION_PROVIDER_TEAM_IDS: "team-a",
        EXTRACTION_PROVIDER_REQUEST_OPT_IN: false,
      },
      () => {
        expect(
          selectExtractionRoute({ ...base, requestedModel: "extraction-v1" }),
        ).toBe("provider");
        expect(
          selectExtractionRoute({
            ...base,
            teamId: "team-b",
            requestedModel: "extraction-v1",
          }),
        ).toBe("default");
        expect(
          selectExtractionRoute({ ...base, requestedModel: "something-else" }),
        ).toBe("default");
        expect(
          selectExtractionRoute({
            ...base,
            requestedModel: "extraction-v1",
            zeroDataRetention: true,
          }),
        ).toBe("default");
      },
    );
    withConfig(
      {
        ...cfg,
        EXTRACTION_PROVIDER_TEAM_IDS: undefined,
        EXTRACTION_PROVIDER_REQUEST_OPT_IN: true,
      },
      () => {
        expect(
          selectExtractionRoute({
            ...base,
            teamId: "team-b",
            requestedModel: "extraction-v1",
          }),
        ).toBe("provider");
      },
    );
    withConfig({ ...cfg }, () => {
      expect(isRequestedModelSupported("extraction-v1")).toBe(true);
      expect(isRequestedModelSupported("gpt-4o-mini")).toBe(false);
    });
    withConfig({ ...cfg, EXTRACTION_PROVIDER_BASE_URL: undefined }, () =>
      expect(isRequestedModelSupported("extraction-v1")).toBe(false),
    );
  });
});
