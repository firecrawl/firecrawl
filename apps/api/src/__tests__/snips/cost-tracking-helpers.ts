import { isJsonObject } from "../../lib/json-types";
import type { JsonObject } from "../../lib/json-types";
import { jobLogJson, jobLogRows } from "./job-log";

export type CostTrackingCall = {
  model: string;
  cost: number;
  metadata: JsonObject;
  tokens?: { input: number; output: number };
};

function isCostTrackingCall(value: unknown): value is CostTrackingCall {
  if (!isJsonObject(value)) {
    return false;
  }
  if (typeof value.model !== "string" || typeof value.cost !== "number") {
    return false;
  }
  if (!isJsonObject(value.metadata)) {
    return false;
  }
  if (value.tokens !== undefined) {
    if (
      !isJsonObject(value.tokens) ||
      typeof value.tokens.input !== "number" ||
      typeof value.tokens.output !== "number"
    ) {
      return false;
    }
  }
  return true;
}

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
    const costTracking = jobLogJson(row?.cost_tracking);
    if (isJsonObject(costTracking)) {
      if (Array.isArray(costTracking.calls)) {
        return costTracking.calls.filter(isCostTrackingCall);
      }
      return [];
    }
    await new Promise<void>(resolve => {
      setTimeout(resolve, 1000);
    });
  }
  throw new Error(`No cost tracking on the scrapes row for ${scrapeId}`);
}
