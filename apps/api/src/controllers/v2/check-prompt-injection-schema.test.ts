import { describe, expect, it } from "vitest";
import {
  crawlRequestSchema,
  fromV1ScrapeOptions,
  scrapeOptions,
  scrapeRequestSchema,
} from "./types";
import { scrapeOptions as v1ScrapeOptions } from "../v1/types";

const url = "https://example.com";
const jsonFormat = {
  type: "json" as const,
  schema: { type: "object", properties: { title: { type: "string" } } },
};

describe("checkPromptInjection", () => {
  it("accepts the top-level flag with any format", () => {
    const parsed = scrapeRequestSchema.parse({
      url,
      checkPromptInjection: true,
      formats: ["markdown"],
    });

    expect(parsed.checkPromptInjection).toBe(true);
  });

  it("lifts the json-format flag to the top level and drops it from the format", () => {
    const parsed = scrapeRequestSchema.parse({
      url,
      formats: [{ ...jsonFormat, checkPromptInjection: true }],
    });

    expect(parsed.checkPromptInjection).toBe(true);
    expect(parsed.formats[0]).not.toHaveProperty("checkPromptInjection");
  });

  it("enables the check when either level sets it", () => {
    const parsed = scrapeRequestSchema.parse({
      url,
      checkPromptInjection: true,
      formats: [{ ...jsonFormat, checkPromptInjection: false }],
    });

    expect(parsed.checkPromptInjection).toBe(true);
  });

  it("defaults to false", () => {
    expect(scrapeRequestSchema.parse({ url }).checkPromptInjection).toBe(false);
  });

  it("still validates the json-format flag", () => {
    expect(
      scrapeRequestSchema.safeParse({
        url,
        formats: [{ ...jsonFormat, checkPromptInjection: "yes" }],
      }).success,
    ).toBe(false);
  });

  it("is stable when parsed options are parsed again", () => {
    const once = scrapeOptions.parse({
      formats: [{ ...jsonFormat, checkPromptInjection: true }],
    });

    expect(scrapeOptions.parse(once)).toEqual(once);
  });

  it("lifts the json-format flag inside crawl scrapeOptions", () => {
    const parsed = crawlRequestSchema.parse({
      url,
      scrapeOptions: {
        formats: [{ ...jsonFormat, checkPromptInjection: true }],
      },
    });

    expect(parsed.scrapeOptions.checkPromptInjection).toBe(true);
  });

  it("rejects the rawBase64 format, which has no markdown to scan", () => {
    expect(
      scrapeRequestSchema.safeParse({
        url,
        checkPromptInjection: true,
        formats: ["rawBase64"],
      }).success,
    ).toBe(false);
  });

  it("maps v1 jsonOptions.checkPromptInjection to the top-level flag", () => {
    const v1 = v1ScrapeOptions.parse({
      formats: ["json"],
      jsonOptions: { schema: jsonFormat.schema, checkPromptInjection: true },
    });

    const { scrapeOptions: converted } = fromV1ScrapeOptions(
      v1,
      undefined,
      "team-id",
    );

    expect(converted.checkPromptInjection).toBe(true);
    expect(converted.formats.find(f => f.type === "json")).not.toHaveProperty(
      "checkPromptInjection",
    );
  });
});
