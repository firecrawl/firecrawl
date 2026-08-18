import { config, type ResearchPaperOperation } from "../config";
import { researchKeylessDisabled } from "./keyless-metrics";

const OPERATIONS: ResearchPaperOperation[] = [
  "search",
  "inspect",
  "read",
  "similar",
];

describe("keyless launch metrics", () => {
  it("exports the configured Research Index kill-switch state per operation", async () => {
    const metric = await researchKeylessDisabled.get();

    for (const operation of OPERATIONS) {
      expect(
        metric.values.find(value => value.labels.operation === operation)
          ?.value,
      ).toBe(config.RESEARCH_KEYLESS_DISABLED.includes(operation) ? 1 : 0);
    }
  });
});
