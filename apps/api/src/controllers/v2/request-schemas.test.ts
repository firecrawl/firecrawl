import { describe, expect, it } from "vitest";
import { ZodError, z } from "zod";
import { jsonObjectSchema } from "../../lib/json-types";
import { coreParts, createService, defaultModules } from "../../service";
import type {
  Extension,
  RequestContributions,
  ScrapeOptionsRule,
} from "../../service";
import { withService } from "../../service/testing";
import type { UploadedParseFile } from "./types";
import {
  batchScrapeRequestSchema,
  batchScrapeRequestSchemaNoURLValidation,
  crawlRequestSchema,
  getV2RequestSchemas,
  mapRequestSchema,
  parseBatchScrapeRequest,
  parseRequestSchema,
  scrapeOptions,
  scrapeRequestSchema,
  searchRequestSchema,
} from "./types";

type TestZodMap = Record<string, z.ZodType | undefined>;

interface TestRequestContributions {
  readonly scrapeOptions?: TestZodMap;
  readonly scrape?: TestZodMap;
  readonly parse?: TestZodMap;
  readonly crawl?: TestZodMap;
  readonly batchScrape?: TestZodMap;
  readonly map?: TestZodMap;
  readonly search?: TestZodMap;
  readonly formats?: TestZodMap;
  readonly rules?: ReadonlyArray<ScrapeOptionsRule>;
}

const asRequest = (value: TestRequestContributions): RequestContributions =>
  value;

const customExtractRule: ScrapeOptionsRule = (options, { kind }) => {
  const hasCustom = options.formats.some(format => {
    const formatType: string = format.type;
    return formatType === "customExtract";
  });
  if (!hasCustom) {
    return;
  }
  if (kind === "parse") {
    return {
      error: "Parse uploads do not support customExtract.",
      path: ["formats"],
    };
  }
  if (!options.formats.some(format => format.type === "markdown")) {
    return {
      error: "customExtract requires markdown.",
      path: ["formats"],
    };
  }
  return {
    set: {
      waitFor: Math.max(options.waitFor, 4000),
    },
  };
};

const uploadedFileCheckSchema = z.object({
  buffer: z.custom<Buffer>(value => Buffer.isBuffer(value)),
  filename: z.string(),
  kind: z.string().optional(),
});

const nestedScrapeOptionsSchema = z.object({
  formats: z.array(jsonObjectSchema).optional(),
  customLabel: z.string().optional(),
  waitFor: z.number().optional(),
});

const parsedExtensionOutputSchema = z.object({
  formats: z.array(jsonObjectSchema).optional(),
  customLabel: z.string().optional(),
  scrapeTag: z.string().optional(),
  parseTag: z.string().optional(),
  crawlTag: z.string().optional(),
  batchTag: z.string().optional(),
  mapTag: z.string().optional(),
  searchTag: z.string().optional(),
  waitFor: z.number().optional(),
  urls: z.array(z.string()).optional(),
  file: z
    .custom<UploadedParseFile>(
      value => uploadedFileCheckSchema.safeParse(value).success,
    )
    .optional(),
  scrapeOptions: nestedScrapeOptionsSchema.optional(),
});

function captureZodError(fn: () => void): ZodError {
  try {
    fn();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ZodError);
    if (error instanceof ZodError) {
      return error;
    }
  }
  throw new Error("Expected ZodError to be thrown");
}

