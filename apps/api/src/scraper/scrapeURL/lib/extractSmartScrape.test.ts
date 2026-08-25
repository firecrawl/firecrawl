import { extractData } from "./extractSmartScrape";
import { JsonExtractionContentTooLargeError } from "../error";
import { CostTracking } from "../../../lib/cost-tracking";

const noopLogger = {
  warn: () => {},
  info: () => {},
  error: () => {},
  debug: () => {},
} as any;

describe("extractData", () => {
  it("rejects markdown over the size cap before any extraction call, regardless of checkPromptInjection", async () => {
    const markdown = "x".repeat(2_100_000);

    await expect(
      extractData({
        extractOptions: {
          logger: noopLogger,
          options: { schema: { type: "object", properties: {} } },
          markdown,
          costTrackingOptions: {
            costTracking: new CostTracking(),
            metadata: {},
          },
          metadata: { teamId: "test-team" },
        } as any,
        urls: ["https://example.com"],
        useAgent: false,
        metadata: { teamId: "test-team" },
      }),
    ).rejects.toBeInstanceOf(JsonExtractionContentTooLargeError);
  });
});
