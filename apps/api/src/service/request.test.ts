import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  batchScrapeRequestSchema,
  batchScrapeRequestSchemaNoURLValidation,
  buildV2RequestSchemas,
  crawlRequestSchema,
  mapRequestSchema,
  parseRequestSchema,
  scrapeOptions,
  scrapeRequestSchema,
  searchRequestSchema,
} from "../controllers/v2/types";
import { jsonRecordSchema } from "../lib/json-types";
import type { JsonObject } from "../lib/json-types";
import {
  buildRequestSchemaRegistry,
  buildRequestSchemas,
  hasFormatOfType,
  requestFieldBuckets,
  requestKinds,
} from "./request";
import type {
  RequestBodies,
  RequestContributions,
  RequestSchemaBuilder,
  RequestSchemas,
  ResolvedRequestContributions,
  ScrapeOptions,
  ScrapeOptionsRule,
} from "./request";

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

const stubSchemas = (): RequestSchemas => ({
  scrape: z.custom<RequestBodies["scrape"]>(() => true),
  parse: z.custom<RequestBodies["parse"]>(() => true),
  crawl: z.custom<RequestBodies["crawl"]>(() => true),
  batchScrape: z.custom<RequestBodies["batchScrape"]>(() => true),
  batchScrapeNoURLValidation: z.custom<RequestBodies["batchScrape"]>(
    () => true,
  ),
  map: z.custom<RequestBodies["map"]>(() => true),
  search: z.custom<RequestBodies["search"]>(() => true),
  scrapeOptions: z.custom<ScrapeOptions>(() => true),
});

const asRequest = (value: TestRequestContributions): RequestContributions =>
  value;

const testRule1: ScrapeOptionsRule = () => undefined;
const testRule2: ScrapeOptionsRule = () => ({ set: { waitFor: 1000 } });
const testRule3: ScrapeOptionsRule = () => undefined;

function expectObject(value: unknown): JsonObject {
  const parsed = jsonRecordSchema.safeParse(value);
  expect(parsed.success).toBe(true);
  if (!parsed.success) {
    throw new Error("Expected parsed value to be an object");
  }
  return parsed.data;
}

