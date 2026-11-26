import { z } from "zod";
import { jsonRecordSchema } from "../../lib/json-types";
import type { JsonObject } from "../../lib/json-types";
import { jobLogJson, jobLogRows } from "./job-log";

const costTrackingCallSchema = z.object({
  model: z.string(),
  cost: z.number(),
  metadata: jsonRecordSchema,
  tokens: z
    .object({
      input: z.number(),
      output: z.number(),
    })
    .optional(),
});

const costTrackingEnvelopeSchema = z.object({
  calls: z.array(z.unknown()).optional(),
});

export type CostTrackingCall = {
  model: string;
  cost: number;
  metadata: JsonObject;
  tokens?: { input: number; output: number };
};

// The scrape row is published when the job finishes and lands in ClickHouse a
// few seconds later; poll until it carries parseable cost tracking.
export async function getCostTrackingCalls(
  scrapeId: string,
): Promise<Array<CostTrackingCall>> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const [row] = await jobLogRows("scrapes", "id = {id: UUID}", {
      id: scrapeId,
    });
    const parsedTracking = costTrackingEnvelopeSchema.safeParse(
      jobLogJson(row?.cost_tracking),
    );
    if (parsedTracking.success) {
      if (parsedTracking.data.calls) {
        return parsedTracking.data.calls.flatMap(call => {
          const parsedCall = costTrackingCallSchema.safeParse(call);
          return parsedCall.success ? [parsedCall.data] : [];
        });
      }
      return [];
    }
    await new Promise<void>(resolve => {
      setTimeout(resolve, 1000);
    });
  }
  throw new Error(`No cost tracking on the scrapes row for ${scrapeId}`);
}
