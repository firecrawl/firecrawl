import { jobLogJson, jobLogRows } from "./job-log";

export type CostTrackingCall = {
  model: string;
  cost: number;
  metadata: Record<string, unknown>;
  tokens?: { input: number; output: number };
};

// The scrape row is published when the job finishes and lands in ClickHouse a
// few seconds later; poll until it carries parseable cost tracking.
export async function getCostTrackingCalls(
  scrapeId: string,
): Promise<CostTrackingCall[]> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const [row] = await jobLogRows("scrapes", "id = {id: UUID}", {
      id: scrapeId,
    });
    const costTracking = jobLogJson(row?.cost_tracking) as {
      calls?: CostTrackingCall[];
    } | null;
    if (costTracking) return costTracking.calls ?? [];
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`No cost tracking on the scrapes row for ${scrapeId}`);
}