describe("request-schemas", () => {
  it("exports frozen requestKinds and requestFieldBuckets", () => {
    expect(Object.isFrozen(requestKinds)).toBe(true);
    expect(Object.isFrozen(requestFieldBuckets)).toBe(true);
    expect(requestKinds).toEqual([
      "scrape",
      "parse",
      "crawl",
      "batchScrape",
      "map",
      "search",
    ]);
    expect(requestFieldBuckets).toEqual([
      "scrapeOptions",
      "scrape",
      "parse",
      "crawl",
      "batchScrape",
      "map",
      "search",
    ]);
  });

  it("finds a matching format with hasFormatOfType", () => {
    const formats = [
      { type: "markdown" as const },
      { type: "screenshot" as const, fullPage: true },
    ];
    expect(hasFormatOfType(formats, "screenshot")).toEqual({
      type: "screenshot",
      fullPage: true,
    });
    expect(hasFormatOfType(formats, "html")).toBeUndefined();
    expect(hasFormatOfType(undefined, "markdown")).toBeUndefined();
  });

  describe("buildRequestSchemaRegistry", () => {
    it("defers schema building until first access and caches across all kinds", () => {
      const built = stubSchemas();
      const builder = vi.fn<RequestSchemaBuilder>(() => built);

      const { schemas, describedRequest } = buildRequestSchemaRegistry(
        [{ owner: "core" }],
        builder,
      );

      expect(Object.isFrozen(schemas)).toBe(true);
      expect(describedRequest).toEqual({
        scrapeOptions: {},
        scrape: {},
        parse: {},
        crawl: {},
        batchScrape: {},
        map: {},
        search: {},
        formats: {},
        rules: [],
      });
      expect(builder).not.toHaveBeenCalled();

      expect(schemas.scrape).toBe(built.scrape);
      expect(schemas.parse).toBe(built.parse);
      expect(schemas.crawl).toBe(built.crawl);
      expect(schemas.batchScrape).toBe(built.batchScrape);
      expect(schemas.batchScrapeNoURLValidation).toBe(
        built.batchScrapeNoURLValidation,
      );
      expect(schemas.map).toBe(built.map);
      expect(schemas.search).toBe(built.search);
      expect(schemas.scrapeOptions).toBe(built.scrapeOptions);
      expect(builder).toHaveBeenCalledTimes(1);
    });

    it("merges distinct fields, formats, and rules in extension order", () => {
      const auditSchema = z.record(z.string(), z.string()).optional();
      const extraTagSchema = z.string().optional();
      const customFormatA = z.strictObject({
        type: z.literal("customA"),
        flag: z.boolean().default(false),
      });
      const customFormatB = z.strictObject({
        type: z.literal("customB"),
      });

      let captured: ResolvedRequestContributions | undefined;
      const builder: RequestSchemaBuilder = contributions => {
        captured = contributions;
        return stubSchemas();
      };

      const { schemas, describedRequest } = buildRequestSchemaRegistry(
        [
          {
            owner: "ext-a",
            request: asRequest({
              scrapeOptions: {
                zeta: z.boolean().optional(),
                auditMetadata: auditSchema,
                ignored: undefined,
              },
              scrape: { scrapeOnly: z.string().optional() },
              parse: { parseOnly: z.string().optional() },
              crawl: { crawlOnly: z.number().optional() },
              batchScrape: { batchOnly: z.string().optional() },
              map: { mapOnly: z.boolean().optional() },
              search: { searchOnly: z.string().optional() },
              formats: {
                customB: customFormatB,
                skipped: undefined,
              },
              rules: [testRule1, testRule2],
            }),
          },
          {
            owner: "ext-b",
            request: asRequest({
              scrapeOptions: { alphaTag: extraTagSchema },
              formats: { customA: customFormatA },
              rules: [testRule3],
            }),
          },
        ],
        builder,
      );

      expect(describedRequest).toEqual({
        scrapeOptions: {
          alphaTag: "ext-b",
          auditMetadata: "ext-a",
          zeta: "ext-a",
        },
        scrape: { scrapeOnly: "ext-a" },
        parse: { parseOnly: "ext-a" },
        crawl: { crawlOnly: "ext-a" },
        batchScrape: { batchOnly: "ext-a" },
        map: { mapOnly: "ext-a" },
        search: { searchOnly: "ext-a" },
        formats: {
          customA: "ext-b",
          customB: "ext-a",
        },
        rules: ["ext-a", "ext-a", "ext-b"],
      });

      expect(Object.keys(describedRequest.scrapeOptions)).toEqual([
        "alphaTag",
        "auditMetadata",
        "zeta",
      ]);
      expect(Object.keys(describedRequest.formats)).toEqual([
        "customA",
        "customB",
      ]);

      void schemas.scrape;
      expect(captured).toBeDefined();
      expect(captured!.scrapeOptions.auditMetadata).toBe(auditSchema);
      expect(captured!.scrapeOptions.alphaTag).toBe(extraTagSchema);
      expect(captured!.formats.customA).toBe(customFormatA);
      expect(captured!.formats.customB).toBe(customFormatB);
      expect(captured!.rules).toEqual([testRule1, testRule2, testRule3]);
      expect(Object.isFrozen(captured)).toBe(true);
      expect(Object.isFrozen(captured!.scrapeOptions)).toBe(true);
      expect(Object.isFrozen(captured!.formats)).toBe(true);
      expect(Object.isFrozen(captured!.rules)).toBe(true);
    });

    it("builds lazy schemas directly through buildRequestSchemas", () => {
      const built = stubSchemas();
      const builder = vi.fn<RequestSchemaBuilder>(() => built);
      const schemas = buildRequestSchemas(
        [asRequest({ scrape: { extraFlag: z.boolean().optional() } })],
        builder,
      );

      expect(Object.isFrozen(schemas)).toBe(true);
      expect(builder).not.toHaveBeenCalled();
      expect(schemas.scrape).toBe(built.scrape);
      expect(schemas.map).toBe(built.map);
      expect(builder).toHaveBeenCalledTimes(1);
    });

    it("rejects duplicate field keys, duplicate format names, and scrapeOptions overlap with scrape or parse", () => {
      expect(() =>
        buildRequestSchemaRegistry([
          {
            owner: "ext-a",
            request: asRequest({
              scrapeOptions: { auditMetadata: z.string().optional() },
            }),
          },
          {
            owner: "ext-b",
            request: asRequest({
              scrapeOptions: { auditMetadata: z.string().optional() },
            }),
          },
        ]),
      ).toThrow(
        'Request "scrapeOptions.auditMetadata" is already registered by "ext-a" and cannot also be registered by "ext-b"',
      );

      expect(() =>
        buildRequestSchemaRegistry([
          {
            owner: "ext-a",
            request: asRequest({
              formats: {
                customA: z.strictObject({ type: z.literal("customA") }),
              },
            }),
          },
          {
            owner: "ext-b",
            request: asRequest({
              formats: {
                customA: z.strictObject({ type: z.literal("customA") }),
              },
            }),
          },
        ]),
      ).toThrow(
        'Request "formats.customA" is already registered by "ext-a" and cannot also be registered by "ext-b"',
      );

      expect(() =>
        buildRequestSchemaRegistry([
          {
            owner: "ext-a",
            request: asRequest({
              scrapeOptions: { sharedKey: z.string().optional() },
            }),
          },
          {
            owner: "ext-b",
            request: asRequest({
              scrape: { sharedKey: z.string().optional() },
            }),
          },
        ]),
      ).toThrow(
        'Request field "sharedKey" is registered in both "scrapeOptions" (by "ext-a") and "scrape" (by "ext-b")',
      );

      expect(() =>
        buildRequestSchemaRegistry([
          {
            owner: "ext-a",
            request: asRequest({
              scrapeOptions: { sharedKey: z.string().optional() },
            }),
          },
          {
            owner: "ext-b",
            request: asRequest({
              parse: { sharedKey: z.string().optional() },
            }),
          },
        ]),
      ).toThrow(
        'Request field "sharedKey" is registered in both "scrapeOptions" (by "ext-a") and "parse" (by "ext-b")',
      );

      expect(() =>
        buildRequestSchemaRegistry([
          {
            owner: "ext-a",
            request: asRequest({
              scrapeOptions: { sharedKey: z.string().optional() },
            }),
          },
          {
            owner: "ext-b",
            request: asRequest({
              batchScrape: { sharedKey: z.string().optional() },
            }),
          },
        ]),
      ).toThrow(
        'Request field "sharedKey" is registered in both "scrapeOptions" (by "ext-a") and "batchScrape" (by "ext-b")',
      );
    });

    it("snapshots contributions at build time so later caller mutations have no effect", () => {
      const scrapeOptionsMap = Object.fromEntries<z.ZodType>([
        ["tag", z.string().optional()],
      ]);
      const formatMap = Object.fromEntries<z.ZodType>([
        ["custom", z.strictObject({ type: z.literal("custom") })],
      ]);
      const ruleList: Array<ScrapeOptionsRule> = [() => undefined];
      const request = {
        scrapeOptions: scrapeOptionsMap,
        formats: formatMap,
        rules: ruleList,
      };

      let captured: ResolvedRequestContributions | undefined;
      const { schemas, describedRequest } = buildRequestSchemaRegistry(
        [{ owner: "mutable", request: asRequest(request) }],
        contributions => {
          captured = contributions;
          return stubSchemas();
        },
      );

      scrapeOptionsMap.injected = z.string();
      formatMap.injected = z.strictObject({ type: z.literal("injected") });
      ruleList.push(() => ({ error: "injected" }));

      expect(describedRequest.scrapeOptions).toEqual({ tag: "mutable" });
      expect(describedRequest.formats).toEqual({ custom: "mutable" });
      expect(describedRequest.rules).toEqual(["mutable"]);

      void schemas.scrape;
      expect(Object.keys(captured!.scrapeOptions)).toEqual(["tag"]);
      expect(Object.keys(captured!.formats)).toEqual(["custom"]);
      expect(captured!.rules).toHaveLength(1);
    });

    it("rejects malformed contributions and invalid builders", () => {
      expect(() =>
        buildRequestSchemaRegistry(
          [],
          // @ts-expect-error: verifying runtime rejection of non-function builder
          "not-a-fn",
        ),
      ).toThrow("Request schema builder must be a function");

      expect(() =>
        buildRequestSchemaRegistry([
          {
            owner: "bad",
            // @ts-expect-error: verifying runtime rejection of null contributions
            request: null,
          },
        ]),
      ).toThrow('Request contributions from "bad" must be a plain object');

      expect(() =>
        buildRequestSchemaRegistry([
          {
            owner: "bad",
            request: [],
          },
        ]),
      ).toThrow('Request contributions from "bad" must be a plain object');

      expect(() =>
        buildRequestSchemaRegistry([
          {
            owner: "bad",
            // @ts-expect-error: verifying runtime rejection of unknown contribution bucket
            request: { unknownBucket: {} },
          },
        ]),
      ).toThrow('Unknown request contribution key "unknownBucket" from "bad"');

      expect(() =>
        buildRequestSchemaRegistry([
          {
            owner: "bad",
            request: { scrapeOptions: "nope" },
          },
        ]),
      ).toThrow(
        'Request "scrapeOptions" contributions from "bad" must be a plain object',
      );

      expect(() =>
        buildRequestSchemaRegistry([
          {
            owner: "bad",
            request: asRequest({ scrapeOptions: { "   ": z.string() } }),
          },
        ]),
      ).toThrow('Invalid request "scrapeOptions" key "   " from "bad"');

      expect(() =>
        buildRequestSchemaRegistry([
          {
            owner: "bad",
            request: asRequest({
              formats: {
                constructor: z.strictObject({ type: z.literal("x") }),
              },
            }),
          },
        ]),
      ).toThrow('Invalid request "formats" key "constructor" from "bad"');

      expect(() =>
        buildRequestSchemaRegistry([
          {
            owner: "bad",
            request: asRequest({
              scrapeOptions: {
                ["__proto__"]: z.string(),
              },
            }),
          },
        ]),
      ).toThrow('Invalid request "scrapeOptions" key "__proto__" from "bad"');

      expect(() =>
        buildRequestSchemaRegistry([
          {
            owner: "bad",
            request: asRequest({
              scrapeOptions: {
                toString: z.string(),
              },
            }),
          },
        ]),
      ).toThrow('Invalid request "scrapeOptions" key "toString" from "bad"');

      expect(() =>
        buildRequestSchemaRegistry([
          {
            owner: "bad",
            request: asRequest({
              scrapeOptions: {
                prototype: z.string(),
              },
            }),
          },
        ]),
      ).toThrow('Invalid request "scrapeOptions" key "prototype" from "bad"');

      expect(() =>
        buildRequestSchemaRegistry([
          {
            owner: "bad",
            request: asRequest({
              scrapeOptions: {
                // @ts-expect-error: verifying runtime rejection of non-Zod field schema
                badField: { safeParse: "not-a-function" },
              },
            }),
          },
        ]),
      ).toThrow(
        'Request schema "scrapeOptions.badField" from "bad" must be a Zod schema',
      );

      expect(() =>
        buildRequestSchemaRegistry([
          {
            owner: "bad",
            // @ts-expect-error: verifying runtime rejection of non-array rules
            request: { rules: "not-an-array" },
          },
        ]),
      ).toThrow('Request "rules" from "bad" must be an array');

      const sparseRules = new Array<ScrapeOptionsRule>(2);
      sparseRules[0] = () => undefined;
      expect(() =>
        buildRequestSchemaRegistry([
          {
            owner: "bad",
            request: asRequest({ rules: sparseRules }),
          },
        ]),
      ).toThrow('Request rule at index 1 from "bad" must be a function');

      const badBuilderNull = buildRequestSchemaRegistry(
        [],
        // @ts-expect-error: verifying runtime rejection of builder returning null
        () => null,
      );
      expect(() => badBuilderNull.schemas.scrape).toThrow(
        "Request schema builder must return a schemas object",
      );

      const badBuilderMissingKind = buildRequestSchemaRegistry(
        [],
        // @ts-expect-error: verifying runtime rejection of builder omitting required schemas
        () => ({
          scrape: z.object({}),
        }),
      );
      expect(() => badBuilderMissingKind.schemas.scrape).toThrow(
        'Request schema builder returned an invalid "parse" schema',
      );
    });
  });

  describe("buildV2RequestSchemas", () => {
    const emptyContributions: ResolvedRequestContributions = {
      scrapeOptions: Object.freeze({}),
      scrape: Object.freeze({}),
      parse: Object.freeze({}),
      crawl: Object.freeze({}),
      batchScrape: Object.freeze({}),
      map: Object.freeze({}),
      search: Object.freeze({}),
      formats: Object.freeze({}),
      rules: Object.freeze([]),
    };

    it("returns the existing v2 request schemas unchanged when there are no contributions", () => {
      const built = buildV2RequestSchemas(emptyContributions);

      expect(built.scrape).toBe(scrapeRequestSchema);
      expect(built.parse).toBe(parseRequestSchema);
      expect(built.crawl).toBe(crawlRequestSchema);
      expect(built.batchScrape).toBe(batchScrapeRequestSchema);
      expect(built.batchScrapeNoURLValidation).toBe(
        batchScrapeRequestSchemaNoURLValidation,
      );
      expect(built.map).toBe(mapRequestSchema);
      expect(built.search).toBe(searchRequestSchema);
      expect(built.scrapeOptions).toBe(scrapeOptions);
    });

    it("composes contributed fields, formats, and rules across all request kinds and scrapeOptions", () => {
      const customFormatSchema = z.strictObject({
        type: z.literal("customMetric"),
        depth: z.number().int().min(1).default(1),
      });

      const observedKinds: Array<string> = [];
      const rules: Array<ScrapeOptionsRule> = [
        (options, { kind }) => {
          observedKinds.push(kind);
          const hasCustom = options.formats.some(
            f => (f as { type: string }).type === "customMetric",
          );
          if (!hasCustom) {
            return;
          }
          if (kind === "parse") {
            return {
              error: "Parse uploads do not support customMetric.",
              path: ["formats"],
            };
          }
          if (!options.formats.some(f => f.type === "markdown")) {
            return {
              error: "customMetric requires markdown.",
            };
          }
          return {
            set: {
              waitFor: Math.max(options.waitFor, 5000),
              timeout: options.timeout === 30_000 ? 60_000 : options.timeout,
            },
          };
        },
        options => {
          if (options.waitFor === 5000) {
            return { set: { onlyMainContent: false } };
          }
        },
      ];

      const { schemas } = buildRequestSchemaRegistry(
        [
          {
            owner: "ext",
            request: asRequest({
              scrapeOptions: {
                customTraceId: z.string().default("default-trace"),
              },
              scrape: {
                scrapeOnlyFlag: z.boolean().optional(),
              },
              parse: {
                parseOnlyTag: z.string().optional(),
              },
              crawl: {
                crawlOnlyTag: z.string().optional(),
              },
              batchScrape: {
                batchOnlyTag: z.string().optional(),
              },
              map: {
                mapOnlyTag: z.string().optional(),
              },
              search: {
                searchOnlyTag: z.string().optional(),
              },
              formats: {
                customMetric: customFormatSchema,
              },
              rules,
            }),
          },
        ],
        buildV2RequestSchemas,
      );

      // Scrape: accepts contributed scrapeOptions + scrape fields + custom format (string shorthand and object) + runs rules in order
      const scrapeOk = schemas.scrape.safeParse({
        url: "https://example.com",
        formats: ["markdown", "customMetric"],
        timeout: 30_000,
        proxy: "basic",
        scrapeOnlyFlag: true,
      });
      expect(scrapeOk.success).toBe(true);
      if (scrapeOk.success) {
        const data = expectObject(scrapeOk.data);
        expect(data.customTraceId).toBe("default-trace");
        expect(data.scrapeOnlyFlag).toBe(true);
        expect(data.formats).toEqual([
          { type: "markdown" },
          { type: "customMetric", depth: 1 },
        ]);
        expect(data.waitFor).toBe(5000);
        expect(data.timeout).toBe(60_000);
        expect(data.onlyMainContent).toBe(false);
      }

      // Scrape: rejects unknown keys and rule errors
      const scrapeUnknown = schemas.scrape.safeParse({
        url: "https://example.com",
        notDeclaredField: true,
      });
      expect(scrapeUnknown.success).toBe(false);

      const scrapeMissingMarkdown = schemas.scrape.safeParse({
        url: "https://example.com",
        formats: [{ type: "customMetric", depth: 2 }],
      });
      expect(scrapeMissingMarkdown.success).toBe(false);
      if (!scrapeMissingMarkdown.success) {
        expect(scrapeMissingMarkdown.error.issues[0]?.message).toBe(
          "customMetric requires markdown.",
        );
      }

      // Parse: accepts parseOnlyTag + customTraceId, preserves file, rejects customMetric via rule
      const uploadFile = {
        buffer: Buffer.from("hello"),
        filename: "doc.html",
      };
      const parseOk = schemas.parse.safeParse({
        file: uploadFile,
        parseOnlyTag: "p1",
        customTraceId: "trace-parse",
      });
      expect(parseOk.success).toBe(true);
      if (parseOk.success) {
        const data = z
          .object({
            parseOnlyTag: z.string(),
            customTraceId: z.string(),
            file: z.unknown(),
          })
          .parse(parseOk.data);
        expect(data.parseOnlyTag).toBe("p1");
        expect(data.customTraceId).toBe("trace-parse");
        expect(data.file).toBe(uploadFile);
      }

      const parseRefused = schemas.parse.safeParse({
        file: uploadFile,
        formats: ["markdown", "customMetric"],
      });
      expect(parseRefused.success).toBe(false);
      if (!parseRefused.success) {
        expect(parseRefused.error.issues[0]?.message).toBe(
          "Parse uploads do not support customMetric.",
        );
        expect(parseRefused.error.issues[0]?.path).toEqual(["formats"]);
      }

      // Crawl: accepts crawlOnlyTag, populates scrapeOptions defaults when omitted, runs rules on scrapeOptions
      const crawlDefault = schemas.crawl.safeParse({
        url: "https://example.com",
        crawlOnlyTag: "c1",
      });
      expect(crawlDefault.success).toBe(true);
      if (crawlDefault.success) {
        const data = expectObject(crawlDefault.data);
        expect(data.crawlOnlyTag).toBe("c1");
        expect(expectObject(data.scrapeOptions).customTraceId).toBe(
          "default-trace",
        );
      }

      const crawlRefused = schemas.crawl.safeParse({
        url: "https://example.com",
        scrapeOptions: {
          formats: [{ type: "customMetric" }],
        },
      });
      expect(crawlRefused.success).toBe(false);
      if (!crawlRefused.success) {
        expect(crawlRefused.error.issues[0]?.message).toBe(
          "customMetric requires markdown.",
        );
        expect(crawlRefused.error.issues[0]?.path).toEqual(["scrapeOptions"]);
      }

      // Map: accepts mapOnlyTag and rejects unknown keys
      const mapOk = schemas.map.safeParse({
        url: "https://example.com",
        mapOnlyTag: "m1",
      });
      expect(mapOk.success).toBe(true);
      if (mapOk.success) {
        expect(expectObject(mapOk.data).mapOnlyTag).toBe("m1");
      }
      expect(
        schemas.map.safeParse({
          url: "https://example.com",
          scrapeOnlyFlag: true,
        }).success,
      ).toBe(false);

      // Search: skips rules when scrapeOptions is omitted, runs rules when provided
      const kindsBeforeSearchNoScrape = observedKinds.length;
      const searchNoScrape = schemas.search.safeParse({
        query: "firecrawl",
        searchOnlyTag: "s1",
      });
      expect(searchNoScrape.success).toBe(true);
      expect(observedKinds.length).toBe(kindsBeforeSearchNoScrape);
      if (searchNoScrape.success) {
        expect(expectObject(searchNoScrape.data).searchOnlyTag).toBe("s1");
      }

      const searchWithScrape = schemas.search.safeParse({
        query: "firecrawl",
        scrapeOptions: {
          formats: ["markdown", "customMetric"],
          timeout: 30_000,
          proxy: "basic",
        },
      });
      expect(searchWithScrape.success).toBe(true);
      if (searchWithScrape.success) {
        const opts = expectObject(searchWithScrape.data.scrapeOptions);
        expect(opts.customTraceId).toBe("default-trace");
        expect(opts.waitFor).toBe(5000);
        expect(opts.timeout).toBe(60_000);
        expect(opts.onlyMainContent).toBe(false);
      }

      expect(observedKinds).toContain("scrape");
      expect(observedKinds).toContain("parse");
      expect(observedKinds).toContain("crawl");
      expect(observedKinds).toContain("search");

      // Batch scrape (strict URL validation and no-URL-validation variant)
      const batchOk = schemas.batchScrape.safeParse({
        urls: ["https://example.com"],
        formats: ["markdown", "customMetric"],
        timeout: 30_000,
        proxy: "basic",
        batchOnlyTag: "b1",
      });
      expect(batchOk.success).toBe(true);
      if (batchOk.success) {
        const data = expectObject(batchOk.data);
        expect(data.batchOnlyTag).toBe("b1");
        expect(data.customTraceId).toBe("default-trace");
        expect(data.waitFor).toBe(5000);
        expect(data.timeout).toBe(60_000);
        expect(data.onlyMainContent).toBe(false);
      }
      expect(
        schemas.batchScrape.safeParse({
          urls: ["not a valid url"],
          formats: ["markdown", "customMetric"],
        }).success,
      ).toBe(false);

      const batchNoUrlOk = schemas.batchScrapeNoURLValidation.safeParse({
        urls: ["https://example.com", "not a valid url"],
        ignoreInvalidURLs: true,
        formats: ["markdown", "customMetric"],
        batchOnlyTag: "b2",
      });
      expect(batchNoUrlOk.success).toBe(true);
      if (batchNoUrlOk.success) {
        const data = expectObject(batchNoUrlOk.data);
        expect(data.urls).toEqual(["https://example.com", "not a valid url"]);
        expect(data.batchOnlyTag).toBe("b2");
        expect(data.customTraceId).toBe("default-trace");
        expect(data.waitFor).toBe(5000);
      }

      const batchRefused = schemas.batchScrape.safeParse({
        urls: ["https://example.com"],
        formats: [{ type: "customMetric" }],
      });
      expect(batchRefused.success).toBe(false);
      if (!batchRefused.success) {
        expect(batchRefused.error.issues[0]?.message).toBe(
          "customMetric requires markdown.",
        );
      }
      expect(observedKinds).toContain("batchScrape");

      // Standalone scrapeOptions: applies contributed fields, formats, rules, and wait-time refine
      const optsOk = schemas.scrapeOptions.safeParse({
        formats: ["markdown", "customMetric"],
        timeout: 30_000,
        proxy: "basic",
      });
      expect(optsOk.success).toBe(true);
      if (optsOk.success) {
        const data = expectObject(optsOk.data);
        expect(data.customTraceId).toBe("default-trace");
        expect(data.waitFor).toBe(5000);
        expect(data.timeout).toBe(60_000);
        expect(data.onlyMainContent).toBe(false);
      }

      const optsWaitExceeded = schemas.scrapeOptions.safeParse({
        waitFor: 30_000,
        actions: [{ type: "wait", milliseconds: 35_000 }],
      });
      expect(optsWaitExceeded.success).toBe(false);
    });

    it("rejects contributions that collide with built-in fields or formats", () => {
      const cases: Array<{
        contribution: TestRequestContributions;
        expected: string;
      }> = [
        {
          contribution: { scrape: { url: z.string() } },
          expected:
            'Request "scrape.url" collides with a built-in field or format',
        },
        {
          contribution: { scrapeOptions: { waitFor: z.string() } },
          expected:
            'Request "scrapeOptions.waitFor" collides with a built-in field or format',
        },
        {
          contribution: { scrapeOptions: { url: z.string() } },
          expected:
            'Request "scrapeOptions.url" collides with a built-in field or format',
        },
        {
          contribution: { scrapeOptions: { file: z.string() } },
          expected:
            'Request "scrapeOptions.file" collides with a built-in field or format',
        },
        {
          contribution: { scrapeOptions: { urls: z.string() } },
          expected:
            'Request "scrapeOptions.urls" collides with a built-in field or format',
        },
        {
          contribution: { parse: { file: z.string() } },
          expected:
            'Request "parse.file" collides with a built-in field or format',
        },
        {
          contribution: { crawl: { scrapeOptions: z.string() } },
          expected:
            'Request "crawl.scrapeOptions" collides with a built-in field or format',
        },
        {
          contribution: { batchScrape: { urls: z.string() } },
          expected:
            'Request "batchScrape.urls" collides with a built-in field or format',
        },
        {
          contribution: { map: { url: z.string() } },
          expected:
            'Request "map.url" collides with a built-in field or format',
        },
        {
          contribution: { search: { query: z.number() } },
          expected:
            'Request "search.query" collides with a built-in field or format',
        },
        {
          contribution: {
            formats: {
              markdown: z.strictObject({ type: z.literal("markdown") }),
            },
          },
          expected:
            'Request "formats.markdown" collides with a built-in field or format',
        },
      ];

      for (const { contribution, expected } of cases) {
        const { schemas } = buildRequestSchemaRegistry(
          [{ owner: "ext", request: asRequest(contribution) }],
          buildV2RequestSchemas,
        );
        expect(() => schemas.scrape).toThrow(expected);
      }
    });

    it("allows extensions to widen extensible core fields (parsers, proxy, sources, categories)", () => {
      const { schemas } = buildRequestSchemaRegistry(
        [
          {
            owner: "ext",
            request: asRequest({
              scrapeOptions: {
                proxy: z
                  .enum(["basic", "stealth", "enhanced", "auto"])
                  .prefault("auto"),
                parsers: z
                  .array(
                    z.union([
                      z.literal("pdf"),
                      z.strictObject({
                        type: z.literal("pdf"),
                        mode: z.enum(["fast", "auto", "ocr"]).optional(),
                      }),
                      z.literal("image"),
                    ]),
                  )
                  .prefault(["pdf", "image"]),
              },
              search: {
                sources: z
                  .union([
                    z.array(z.enum(["web", "images", "news", "custom"])),
                    z.array(z.strictObject({ type: z.literal("custom") })),
                  ])
                  .prefault(["web"]),
                categories: z
                  .union([
                    z.array(z.enum(["pdf", "custom"])),
                    z.array(z.strictObject({ type: z.literal("custom") })),
                  ])
                  .optional(),
              },
            }),
          },
        ],
        buildV2RequestSchemas,
      );

      const scraped = expectObject(
        schemas.scrape.parse({
          url: "https://example.com",
          proxy: "stealth",
          parsers: [{ type: "pdf", mode: "ocr" }, "image"],
        }),
      );
      expect(scraped.proxy).toBe("stealth");
      expect(scraped.parsers).toEqual([{ type: "pdf", mode: "ocr" }, "image"]);

      const searched = expectObject(
        schemas.search.parse({
          query: "hello",
          sources: ["custom"],
          categories: ["custom"],
        }),
      );
      expect(searched.sources).toEqual([{ type: "custom" }]);
      expect(searched.categories).toEqual([{ type: "custom" }]);
    });
  });
});
