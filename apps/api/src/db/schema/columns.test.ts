import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { index as indexTable } from "./index-db";
import { monitor_pages } from "./public";

describe("bytea", () => {
  it.each([
    ["index.url_hash", getTableColumns(indexTable).url_hash],
    ["monitor_pages.url_hash", getTableColumns(monitor_pages).url_hash],
  ])("preserves Buffer values for %s", (_name, column) => {
    const value = Buffer.from("firecrawl");

    expect(column.getSQLType()).toBe("bytea");
    expect(column.mapFromDriverValue(value)).toBe(value);
    expect(column.mapToDriverValue(value)).toBe(value);
  });
});