describe("v2 request schema wiring", () => {
  it("falls back to static v2 schemas when no service is installed", () => {
    const schemas = getV2RequestSchemas();

    expect(schemas.scrape).toBe(scrapeRequestSchema);
    expect(schemas.parse).toBe(parseRequestSchema);
    expect(schemas.crawl).toBe(crawlRequestSchema);
    expect(schemas.batchScrape).toBe(batchScrapeRequestSchema);
    expect(schemas.batchScrapeNoURLValidation).toBe(
      batchScrapeRequestSchemaNoURLValidation,
    );
    expect(schemas.map).toBe(mapRequestSchema);
    expect(schemas.search).toBe(searchRequestSchema);
    expect(schemas.scrapeOptions).toBe(scrapeOptions);

    expect(
      parseBatchScrapeRequest({ urls: ["https://example.com"] }).urls,
    ).toEqual(["https://example.com"]);
    expect(
      parseBatchScrapeRequest({
        urls: ["https://example.com", "not a url"],
        ignoreInvalidURLs: true,
      }).urls,
    ).toEqual(["https://example.com", "not a url"]);
    expect(() =>
      parseBatchScrapeRequest({
        urls: ["not a url"],
        ignoreInvalidURLs: false,
      }),
    ).toThrow(ZodError);
  });

  it("matches static schemas identically for a default service with no extensions", async () => {
    const defaultService = createService(
      { modules: defaultModules() },
      coreParts(),
    );

    await withService(defaultService, async () => {
      const schemas = getV2RequestSchemas();
      expect(schemas).toBe(defaultService.schemas);
      expect(schemas.scrape).toBe(scrapeRequestSchema);
      expect(schemas.parse).toBe(parseRequestSchema);
      expect(schemas.crawl).toBe(crawlRequestSchema);
      expect(schemas.batchScrape).toBe(batchScrapeRequestSchema);
      expect(schemas.batchScrapeNoURLValidation).toBe(
        batchScrapeRequestSchemaNoURLValidation,
      );
      expect(schemas.map).toBe(mapRequestSchema);
      expect(schemas.search).toBe(searchRequestSchema);
      expect(schemas.scrapeOptions).toBe(scrapeOptions);

      expect(schemas.scrape.parse({ url: "example.com" })).toEqual(
        scrapeRequestSchema.parse({ url: "example.com" }),
      );
      expect(schemas.crawl.parse({ url: "https://example.com" })).toEqual(
        crawlRequestSchema.parse({ url: "https://example.com" }),
      );
      expect(schemas.map.parse({ url: "https://example.com" })).toEqual(
        mapRequestSchema.parse({ url: "https://example.com" }),
      );
      expect(schemas.search.parse({ query: "firecrawl" })).toEqual(
        searchRequestSchema.parse({ query: "firecrawl" }),
      );
      expect(parseBatchScrapeRequest({ urls: ["example.com"] })).toEqual(
        batchScrapeRequestSchema.parse({ urls: ["example.com"] }),
      );
      expect(schemas.scrapeOptions.parse({})).toEqual(scrapeOptions.parse({}));

      const staticErr = captureZodError(() =>
        scrapeRequestSchema.parse({
          url: "https://example.com",
          unknownOption: true,
        }),
      );
      const serviceErr = captureZodError(() =>
        schemas.scrape.parse({
          url: "https://example.com",
          unknownOption: true,
        }),
      );
      expect(serviceErr.issues).toEqual(staticErr.issues);
      expect(serviceErr.issues[0]?.code).toBe("unrecognized_keys");
    });

    const minimalService = createService(
      { modules: {} },
      { core: { name: "core" }, logger: { error: () => {} } },
    );

    await withService(minimalService, async () => {
      const schemas = getV2RequestSchemas();
      expect(schemas).toBe(minimalService.schemas);
      expect(schemas.search).toBe(searchRequestSchema);
      expect(schemas.batchScrape).toBe(batchScrapeRequestSchema);
    });
  });

  it("validates extension formats, fields, and rules end to end through service.schemas and v2 helpers", async () => {
    const customFormatSchema = z.strictObject({
      type: z.literal("customExtract"),
      maxDepth: z.number().int().min(1).max(5).default(2),
    });

    const extension: Extension = {
      name: "custom-v2-request-extension",
      request: asRequest({
        scrapeOptions: {
          customLabel: z.string().min(2).optional(),
        },
        scrape: {
          scrapeTag: z.string().min(1).optional(),
        },
        parse: {
          parseTag: z.string().min(1).optional(),
        },
        crawl: {
          crawlTag: z.string().min(1).optional(),
        },
        batchScrape: {
          batchTag: z.string().min(1).optional(),
        },
        map: {
          mapTag: z.string().min(1).optional(),
        },
        search: {
          searchTag: z.string().min(1).optional(),
        },
        formats: {
          customExtract: customFormatSchema,
        },
        rules: [customExtractRule],
      }),
    };

    const customService = createService(
      { modules: defaultModules(), extensions: [extension] },
      coreParts(),
    );

    const uploadFile = {
      buffer: Buffer.from("<p>hello</p>"),
      filename: "sample.html",
      kind: "html" as const,
    };

    await withService(customService, async () => {
      const schemas = getV2RequestSchemas();

      // Scrape: custom format (string shorthand), custom scrapeOptions + scrape fields, rule default
      const parsedScrape = parsedExtensionOutputSchema.parse(
        schemas.scrape.parse({
          url: "https://example.com",
          formats: ["markdown", "customExtract"],
          customLabel: "alpha",
          scrapeTag: "s-1",
        }),
      );
      expect(parsedScrape.formats).toEqual([
        { type: "markdown" },
        { type: "customExtract", maxDepth: 2 },
      ]);
      expect(parsedScrape.customLabel).toBe("alpha");
      expect(parsedScrape.scrapeTag).toBe("s-1");
      expect(parsedScrape.waitFor).toBe(4000);

      // Parse: accepts custom fields, rejects customExtract via rule
      const parsedUpload = parsedExtensionOutputSchema.parse(
        schemas.parse.parse({
          file: uploadFile,
          customLabel: "parse-ok",
          parseTag: "p-1",
        }),
      );
      expect(parsedUpload.customLabel).toBe("parse-ok");
      expect(parsedUpload.parseTag).toBe("p-1");
      expect(parsedUpload.file).toBe(uploadFile);

      const parseRuleErr = captureZodError(() =>
        schemas.parse.parse({
          file: uploadFile,
          formats: ["markdown", "customExtract"],
        }),
      );
      expect(parseRuleErr.issues[0]).toMatchObject({
        code: "custom",
        message: "Parse uploads do not support customExtract.",
        path: ["formats"],
      });

      // Crawl: validates custom crawl field, nested custom scrapeOptions field, format, and rule
      const parsedCrawl = parsedExtensionOutputSchema.parse(
        schemas.crawl.parse({
          url: "https://example.com",
          crawlTag: "c-1",
          scrapeOptions: {
            formats: ["markdown", { type: "customExtract", maxDepth: 4 }],
            customLabel: "crawl-ok",
          },
        }),
      );
      const crawlScrapeOptions = nestedScrapeOptionsSchema.parse(
        parsedCrawl.scrapeOptions,
      );
      expect(parsedCrawl.crawlTag).toBe("c-1");
      expect(crawlScrapeOptions.customLabel).toBe("crawl-ok");
      expect(crawlScrapeOptions.waitFor).toBe(4000);
      expect(crawlScrapeOptions.formats).toEqual([
        { type: "markdown" },
        { type: "customExtract", maxDepth: 4 },
      ]);

      const crawlRuleErr = captureZodError(() =>
        schemas.crawl.parse({
          url: "https://example.com",
          scrapeOptions: {
            formats: [{ type: "customExtract" }],
          },
        }),
      );
      expect(crawlRuleErr.issues[0]).toMatchObject({
        code: "custom",
        message: "customExtract requires markdown.",
        path: ["scrapeOptions", "formats"],
      });

      // Batch scrape helper: strict URL mode and ignoreInvalidURLs: true mode
      const parsedBatch = parsedExtensionOutputSchema.parse(
        parseBatchScrapeRequest({
          urls: ["https://example.com"],
          formats: ["markdown", "customExtract"],
          customLabel: "batch-ok",
          batchTag: "b-1",
        }),
      );
      expect(parsedBatch.customLabel).toBe("batch-ok");
      expect(parsedBatch.batchTag).toBe("b-1");
      expect(parsedBatch.waitFor).toBe(4000);

      const parsedBatchLenient = parsedExtensionOutputSchema.parse(
        parseBatchScrapeRequest({
          urls: ["https://example.com", "not a url"],
          ignoreInvalidURLs: true,
          formats: ["markdown", { type: "customExtract", maxDepth: 3 }],
          customLabel: "lenient",
          batchTag: "b-2",
        }),
      );
      expect(parsedBatchLenient.urls).toEqual([
        "https://example.com",
        "not a url",
      ]);
      expect(parsedBatchLenient.batchTag).toBe("b-2");
      expect(parsedBatchLenient.waitFor).toBe(4000);

      expect(() =>
        parseBatchScrapeRequest({
          urls: ["not a url"],
          formats: ["markdown", "customExtract"],
        }),
      ).toThrow(ZodError);

      // Map: accepts custom map field and rejects invalid values
      const parsedMap = parsedExtensionOutputSchema.parse(
        schemas.map.parse({
          url: "https://example.com",
          mapTag: "m-1",
        }),
      );
      expect(parsedMap.mapTag).toBe("m-1");

      // Search: accepts custom search field and nested scrapeOptions with custom format + rule
      const parsedSearch = parsedExtensionOutputSchema.parse(
        schemas.search.parse({
          query: "firecrawl",
          searchTag: "q-1",
          scrapeOptions: {
            formats: ["markdown", "customExtract"],
            customLabel: "search-ok",
          },
        }),
      );
      const searchScrapeOptions = nestedScrapeOptionsSchema.parse(
        parsedSearch.scrapeOptions,
      );
      expect(parsedSearch.searchTag).toBe("q-1");
      expect(searchScrapeOptions.customLabel).toBe("search-ok");
      expect(searchScrapeOptions.waitFor).toBe(4000);

      // Standalone scrapeOptions routes through service.schemas.scrapeOptions
      const parsedOpts = parsedExtensionOutputSchema.parse(
        schemas.scrapeOptions.parse({
          formats: ["markdown", "customExtract"],
          customLabel: "standalone",
        }),
      );
      expect(parsedOpts.customLabel).toBe("standalone");
      expect(parsedOpts.waitFor).toBe(4000);

      // Invalid custom field value, invalid custom format option, and unknown key
      const invalidFieldErr = captureZodError(() =>
        schemas.scrape.parse({
          url: "https://example.com",
          customLabel: "x",
        }),
      );
      expect(invalidFieldErr.issues[0]?.path).toEqual(["customLabel"]);

      const invalidFormatErr = captureZodError(() =>
        schemas.scrape.parse({
          url: "https://example.com",
          formats: ["markdown", { type: "customExtract", maxDepth: 99 }],
        }),
      );
      expect(invalidFormatErr.issues[0]?.path[0]).toBe("formats");

      const unknownKeyErr = captureZodError(() =>
        parseBatchScrapeRequest({
          urls: ["https://example.com"],
          notARegisteredField: true,
        }),
      );
      expect(unknownKeyErr.issues[0]?.code).toBe("unrecognized_keys");
    });

    // After leaving withService, custom fields and formats are no longer accepted
    expect(() =>
      getV2RequestSchemas().scrape.parse({
        url: "https://example.com",
        customLabel: "after-cleanup",
      }),
    ).toThrow(ZodError);
  });
});
