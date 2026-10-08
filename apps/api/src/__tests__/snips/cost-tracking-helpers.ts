import { clickhouseClient } from "../../lib/clickhouse-client";

export type CostTrackingCall = {
  model: string;
  cost: number;
  metadata: Record<string, unknown>;
  tokens?: { input: number; output: number };
};

// The scrape row is published when the job finishes and lands in ClickHouse a
// few seconds later; poll for it.
export async function getCostTrackingCalls(
  scrapeId: string,
): Promise<CostTrackingCall[]> {
  if (clickhouseClient === null) {
    throw new Error("CLICKHOUSE_ANALYTICS_URL is required to read the job log");
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await clickhouseClient.query({
      query:
        "SELECT cost_tracking FROM scrapes FINAL WHERE id = {id: UUID} AND created_at >= now() - INTERVAL 1 DAY",
      query_params: { id: scrapeId },
      format: "JSONEachRow",
    });
    const rows = await result.json<{ cost_tracking: string | null }>();
    if (rows.length === 1) {
      const costTracking = rows[0].cost_tracking
        ? (JSON.parse(rows[0].cost_tracking) as { calls?: CostTrackingCall[] })
        : null;
      return costTracking?.calls ?? [];
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`No scrapes row for ${scrapeId}`);
}
