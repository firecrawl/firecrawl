import { describe, expect, it } from "vitest";
import {
  LOCKDOWN_DEFAULT_MAX_AGE_MS,
  MAX_SCRAPE_MAX_AGE_MS,
  batchScrapeRequestSchema,
  batchScrapeRequestSchemaNoURLValidation,
  crawlRequestSchema,
  extractRequestSchema,
  fromV1ScrapeOptions,
  parseRequestSchema,
  scrapeOptions,
  scrapeRequestSchema,
  searchRequestSchema,
} from "./types";
import { scrapeOptions as v1ScrapeOptions } from "../v1/types";

const url = "https://example.com";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

describe("v2 maxAge soft cap", () => {
  it("defines the cap as 7 days in milliseconds", () => {
    expect(MAX_SCRAPE_MAX_AGE_MS).toBe(SEVEN_DAYS_MS);
  });

  it("caps maxAge values above 7 days on scrapeRequestSchema", () => {
    expect(
      scrapeRequestSchema.parse({ url, maxAge: SEVEN_DAYS_MS + 1 }).maxAge,
    ).toBe(SEVEN_DAYS_MS);
    expect(scrapeRequestSchema.parse({ url, maxAge: ONE_YEAR_MS }).maxAge).toBe(
      SEVEN_DAYS_MS,
    );
    expect(
      scrapeRequestSchema.parse({
        url,
        lockdown: false,
        maxAge: ONE_YEAR_MS,
      }).maxAge,
    ).toBe(SEVEN_DAYS_MS);
  });

  it("preserves maxAge at or below 7 days and leaves omitted maxAge undefined", () => {
    expect(scrapeRequestSchema.parse({ url }).maxAge).toBeUndefined();
    expect(scrapeRequestSchema.parse({ url, maxAge: 0 }).maxAge).toBe(0);
    expect(scrapeRequestSchema.parse({ url, maxAge: 60_000 }).maxAge).toBe(
      60_000,
    );
    expect(
      scrapeRequestSchema.parse({ url, maxAge: SEVEN_DAYS_MS }).maxAge,
    ).toBe(SEVEN_DAYS_MS);
  });

  it("still rejects negative and non-integer maxAge", () => {
    expect(scrapeRequestSchema.safeParse({ url, maxAge: -1 }).success).toBe(
      false,
    );
    expect(scrapeRequestSchema.safeParse({ url, maxAge: 1.5 }).success).toBe(
      false,
    );
  });

  it("exempts lockdown scrapes from the 7-day cap", () => {
    expect(scrapeRequestSchema.parse({ url, lockdown: true }).maxAge).toBe(
      LOCKDOWN_DEFAULT_MAX_AGE_MS,
    );
    expect(
      scrapeRequestSchema.parse({
        url,
        lockdown: true,
        maxAge: THIRTY_DAYS_MS,
      }).maxAge,
    ).toBe(THIRTY_DAYS_MS);
    expect(
      scrapeRequestSchema.parse({
        url,
        lockdown: true,
        maxAge: ONE_YEAR_MS,
      }).maxAge,
    ).toBe(ONE_YEAR_MS);
    expect(
      scrapeRequestSchema.parse({
        url,
        lockdown: true,
        maxAge: 60_000,
      }).maxAge,
    ).toBe(60_000);
  });

  it("is idempotent when parsed options are parsed again", () => {
    const capped = scrapeOptions.parse({ maxAge: ONE_YEAR_MS });
    expect(capped.maxAge).toBe(SEVEN_DAYS_MS);
    expect(scrapeOptions.parse(capped)).toEqual(capped);

    const lockdown = scrapeOptions.parse({
      lockdown: true,
      maxAge: ONE_YEAR_MS,
    });
    expect(lockdown.maxAge).toBe(ONE_YEAR_MS);
    expect(scrapeOptions.parse(lockdown)).toEqual(lockdown);
  });

  it("applies the cap and lockdown exemption across all v2 schemas with scrape options", () => {
    expect(
      batchScrapeRequestSchema.parse({ urls: [url], maxAge: ONE_YEAR_MS })
        .maxAge,
    ).toBe(SEVEN_DAYS_MS);
    expect(
      batchScrapeRequestSchema.parse({
        urls: [url],
        lockdown: true,
        maxAge: ONE_YEAR_MS,
      }).maxAge,
    ).toBe(ONE_YEAR_MS);

    expect(
      batchScrapeRequestSchemaNoURLValidation.parse({
        urls: [url],
        maxAge: ONE_YEAR_MS,
      }).maxAge,
    ).toBe(SEVEN_DAYS_MS);

    expect(
      crawlRequestSchema.parse({
        url,
        scrapeOptions: { maxAge: ONE_YEAR_MS },
      }).scrapeOptions.maxAge,
    ).toBe(SEVEN_DAYS_MS);
    expect(
      crawlRequestSchema.parse({
        url,
        scrapeOptions: { lockdown: true, maxAge: ONE_YEAR_MS },
      }).scrapeOptions.maxAge,
    ).toBe(ONE_YEAR_MS);

    expect(
      searchRequestSchema.parse({
        query: "firecrawl",
        scrapeOptions: { maxAge: ONE_YEAR_MS },
      }).scrapeOptions?.maxAge,
    ).toBe(SEVEN_DAYS_MS);
    expect(
      searchRequestSchema.parse({
        query: "firecrawl",
        scrapeOptions: { lockdown: true, maxAge: ONE_YEAR_MS },
      }).scrapeOptions?.maxAge,
    ).toBe(ONE_YEAR_MS);

    expect(
      extractRequestSchema.parse({
        urls: [url],
        scrapeOptions: { maxAge: ONE_YEAR_MS },
      }).scrapeOptions?.maxAge,
    ).toBe(SEVEN_DAYS_MS);
    expect(
      extractRequestSchema.parse({
        urls: [url],
        scrapeOptions: { lockdown: true, maxAge: ONE_YEAR_MS },
      }).scrapeOptions?.maxAge,
    ).toBe(ONE_YEAR_MS);

    const file = { buffer: Buffer.from("hello"), filename: "test.html" };
    expect(parseRequestSchema.parse({ file, maxAge: ONE_YEAR_MS }).maxAge).toBe(
      SEVEN_DAYS_MS,
    );
    expect(
      parseRequestSchema.parse({
        file,
        lockdown: true,
        maxAge: ONE_YEAR_MS,
      }).maxAge,
    ).toBe(ONE_YEAR_MS);
  });

  it("applies the cap when converting v1 scrape options", () => {
    const v1 = v1ScrapeOptions.parse({
      formats: ["markdown"],
      maxAge: ONE_YEAR_MS,
    });
    const { scrapeOptions: converted } = fromV1ScrapeOptions(
      v1,
      undefined,
      "team-id",
    );

    expect(converted.maxAge).toBe(SEVEN_DAYS_MS);
  });
});
