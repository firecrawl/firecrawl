import type { Bigtable, Table } from "@google-cloud/bigtable";
import { config } from "../config";
import { setSpanAttributes, withSpan } from "./otel-tracer";

let clientPromise: Promise<Bigtable> | null = null;
const tables = new Map<string, Table>();

export async function getBigtableTable(tableId: string): Promise<Table> {
  // Every Bigtable read and write resolves its table first, and all but the
  // first call per table find it here. Only that first call gets a span.
  const cached = tables.get(tableId);
  if (cached) {
    return cached;
  }

  return withSpan("bigtable.table.resolve", async span => {
    setSpanAttributes(span, {
      "db.system": "bigtable",
      "bigtable.table": tableId,
      "bigtable.client.cached": clientPromise !== null,
    });
    if (!config.BIGTABLE_INSTANCE_ID) {
      throw new Error("BIGTABLE_INSTANCE_ID is not configured");
    }

    clientPromise ??= import("@google-cloud/bigtable").then(
      ({ Bigtable }) =>
        new Bigtable({
          projectId: config.BIGTABLE_PROJECT_ID,
          ...(config.BIGTABLE_APP_PROFILE_ID
            ? { appProfileId: config.BIGTABLE_APP_PROFILE_ID }
            : {}),
          ...(config.BIGTABLE_CREDENTIALS
            ? {
                credentials: JSON.parse(atob(config.BIGTABLE_CREDENTIALS)),
              }
            : {}),
          metricsEnabled: false,
        }),
    );
    const client = await clientPromise;

    let table = tables.get(tableId);
    if (!table) {
      table = client.instance(config.BIGTABLE_INSTANCE_ID).table(tableId);
      tables.set(tableId, table);
    }
    return table;
  });
}
